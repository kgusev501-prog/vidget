'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kdbxweb = require('kdbxweb');
const { Vault, useArgon2 } = require('../src/main/vault');

useArgon2();

const PASSWORD = 'мастер-пароль 123';

/** Builds a database with the awkward parts of KeePass in it, on disk. */
async function makeDatabase({ version } = {}) {
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = kdbxweb.Kdbx.create(creds, 'Проверка');
  if (version === 3) db.setVersion(3);

  const root = db.getDefaultGroup();

  const gh = db.createEntry(root);
  gh.fields.set('Title', 'GitHub');
  gh.fields.set('UserName', 'gus');
  gh.fields.set('Password', kdbxweb.ProtectedValue.fromString('гит-пароль'));
  gh.fields.set('URL', 'https://github.com/login');
  gh.fields.set('Notes', 'рабочий аккаунт');
  gh.fields.set('ПИН', kdbxweb.ProtectedValue.fromString('4321'));
  gh.fields.set('Отдел', 'разработка');
  gh.fields.set('otp', 'otpauth://totp/GitHub?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  gh.tags = ['работа'];
  gh.autoType.enabled = true;
  gh.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
  gh.autoType.items.push({ window: '*GitHub*', keystrokeSequence: '{USERNAME}{TAB}{PASSWORD}' });
  gh.binaries.set('ключ.txt', new Uint8Array([1, 2, 3, 4]).buffer);

  const mail = db.createGroup(root, 'Почта');
  const ya = db.createEntry(mail);
  ya.fields.set('Title', 'Яндекс');
  ya.fields.set('UserName', 'kgusev501');
  ya.fields.set('Password', kdbxweb.ProtectedValue.fromString('почтовый'));

  // An entry whose password is borrowed from another one.
  const linked = db.createEntry(mail);
  linked.fields.set('Title', 'Зеркало');
  linked.fields.set('UserName', 'тот же');
  linked.fields.set('Password', `{REF:P@I:${gh.uuid.id}}`);

  // A group KeePass was told to keep out of searches.
  const hidden = db.createGroup(root, 'Архив');
  hidden.enableSearching = false;
  const old = db.createEntry(hidden);
  old.fields.set('Title', 'Старое');
  old.fields.set('Password', kdbxweb.ProtectedValue.fromString('забытое'));

  // And one in the recycle bin, which must stay thrown away.
  const bin = db.createGroup(root, 'Корзина');
  db.meta.recycleBinUuid = bin.uuid;
  const trashed = db.createEntry(bin);
  trashed.fields.set('Title', 'Удалённое');

  const expired = db.createEntry(root);
  expired.fields.set('Title', 'Просроченное');
  expired.times.expires = true;
  expired.times.expiryTime = new Date(Date.now() - 86400000);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vidget-vault-')), 'база.kdbx');
  fs.writeFileSync(file, Buffer.from(await db.save()));
  return { file, ghId: gh.uuid.id };
}

const openVault = async (file, password = PASSWORD, extra = {}) => {
  const vault = new Vault(() => ({ vaultPath: file, vaultLockMinutes: 0, ...extra }));
  const res = await vault.unlock(password);
  return { vault, res };
};

test('база: открывается и находит записи', async () => {
  const { file } = await makeDatabase();
  const { vault, res } = await openVault(file);
  assert.equal(res.ok, true);
  assert.equal(vault.unlocked, true);
  const titles = vault.list().map((e) => e.title).sort();
  assert.deepEqual(titles, ['GitHub', 'Зеркало', 'Просроченное', 'Яндекс']);
});

test('база: удалённое остаётся удалённым, скрытое — скрытым', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const titles = vault.list().map((e) => e.title);
  assert.ok(!titles.includes('Удалённое'), 'корзина не показывается');
  assert.ok(!titles.includes('Старое'), 'группа, исключённая из поиска, не показывается');
});

test('база: неверный пароль отвечает по-человечески', async () => {
  const { file } = await makeDatabase();
  const { vault, res } = await openVault(file, 'не тот');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Неверный пароль или файл-ключ');
  assert.equal(vault.unlocked, false);
});

test('база: отсутствующий файл не роняет виджет', async () => {
  const { vault, res } = await openVault(path.join(os.tmpdir(), 'нет-такого.kdbx'));
  assert.equal(res.ok, false);
  assert.match(res.error, /не найден/i);
});

test('база: старый формат KDBX3 тоже читается', async () => {
  const { file } = await makeDatabase({ version: 3 });
  const { vault, res } = await openVault(file);
  assert.equal(res.ok, true);
  assert.ok(vault.list().length >= 4);
});

