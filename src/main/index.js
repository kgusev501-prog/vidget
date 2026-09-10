'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
  safeStorage,
  dialog,
  clipboard,
  powerMonitor,
} = require('electron');

// Transparent, always-on-top windows on Windows 11 are composited wrong on some
// GPU drivers: large filled areas paint only partially. Disabling GPU
// compositing for this (tiny, mostly static) window is the reliable cure.
app.disableHardwareAcceleration();

// The embedded YouTube player is started by a click in our own UI, but the
// gesture does not carry into the iframe, so Chromium would refuse to unmute.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Running from source the app is called "vidget" (package name) and the
// installed build "Vidget" (product name). On Windows those land in the same
// folder but produce two different single-instance locks, so both could run at
// once and overwrite each other's store. Pin one identity for both.
app.setName('Vidget');
app.setPath('userData', path.join(app.getPath('appData'), 'Vidget'));

// A packaged Windows build has no console, so anything fatal goes to a file
// next to the app data instead of vanishing.
const CRASH_LOG = path.join(app.getPath('temp'), 'vidget-crash.log');
const note = (what, detail) => {
  try {
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${what} ${detail}
`);
  } catch {
    /* logging must never be the thing that breaks us */
  }
};
process.on('uncaughtException', (err) => note('uncaught', err.stack || err));
process.on('unhandledRejection', (err) => note('rejection', (err && err.stack) || err));

const { Store } = require('./store');
const { MediaBridge } = require('./media');
const { ClipboardWatcher } = require('./clipboard');
const { Notes } = require('./notes');
const { YandexMusic } = require('./yandex');
const yandexLogin = require('./yandex-login');
const { Player } = require('./player');
const { Vault } = require('./vault');
const { generate: generatePassword } = require('../shared/password');
const { AutoType } = require('./autotype');
const { startServer } = require('./server');
const { panelSize: measurePanel, slotX, slotFraction } = require('../shared/panel-size');
const updater = require('./updater');
const youtube = require('./youtube');

// --- geometry ---------------------------------------------------------------
// The window never changes size: resizing a transparent window on Windows
// leaves the newly exposed area unpainted. It always spans the full panel and
// stays click-through, except over the handle or while the shade is open.
const HANDLE_W = 260;
const HANDLE_H = 30;

// One identity for the app everywhere: the taskbar grouping, the autostart
// entry, and the media session the widget publishes when it plays something
// itself — which is how the bridge tells our own player from everyone else's.
const APP_ID = 'com.vidget.overlay';

const DEV = process.argv.includes('--dev');

let win = null;
let tray = null;
let expanded = false;
let collapseTimer = null;

let hoverTimer = null;
let hovering = false;

let media = null;
let clip = null;
let notes = null;
let vault = null;
let autotype = null;
let yandex = null;
let player = null;
let web = null; // loopback origin the panel is served from
let settings = null;
let stores = [];

// --- hover watch ------------------------------------------------------------
// Windows does not reliably forward mouse-move messages into a click-through
// window, so the main process watches the cursor itself while the shade is
// closed and only takes the mouse once the pointer is actually over the handle.
function startHoverWatch() {
  if (hoverTimer) return;
  hoverTimer = setInterval(pollCursor, 110);
}

function stopHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer);
  hoverTimer = null;
  hovering = false;
}

function pollCursor() {
  if (expanded || !win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const r = handleRect();
  const inside = p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  if (inside === hovering) return;
  hovering = inside;
  win.setIgnoreMouseEvents(!inside, { forward: true });
  win.webContents.send('ui:hover', inside);
}

// --- window -----------------------------------------------------------------
// The widget is not nailed to the middle of the main monitor. The strip can be
// dragged along the top edge and across onto another display, and where it was
// left is remembered between runs.
function placement() {
  const saved = (settings && settings.get().placement) || {};
  const x = Number(saved.x);
  return {
    display: saved.display == null ? null : Number(saved.display),
    x: Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0.5,
  };
}

/** The display the widget lives on — the remembered one while it still exists. */
function homeDisplay() {
  const want = placement().display;
  if (want != null) {
    const hit = screen.getAllDisplays().find((d) => d.id === want);
    if (hit) return hit;
  }
  return screen.getPrimaryDisplay();
}

/** Panel size for the display the widget lives on. */
function panelSize() {
  return measurePanel(homeDisplay().workArea);
}

function targetBounds() {
  const area = homeDisplay().workArea;
  const size = measurePanel(area);
  return {
    x: slotX(area, size.width, placement().x),
    y: area.y,
    width: size.width,
    height: size.height,
  };
}

// --- moving the strip -------------------------------------------------------
// The window is deliberately not `movable`: Windows would let the user drag it
// anywhere, including off the top edge where the shade could not open. Instead
// the handle drag is turned into a slide along the top edge of whichever
// monitor the strip is over.
let moveGrab = null;

function beginMove(screenX) {
  if (!win || win.isDestroyed()) return;
  moveGrab = screenX - win.getBounds().x;
}

function moveTo(screenX) {
  if (moveGrab == null || !win || win.isDestroyed()) return;
  const wanted = screenX - moveGrab;
  const b = win.getBounds();

  // Whichever monitor the middle of the strip is over is the one it lands on.
  const display = screen.getDisplayNearestPoint({
    x: Math.round(wanted + b.width / 2),
    y: b.y + Math.round(HANDLE_H / 2),
  });
  const area = display.workArea;
  const size = measurePanel(area);
  const share = slotFraction(area, size.width, wanted);
  const x = slotX(area, size.width, share);

  // Resizing a transparent window leaves the newly exposed area unpainted, so
  // the size is only ever touched when the strip actually changes monitor.
  if (size.width !== b.width || size.height !== b.height) {
    win.setBounds({ x, y: area.y, width: size.width, height: size.height });
    sendShadeSize();
  } else {
    win.setPosition(x, area.y);
  }

  const s = settings.get();
  s.placement = { display: display.id, x: share };
  settings.set(s);
}

/** Back to where it started: the middle of the main monitor. */
function centerPanel() {
  const s = settings.get();
  s.placement = { display: screen.getPrimaryDisplay().id, x: 0.5 };
  settings.set(s);
  reposition();
}

/** True while a window of ours other than the panel is on screen. */
function hasOwnChildWindow() {
  return BrowserWindow.getAllWindows().some((w) => w !== win && !w.isDestroyed() && w.isVisible());
}

/** The strip the closed shade actually responds to, in screen coordinates. */
// With the words showing, the strip grows downward into a plate. The panel
// measures itself and says how tall it now is; the width deliberately stays as
// it was, so the long ends of a line hang over the desktop without taking the
// mouse — the words can be read and what is behind them still clicked.
let handleH = HANDLE_H;

function handleRect() {
  const b = win.getBounds();
  return {
    x: b.x + Math.round((b.width - HANDLE_W) / 2),
    y: b.y,
    width: HANDLE_W,
    height: handleH,
  };
}

function createWindow() {
  win = new BrowserWindow({
    ...targetBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  // Served over loopback rather than file:// so the YouTube embed has a real
  // origin; falls back to the file if the port could not be opened.
  if (web) win.loadURL(`${web.origin}/index.html`);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    sendShadeSize();
    startHoverWatch();
  });

  win.on('blur', () => {
    // The sign-in window is ours and takes the focus on purpose; rolling the
    // shade up under it would hide the very screen that reports the result.
    if (expanded && !hasOwnChildWindow()) collapse();
  });

  // Nothing inside the panel should ever navigate away or open a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer:${level}] ${message} (${src}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer gone]', d));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[load failed]', code, desc));
  if (DEV) {
    win.webContents.on('did-finish-load', () => {
      console.log('[win] loaded, bounds', JSON.stringify(win.getBounds()));
    });
  }

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// Grow the window and take the mouse, but leave the shade where it is: this is
// what a pull-gesture needs before the first pixel of drag.
function prepare() {
  stopHoverWatch();
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (expanded) return;
  expanded = true;
  win.setIgnoreMouseEvents(false);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.focus();
  // While nobody is looking at the panel the bridge has less to report.
  if (media) media.send('watch', 'open');
}

/**
 * Holds the mouse without opening the shade.
 *
 * A drag that starts on the handle might turn out to be a sideways move rather
 * than a pull, and the cursor watch would otherwise hand the mouse back to the
 * desktop the moment the pointer left the handle mid-gesture.
 */
function grab() {
  stopHoverWatch();
  if (!win || win.isDestroyed()) return;
  hovering = true;
  win.setIgnoreMouseEvents(false);
}

function expand() {
  prepare();
  win.webContents.send('ui:open');
}

function collapse() {
  if (!expanded) return;
  expanded = false;
  win.webContents.send('ui:close');
  // Give the slide-up its full run before the window shrinks under it.
  collapseTimer = setTimeout(() => finishCollapse(), 420);
}

function finishCollapse() {
  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (expanded || !win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(true, { forward: true });
  hovering = false;
  win.webContents.send('ui:hover', false);
  startHoverWatch();
  if (media) media.send('watch', 'closed');
}

function toggle() {
  if (expanded) collapse();
  else expand();
}

function reposition() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(targetBounds());
  sendShadeSize();
}

/** The panel draws itself; it needs to know how tall the shade may be. */
function sendShadeSize() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui:size', panelSize());
}

// --- tray -------------------------------------------------------------------
function trayIcon() {
  const file = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  if (fs.existsSync(file)) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Vidget');
  refreshTrayMenu();
  tray.on('click', () => toggle());
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть панель', click: () => expand() },
      { type: 'separator' },
      {
        label: 'Запускать при входе в Windows',
        type: 'checkbox',
        checked: !!settings.get().autostart,
        click: (item) => setAutostart(item.checked),
      },
      {
        label: 'Запускать Яндекс Музыку вместе с виджетом',
        type: 'checkbox',
        checked: settings.get().launchPlayer === true,
        click: (item) => {
          const s = settings.get();
          s.launchPlayer = item.checked;
          settings.set(s);
        },
      },
      { label: 'Панель по центру экрана', click: () => centerPanel() },
      ...(settings.get().vaultPath
        ? [
            {
              label: vault && vault.unlocked ? 'Закрыть пароли' : 'Пароли закрыты',
              enabled: !!(vault && vault.unlocked),
              click: () => vault.lock('из меню в трее'),
            },
          ]
        : []),
      { label: 'Папка с данными', click: () => shell.openPath(app.getPath('userData')) },
      { type: 'separator' },
      { label: 'Выход', click: () => quit() },
    ])
  );
}

// --- autostart --------------------------------------------------------------
function setAutostart(enabled) {
  const s = settings.get();
  s.autostart = !!enabled;
  settings.set(s);
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [path.resolve(__dirname, '..', '..'), '--hidden'],
    });
    console.log('[autostart]', enabled ? 'enabled' : 'disabled');
  } catch (err) {
    console.error('[autostart]', err.message);
  }
  refreshTrayMenu();
}

// --- Yandex Music token -----------------------------------------------------
// Kept encrypted with the OS key store when one is available, so the settings
// file never holds a usable credential.
function loadToken() {
  const s = settings.get();
  if (s.yandexTokenEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.yandexTokenEnc, 'base64'));
    } catch {
      return null;
    }
  }
  // An older build wrote the token exactly as it came. Now that it has been
  // read, put it back the way it should have been kept — the settings file is
  // plain text and sits in a folder anything running as this user can open.
  const plain = s.yandexToken || null;
  if (plain && safeStorage.isEncryptionAvailable()) saveToken(plain);
  return plain;
}

function saveToken(token) {
  const s = settings.get();
  delete s.yandexToken;
  delete s.yandexTokenEnc;
  if (token) {
    if (safeStorage.isEncryptionAvailable()) {
      s.yandexTokenEnc = safeStorage.encryptString(token).toString('base64');
    } else {
      s.yandexToken = token;
    }
  }
  settings.set(s);
}

// --- lifecycle --------------------------------------------------------------
function quit() {
  if (media) media.stop();
  if (clip) clip.stop();
  if (autotype) autotype.stop();
  if (vault) vault.lock('выход');
  app.quit();
}

/**
 * Takes the window off the screen so the one underneath becomes active again.
 *
 * The only way to hand the foreground to another program on Windows is to stop
 * being on the screen at all: collapsing the shade keeps the window active,
 * and blur() leaves it in front too.
 */
function hideForTyping() {
  if (!win || win.isDestroyed()) return;
  win.hide();
}

/**
 * Tells the panel whether the strip should hint at itself.
 *
 * The whole answer is already in memory — this is the same matching that puts
 * the right entry at the top of the list — so it costs a comparison per window
 * change and nothing at all while the window stays put.
 */
function sendVaultHint(front) {
  if (!vault) return;
  const title = (front && front.title) || (autotype && autotype.front() && autotype.front().title);
  send('vault:hint', vault.hasMatchFor(title));
}

/** The auto-type sidecar exists only while a database is configured. */
function applyVaultRunning() {
  if (!autotype) return;
  const wanted = !!settings.get().vaultPath;
  if (wanted && !autotype.running) autotype.start();
  if (!wanted && autotype.running) autotype.stop();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => expand());
  app.whenReady().then(init);
}

async function init() {
  app.setAppUserModelId(APP_ID);

  const dir = app.getPath('userData');
  const imageDir = path.join(dir, 'images');

  // The panel is served over loopback, and so are clipboard pictures: that way
  // the panel loads one by address instead of having its bytes copied across
  // IPC as text.
  web = await startServer({ clipImages: imageDir });
  if (!web) console.warn('[server] loopback port unavailable, YouTube tab will be limited');

  settings = new Store(dir, 'settings', {
    autostart: true,
    launchPlayer: false,
    lyrics: false,
    keepImages: true,
    clipLimit: 300,
    // Pictures are kept at full quality, so the history is bounded by disk
    // rather than by a count: the oldest unpinned go once the folder outgrows
    // this. 2 GB is roughly a few hundred screenshots.
    imageBudget: 2 * 1024 * 1024 * 1024,
    updateUrl: '',
    hotkey: 'Control+Alt+Space',
    tab: 'music',
  });
  const clipStore = new Store(dir, 'clipboard', { items: [] });
  const noteStore = new Store(dir, 'notes', { notes: [] });
  stores = [settings, clipStore, noteStore];

  media = new MediaBridge(APP_ID);
  clip = new ClipboardWatcher(clipStore, imageDir, () => settings.get());
  clip.setOrigin(web ? web.origin : null, web ? web.clipPrefix : null);
  notes = new Notes(noteStore);
  yandex = new YandexMusic();
  player = new Player();
  vault = new Vault(() => settings.get());
  autotype = new AutoType();

  createWindow();
  buildTray();
  registerIpc();

  media.on('state', (s) => {
    send('media:state', s);
    if (s.active && s.key) yandex.onTrack(s.key, s.artist, s.title);
  });
  media.on('art', (a) => send('media:art', a));
  media.on('vol', (v) => send('media:vol', v));
  clip.on('change', () => send('clip:items', clip.listForRenderer()));
  notes.on('change', () => send('notes:items', notes.all()));
  yandex.on('status', (st) => {
    send('ya:status', st);
    console.log('[yandex]', st.connected ? `подключён как ${st.login}` : `не подключён: ${st.error || 'нет токена'}`);
  });
  yandex.on('track', (t) => {
    send('ya:track', t);
    if (t.state === 'unknown') console.log('[yandex] трек не найден в каталоге:', t.key);
  });
  yandex.on('art', (a) => send('ya:art', a));

  media.start();
  clip.start();
  applyVaultRunning();

  vault.on('change', (st) => {
    send('vault:status', st);
    refreshTrayMenu(); // the tray offers to lock only while there is something open
  });
  vault.on('locked', (reason) => {
    send('vault:locked', reason);
    send('vault:hint', false);
  });
  vault.on('reloaded', () => send('vault:list', vault.list()));
  autotype.on('window', (w) => {
    send('vault:window', w);
    sendVaultHint(w);
  });

  // Walking away from the machine should close the passwords, whatever the
  // idle timer says.
  powerMonitor.on('lock-screen', () => vault.lock('экран заблокирован'));
  powerMonitor.on('suspend', () => vault.lock('компьютер уснул'));
  // Waking up looks a lot like booting: the network comes back a moment after
  // everything else, so give the sign-in another run from the top.
  powerMonitor.on('resume', () => yandex.retryNow());

  // Retries on its own: right after a reboot there is often no network yet.
  yandex.startAutoConnect(loadToken);

  // Looks for a newer build once the machine has settled, and only if an
  // address was configured; it never interrupts on its own.
  updater.checkQuietly(settings.get().updateUrl, (st) => send('app:update', st));

  // Off by default: the widget plays on its own, so starting the desktop app
  // would only put a second player on the machine. Still available in the menu.
  if (settings.get().launchPlayer === true) {
    setTimeout(() => player.launch({ minimized: true }).catch(() => {}), 6000);
  }

  // Apply the stored autostart preference on every launch so a moved or
  // reinstalled binary keeps the registry entry pointing at the right exe.
  setAutostart(settings.get().autostart !== false);

  registerHotkeys();

  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (media) media.stop();
    if (clip) clip.stop();
    if (autotype) autotype.stop();
    if (vault) vault.lock('выход');
    for (const store of stores) store.flush();
    if (web) web.server.close();
  });
}

const HOTKEY_FALLBACKS = ['Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+Q', 'Alt+Shift+V'];
const PASSWORD_FALLBACKS = ['Control+Alt+P', 'Control+Shift+P', 'Control+Alt+L', 'Alt+Shift+P'];

/**
 * Registers the first accelerator Windows has not already handed out.
 *
 * @param {string} preferred what the settings ask for
 * @param {string[]} fallbacks tried in order when it is taken
 * @param {string} key the setting to remember the working one under
 * @param {() => void} action
 */
function registerOne(preferred, fallbacks, key, action) {
  const candidates = [preferred, ...fallbacks].filter(Boolean);
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, action)) {
        if (accel !== preferred) {
          const s = settings.get();
          s[key] = accel;
          settings.set(s);
        }
        console.log('[hotkey]', key, '=', accel);
        return accel;
      }
    } catch (err) {
      console.error('[hotkey]', accel, err.message);
    }
  }
  console.warn('[hotkey] нет свободного сочетания для', key);
  return null;
}

/** Both shortcuts at once: registering one means giving up the other first. */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const s = settings.get();
  const main = registerOne(s.hotkey, HOTKEY_FALLBACKS, 'hotkey', () => toggle());
  // The passwords shortcut only exists once there is a database to open.
  if (s.vaultPath) {
    registerOne(s.passwordHotkey || PASSWORD_FALLBACKS[0], PASSWORD_FALLBACKS, 'passwordHotkey', () =>
      openPasswords()
    );
  }
  return main;
}

/**
 * The passwords hotkey: opens the panel straight onto the password list.
 *
 * The window the user was working in is already known — the sidecar keeps that
 * up to date — so by the time the panel has the focus we still know where the
 * password is meant to go.
 */
function openPasswords() {
  const front = autotype && autotype.front();
  expand();
  send('vault:open', { window: front || null });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- ipc --------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('ui:size', () => panelSize());
  ipcMain.on('ui:prepare', () => prepare());
  ipcMain.on('ui:expand', () => expand());
  ipcMain.on('ui:request-close', () => collapse());
  ipcMain.on('ui:collapsed', () => finishCollapse());
  ipcMain.on('ui:grab', () => grab());
  ipcMain.on('ui:release', () => {
    if (!expanded) finishCollapse();
  });
  ipcMain.on('ui:move-start', (_e, screenX) => beginMove(screenX));
  ipcMain.on('ui:move', (_e, screenX) => moveTo(screenX));
  ipcMain.on('ui:move-end', () => {
    moveGrab = null;
  });
  // How tall the strip has become; only its own height, never anything wilder.
  ipcMain.on('ui:handle-height', (_e, h) => {
    const wanted = Math.round(Number(h) || 0);
    handleH = Math.max(HANDLE_H, Math.min(160, wanted || HANDLE_H));
  });

  ipcMain.on('ui:center', () => centerPanel());

  ipcMain.handle('media:snapshot', () => media.snapshot());
  ipcMain.on('media:cmd', (_e, { cmd, arg }) => media.send(cmd, arg));

  ipcMain.handle('clip:list', () => clip.listForRenderer());
  ipcMain.handle('clip:full', (_e, id) => clip.full(id));
  ipcMain.handle('clip:restore', (_e, id) => clip.restore(id));
  ipcMain.on('clip:remove', (_e, id) => clip.remove(id));
  ipcMain.on('clip:pin', (_e, id) => clip.togglePin(id));
  ipcMain.on('clip:clear', () => clip.clear(true));

  ipcMain.handle('notes:list', () => notes.all());
  ipcMain.handle('notes:create', (_e, text) => notes.create(text || ''));
  ipcMain.on('notes:update', (_e, { id, text }) => notes.update(id, text));
  ipcMain.on('notes:remove', (_e, id) => notes.remove(id));
  ipcMain.on('notes:pin', (_e, id) => notes.togglePin(id));

  ipcMain.handle('yt:origin', () => (web ? web.origin : null));
  ipcMain.handle('yt:search', (_e, query) => youtube.search(query));
  ipcMain.on('yt:open', (_e, id) => {
    if (/^[\w-]{6,20}$/.test(id || '')) shell.openExternal(`https://www.youtube.com/watch?v=${id}`);
  });

  ipcMain.handle('player:status', () => player.status());
  ipcMain.handle('player:launch', () => player.launch({ minimized: false }));

  ipcMain.handle('ya:status', async () => ({
    ...yandex.status(),
    web: await yandexLogin.hasWebSession(),
  }));

  // One button for both halves: the window's session gets the cookies that let
  // the panel play a full track, and the redirect hands back the API token.
  ipcMain.handle('ya:login', async () => {
    const res = await yandexLogin.openLogin(win);
    if (!res.ok) {
      return { ...yandex.status(), web: await yandexLogin.hasWebSession(), cancelled: true };
    }
    const st = await yandex.connect(res.token);
    saveToken(st.connected ? res.token : null);
    return { ...st, web: await yandexLogin.hasWebSession() };
  });
  ipcMain.handle('ya:track', () => yandex.trackState());
  ipcMain.handle('ya:connect', async (_e, token) => {
    const st = await yandex.connect(token);
    saveToken(st.connected ? (token || '').trim() : null);
    return { ...st, web: await yandexLogin.hasWebSession() };
  });
  ipcMain.handle('ya:disconnect', async () => {
    saveToken(null);
    yandex.disconnect();
    await yandexLogin.clearWebSession();
    return { ...yandex.status(), web: false };
  });
  ipcMain.handle('ya:search', (_e, query) => yandex.searchTracks(query));
  ipcMain.handle('ya:wave-start', () => yandex.waveStart());
  ipcMain.handle('ya:wave-next', (_e, { playedId, playedSeconds } = {}) =>
    yandex.waveNext(playedId, playedSeconds)
  );
  // The panel makes its own sound; this is the link it plays.
  ipcMain.handle('ya:stream', (_e, id) => yandex.streamUrl(id));
  // Timed words for the same track, when Yandex has them.
  ipcMain.handle('ya:lyrics', (_e, id) => yandex.lyricsFor(id));

  ipcMain.handle('ya:play', async (_e, { id, albumId } = {}) => {
    if (!/^\d{1,15}$/.test(String(id || ''))) return { ok: false };
    // The desktop player registers yandexmusic:// and routes it like the site.
    if (!/^\d{1,15}$/.test(String(albumId || ''))) {
      shell.openExternal(`https://music.yandex.ru/track/${id}`);
      return { ok: true };
    }
    return player.playUrl(`yandexmusic://album/${albumId}/track/${id}`);
  });

  ipcMain.handle('ya:like', () => yandex.toggleLike());
  ipcMain.handle('ya:dislike', () => yandex.toggleDislike());
  ipcMain.on('ya:open-auth', () => shell.openExternal(yandex.authUrl()));

  ipcMain.handle('app:settings', () => ({
    ...settings.get(),
    version: app.getVersion(),
    clipImages: clip.imageUsage(),
  }));
  ipcMain.handle('app:check-update', () =>
    updater.check(settings.get().updateUrl, (st) => send('app:update', st))
  );
  ipcMain.handle('app:set-setting', (_e, { key, value }) => {
    // Настройки паролей меняются здесь же, чтобы всё хранилось в одном файле.
    const s = settings.get();
    s[key] = value;
    settings.set(s);
    if (key === 'autostart') setAutostart(value);
    if (key === 'hotkey' || key === 'passwordHotkey') registerHotkeys();
    // A different database is a different set of passwords; the open one has
    // to go, and the sidecar is only wanted while there is a file at all.
    if (key === 'vaultPath' || key === 'vaultKeyFile') {
      vault.lock('сменился файл базы');
      applyVaultRunning();
      registerHotkeys();
    }
    // A smaller budget has to take effect now, not at the next copy.
    if (key === 'imageBudget') clip.sweepImages();
    return s;
  });
  ipcMain.on('app:quit', () => quit());

  registerVaultIpc();
}

