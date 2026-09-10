'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { YandexMusic } = require('../src/main/yandex');

/**
 * Время идёт по нашей команде: настоящие задержки лестницы — до трёх минут,
 * ждать их в тесте нельзя, а проверить надо именно их.
 */
function fakeClock(ya) {
  const timers = [];
  ya._real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  global.setTimeout = (fn, ms) => {
    const t = { fn, at: ms, dead: false };
    timers.push(t);
    return t;
  };
  global.clearTimeout = (t) => {
    if (t && typeof t === 'object') t.dead = true;
  };
  return {
    /** Прогоняет ближайший назначенный таймер. */
    async tick() {
      const t = timers.find((x) => !x.dead && !x.done);
      if (!t) return null;
      t.done = true;
      await t.fn();
      return t.at;
    },
    restore() {
      global.setTimeout = ya._real.setTimeout;
      global.clearTimeout = ya._real.clearTimeout;
    },
  };
}

/** Клиент, у которого сеть отвечает так, как скажет сценарий. */
function offline(answers = {}) {
  const ya = new YandexMusic();
  ya.attempts = 0;
  ya._req = async (path) => {
    ya.attempts += 1;
    const answer = answers[path];
    if (typeof answer === 'function') return answer(ya.attempts);
    if (answer) return answer;
    throw new Error('Нет связи');
  };
  return ya;
}

const account = { result: { account: { uid: '7', login: 'кто-то' } } };

test('связь: попытки не кончаются, пока сеть не появится', async () => {
  const ya = offline({
    '/account/status': (n) => {
      if (n < 8) throw new Error('Нет связи');
      return account;
    },
  });
  const clock = fakeClock(ya);
  try {
    ya.startAutoConnect(() => 'токен');
    for (let i = 0; i < 20 && !ya.connected; i++) await clock.tick();
  } finally {
    clock.restore();
  }

  assert.equal(ya.connected, true, 'сеть появилась на восьмой попытке — виджет обязан её дождаться');
  assert.equal(ya.login, 'кто-то');
});

test('связь: лестница задержек доходит до трёх минут и там остаётся', async () => {
  const ya = offline();
  const clock = fakeClock(ya);
  const delays = [];
  try {
    ya.startAutoConnect(() => 'токен');
    for (let i = 0; i < 9; i++) delays.push(await clock.tick());
  } finally {
    clock.restore();
  }

  assert.deepEqual(delays.slice(0, 5), [1000, 6000, 20000, 60000, 180000]);
  assert.deepEqual(delays.slice(5), [180000, 180000, 180000, 180000], 'дальше — раз в три минуты, но без конца');
});

test('связь: отвергнутый токен перестают дёргать', async () => {
  const ya = offline({
    '/account/status': () => {
      const err = new Error('Токен недействителен');
      throw err;
    },
  });
  const clock = fakeClock(ya);
  try {
    ya.startAutoConnect(() => 'протухший');
    for (let i = 0; i < 5; i++) await clock.tick();
  } finally {
    clock.restore();
  }

  assert.equal(ya.tokenRejected, true);
  assert.equal(ya.attempts, 1, 'такой токен не начнёт работать сам собой — ходить незачем');
});

test('связь: кнопка не ждёт лестницу, а пробует прямо сейчас', async () => {
  const ya = offline({ '/account/status': account, '/rotor/station/user:onyourwave/tracks': { result: { sequence: [] } } });
  ya.startAutoConnect(() => 'токен');
  ya.stopAutoConnect(); // лестница ещё не успела сработать — как в первые секунды после загрузки

  assert.equal(ya.connected, false);
  const res = await ya.waveStart();
  assert.equal(ya.connected, true, 'нажатие само подтянуло аккаунт');
  assert.notEqual(res.error, 'Аккаунт не подключён', 'человеку не говорят про неподключённый аккаунт из-за секундной задержки');
});

test('связь: без сохранённого токена кнопка не выдумывает подключение', async () => {
  const ya = offline({ '/account/status': account });
  ya.startAutoConnect(() => null);
  assert.equal(await ya.ensureConnected(), false);
  assert.equal(ya.attempts, 0);
});

test('связь: пробуждение из сна начинает лестницу заново', async () => {
  const ya = offline({
    '/account/status': (n) => {
      if (n < 2) throw new Error('Нет связи');
      return account;
    },
  });
  const clock = fakeClock(ya);
  try {
    ya.startAutoConnect(() => 'токен');
    await clock.tick(); // первая попытка, сети ещё нет
    assert.equal(ya.connected, false);

    ya.retryNow();
    const delay = await clock.tick();
    assert.equal(delay, 1000, 'после пробуждения ждать три минуты незачем');
  } finally {
    clock.restore();
  }

  assert.equal(ya.connected, true);
});