// The list is what crosses to the panel, so nothing secret may be in it.
test('база: в списке нет ни одного пароля', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const dump = JSON.stringify(vault.list());
  for (const secret of ['гит-пароль', 'почтовый', '4321', 'забытое']) {
    assert.ok(!dump.includes(secret), `«${secret}» не должен попадать в список`);
  }
});

test('база: своё поле видно по имени, но не по значению', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const gh = vault.list().find((e) => e.title === 'GitHub');
  assert.deepEqual(gh.fieldNames.sort(), ['otp', 'ПИН', 'Отдел'].sort());
  const pin = gh.customFields.find((f) => f.name === 'ПИН');
  assert.equal(pin.protected, true, 'защищённое поле помечено');
});

test('база: секрет выдаётся по одному и только по запросу', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  assert.equal(vault.secret(ghId), 'гит-пароль');
  assert.equal(vault.secret(ghId, 'ПИН'), '4321');
  assert.equal(vault.secret(ghId, 'Такого нет'), null);
  assert.equal(vault.secret('чужой-id'), null);
});

test('база: ссылка на чужое поле разворачивается, а не печатается как есть', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const mirror = vault.list().find((e) => e.title === 'Зеркало');
  assert.equal(vault.secret(mirror.id), 'гит-пароль');
});

test('база: одноразовый код считается для записи', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  const code = vault.totp(ghId);
  assert.match(code.text, /^[0-9]{6}$/);
  assert.ok(code.secondsLeft > 0 && code.secondsLeft <= 30);
  const ya = vault.list().find((e) => e.title === 'Яндекс');
  assert.equal(vault.totp(ya.id), null, 'у записи без секрета кода нет');
});

test('база: вложение достаётся байтами', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  const gh = vault.list().find((e) => e.id === ghId);
  assert.deepEqual(gh.attachments, ['ключ.txt']);
  assert.deepEqual([...vault.attachment(ghId, 'ключ.txt')], [1, 2, 3, 4]);
  assert.equal(vault.attachment(ghId, 'нет.txt'), null);
});

test('база: просроченная запись помечена', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const stale = vault.list().find((e) => e.title === 'Просроченное');
  assert.equal(stale.expires, true);
  assert.equal(stale.expired, true);
  assert.equal(vault.list().find((e) => e.title === 'GitHub').expired, false);
});

test('база: группа записи видна в списке', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const ya = vault.list().find((e) => e.title === 'Яндекс');
  assert.match(ya.group, /Почта$/);
});

// ── what will actually be typed ────────────────────────────────────────────
test('автоввод: последовательность записи с подставленными значениями', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  const plan = vault.plan(ghId, 'GitHub — Google Chrome');
  assert.equal(plan.ok, true);
  assert.equal(plan.sequence, '{USERNAME}{TAB}{PASSWORD}', 'окно совпало со своей настройкой');
  assert.deepEqual(plan.steps, [
    { type: 'text', value: 'gus' },
    { type: 'key', key: 'TAB' },
    { type: 'text', value: 'гит-пароль' },
  ]);
});

test('автоввод: для чужого окна берётся последовательность записи, а не оконная', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  const plan = vault.plan(ghId, 'Блокнот');
  assert.equal(plan.ok, true);
  assert.equal(plan.sequence, '{USERNAME}{TAB}{PASSWORD}{ENTER}');
  assert.equal(plan.steps[plan.steps.length - 1].key, 'ENTER');
});

test('автоввод: без своей последовательности берётся обычная', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const ya = vault.list().find((e) => e.title === 'Яндекс');
  const plan = vault.plan(ya.id, 'Почта');
  assert.deepEqual(plan.steps, [
    { type: 'text', value: 'kgusev501' },
    { type: 'key', key: 'TAB' },
    { type: 'text', value: 'почтовый' },
    { type: 'key', key: 'ENTER' },
  ]);
});

test('автоввод: неизвестной записи ничего не печатается', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  assert.deepEqual(vault.plan('нет-такой', 'Окно'), { ok: false, error: 'Запись не найдена' });
});

test('поиск по базе: находит по названию и по группе', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  assert.equal(vault.find('git')[0].title, 'GitHub');
  // Both entries live in "Почта" and score the same for it, so the test asks
  // what it actually means: the group was found, not which of the two won.
  assert.deepEqual(
    vault.find('почта').map((e) => e.title).sort(),
    ['Зеркало', 'Яндекс']
  );
  assert.equal(vault.find('яндекс')[0].title, 'Яндекс');
  assert.deepEqual(vault.find('такого нет'), []);
});