// --- passwords ---------------------------------------------------------------
// Everything a password touches lives here, so there is one place to look when
// asking what the panel can and cannot get hold of.

/** How long a copied password may sit on the clipboard before being wiped. */
const CLIP_CLEAR_MS = 30000;
let clipClearTimer = null;

function copySecret(value) {
  if (value == null) return { ok: false, error: 'Нечего копировать' };
  clip.writeUnrecorded(value);
  if (clipClearTimer) clearTimeout(clipClearTimer);
  clipClearTimer = setTimeout(() => {
    clipClearTimer = null;
    // Only if it is still ours: something copied since is the user's business.
    if (clip.holds(value)) {
      clip.clearClipboard();
      send('vault:cleared', true);
    }
  }, CLIP_CLEAR_MS);
  if (clipClearTimer.unref) clipClearTimer.unref();
  return { ok: true, seconds: CLIP_CLEAR_MS / 1000 };
}

function registerVaultIpc() {
  ipcMain.handle('vault:status', () => ({
    ...vault.status(),
    window: autotype ? autotype.front() : null,
    hotkey: settings.get().passwordHotkey || PASSWORD_FALLBACKS[0],
  }));

  ipcMain.handle('vault:unlock', async (_e, password) => {
    const res = await vault.unlock(password);
    if (res.ok) sendVaultHint(null);
    return { ...res, status: vault.status() };
  });

  ipcMain.on('vault:lock', () => vault.lock('по кнопке'));

  // Always through the search, so a database with thousands of entries does
  // not hand all of them to the panel just to fill a list nobody scrolled.
  ipcMain.handle('vault:list', (_e, query) => vault.find(query || '', 200));

  /** Entries that suit the window the user came from, best first. */
  ipcMain.handle('vault:for-window', () => {
    const front = autotype && autotype.front();
    if (!front || !front.title) return { window: null, items: [] };
    return { window: front, items: vault.forWindow(front.title) };
  });

  ipcMain.handle('vault:reveal', (_e, { id, field }) => vault.secret(id, field || 'Password'));
  ipcMain.handle('vault:totp', (_e, id) => vault.totp(id));
  ipcMain.handle('vault:history', (_e, id) => vault.history(id));
  ipcMain.handle('vault:past', (_e, { id, index, field }) => vault.pastSecret(id, index, field));

  /** Opens the entry's address in the browser, the way KeePass does. */
  ipcMain.handle('vault:open-url', (_e, id) => {
    const url = vault.secret(id, 'URL');
    if (!url) return { ok: false, error: 'У записи нет адреса' };
    const full = /^[a-z][w+.-]*:/i.test(url) ? url : `https://${url}`;
    // Only the two schemes a browser should be handed. A kdbx in the wild can
    // hold anything at all in that field, including a command line.
    if (!/^https?:/i.test(full)) return { ok: false, error: 'Такой адрес виджет не открывает' };
    shell.openExternal(full);
    return { ok: true };
  });

  ipcMain.handle('vault:copy', (_e, { id, field, pastIndex }) => {
    if (field === 'TOTP') {
      const code = vault.totp(id);
      return code ? copySecret(code.text) : { ok: false, error: 'У записи нет одноразового кода' };
    }
    // An older version of the entry goes through the same door, so it is wiped
    // from the clipboard on the same timer as everything else.
    const value =
      pastIndex == null ? vault.secret(id, field || 'Password') : vault.pastSecret(id, pastIndex, field || 'Password');
    return copySecret(value);
  });

  /**
   * Types an entry into the window the user came from.
   *
   * The panel has to be out of the way first: Windows will not let us hand the
   * foreground to another program, but it will put back what was there once we
   * stop being the front window.
   */
  ipcMain.handle('vault:type', async (_e, id) => {
    const front = autotype && autotype.front();
    if (!front || !front.title) return { ok: false, error: 'Не видно, в каком окне вы работали' };

    const plan = vault.plan(id, front.title);
    if (!plan.ok) return plan;

    // Rolling the shade up is not enough. The window stays active — Windows
    // keeps it in front, and the sidecar rightly refuses to type into it.
    // Asking it to give up the focus does not help either: blur() leaves it
    // exactly where it was. Taking the window off the screen does, and then
    // Windows puts back whatever the user was in. Measured, not assumed.
    collapse();
    hideForTyping();
    await new Promise((r) => setTimeout(r, 320));

    const res = await autotype.type(plan.steps, front.title);

    // The strip comes back without taking the focus from the window that just
    // received the password.
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    finishCollapse();

    // Success speaks for itself — the password is in the form. A failure would
    // otherwise be silent, so the panel comes back to say what went wrong.
    if (!res.ok) {
      expand();
      send('vault:typed', res);
    }
    return res;
  });

  // --- changing the database ---
  ipcMain.handle('vault:groups', () => vault.groups());
  ipcMain.handle('vault:create', (_e, { groupId, fields }) => vault.createEntry({ groupId, fields }));
  ipcMain.handle('vault:update', (_e, { id, fields }) => vault.updateEntry(id, fields));
  ipcMain.handle('vault:delete', (_e, id) => vault.deleteEntry(id));
  ipcMain.handle('vault:generate', (_e, options) => generatePassword(options || {}));

  ipcMain.handle('vault:save-attachment', async (_e, { id, name }) => {
    const bytes = vault.attachment(id, name);
    if (!bytes) return { ok: false, error: 'Вложение не найдено' };
    const picked = await dialog.showSaveDialog(win, { defaultPath: name });
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(picked.filePath, bytes);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true, file: picked.filePath };
  });

  ipcMain.handle('vault:pick-file', async (_e, what) => {
    const key = what === 'key';
    const picked = await dialog.showOpenDialog(win, {
      title: key ? 'Файл-ключ от базы' : 'База паролей KeePass',
      properties: ['openFile'],
      filters: key
        ? [{ name: 'Все файлы', extensions: ['*'] }]
        : [{ name: 'База KeePass', extensions: ['kdbx'] }, { name: 'Все файлы', extensions: ['*'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return picked.filePaths[0];
  });
}