test('подбор по окну: предлагается только подходящее', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  const hits = vault.forWindow('GitHub — Google Chrome');
  assert.equal(hits[0].entry.title, 'GitHub');
  assert.equal(hits[0].why, 'окно из настроек записи');
  assert.deepEqual(vault.forWindow('Совершенно постороннее окно'), []);
});

// ── the lock ───────────────────────────────────────────────────────────────
test('замок: закрытая база ничего не отдаёт', async () => {
  const { file, ghId } = await makeDatabase();
  const { vault } = await openVault(file);
  assert.equal(vault.secret(ghId), 'гит-пароль');

  vault.lock('в тесте');
  assert.equal(vault.unlocked, false);
  assert.deepEqual(vault.list(), []);
  assert.equal(vault.secret(ghId), null);
  assert.equal(vault.totp(ghId), null);
  assert.deepEqual(vault.plan(ghId, 'GitHub'), { ok: false, error: 'Запись не найдена' });
});

test('замок: сам защёлкивается, когда к базе не обращаются', async () => {
  const { file } = await makeDatabase();
  // A tenth of a second stands in for the ten minutes the widget really waits.
  const vault = new Vault(() => ({ vaultPath: file, vaultLockMinutes: 0.1 / 60 }));
  assert.equal((await vault.unlock(PASSWORD)).ok, true);

  await new Promise((r) => setTimeout(r, 60));
  vault.list(); // обращение отодвигает замок
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(vault.unlocked, true, 'пока с базой работают, она открыта');

  await new Promise((r) => setTimeout(r, 160));
  assert.equal(vault.unlocked, false, 'а без обращений закрывается сама');
});

test('замок: ноль минут значит «не закрывать по времени»', async () => {
  const { file } = await makeDatabase();
  const vault = new Vault(() => ({ vaultPath: file, vaultLockMinutes: 0 }));
  await vault.unlock(PASSWORD);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(vault.unlocked, true);
  vault.lock();
});

test('база: правки в KeePass подхватываются без повторного ввода пароля', async () => {
  const { file } = await makeDatabase();
  const { vault } = await openVault(file);
  assert.equal(vault.list().length, 4);

  // Someone adds an entry in KeePass and saves.
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = await kdbxweb.Kdbx.load(new Uint8Array(fs.readFileSync(file)).buffer, creds);
  const added = db.createEntry(db.getDefaultGroup());
  added.fields.set('Title', 'Новая запись');
  fs.writeFileSync(file, Buffer.from(await db.save()));

  const res = await vault.reload();
  assert.equal(res.ok, true);
  assert.ok(vault.list().some((e) => e.title === 'Новая запись'));
  vault.lock();
});

// ── the rest of what a KeePass entry can hold ──────────────────────────────
test('поля: запись может ссылаться сама на себя', async () => {
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = kdbxweb.Kdbx.create(creds, 'Подстановки');
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', 'почта');
  e.fields.set('UserName', '{TITLE}-admin');
  e.fields.set('узел', 'mail.example.com');
  e.fields.set('URL', 'https://{S:узел}/login');
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString('секрет'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vidget-ref-')), 'p.kdbx');
  fs.writeFileSync(file, Buffer.from(await db.save()));

  const { vault } = await openVault(file);
  const id = vault.list()[0].id;
  assert.equal(vault.secret(id, 'UserName'), 'почта-admin');
  assert.equal(vault.secret(id, 'URL'), 'https://mail.example.com/login');
  vault.lock();
});

test('история: прежний пароль достаётся по номеру', async () => {
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
  const db = kdbxweb.Kdbx.create(creds, 'История');
  const e = db.createEntry(db.getDefaultGroup());
  e.fields.set('Title', 'Банк');
  e.fields.set('UserName', 'ivan');
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString('старый'));
  e.pushHistory();
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString('новый'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vidget-hist-')), 'h.kdbx');
  fs.writeFileSync(file, Buffer.from(await db.save()));

  const { vault } = await openVault(file);
  const id = vault.list()[0].id;
  const past = vault.history(id);
  assert.equal(past.length, 1);
  assert.equal(past[0].hasPassword, true);
  assert.equal(vault.secret(id), 'новый', 'сейчас действует новый');
  assert.equal(vault.pastSecret(id, past[0].index), 'старый', 'а прежний доступен отдельно');
  assert.equal(vault.pastSecret(id, 99), null);
  vault.lock();
});
