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
const { Player } = require('./player');
const { startServer } = require('./server');
const youtube = require('./youtube');

// --- geometry ---------------------------------------------------------------
// The window never changes size: resizing a transparent window on Windows
// leaves the newly exposed area unpainted. It always spans the full panel and
// stays click-through, except over the handle or while the shade is open.
const HANDLE_W = 260;
const HANDLE_H = 30;
const PANEL_W = 980;
const PANEL_H = 356; // shade is 288; the rest is fade-out room for the shadow

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
function targetBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - PANEL_W) / 2),
    y: area.y,
    width: PANEL_W,
    height: Math.min(PANEL_H, area.height),
  };
}

/** The strip the closed shade actually responds to, in screen coordinates. */
function handleRect() {
  const b = win.getBounds();
  return {
    x: b.x + Math.round((b.width - HANDLE_W) / 2),
    y: b.y,
    width: HANDLE_W,
    height: HANDLE_H,
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
    startHoverWatch();
  });

  win.on('blur', () => {
    if (expanded) collapse();
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
}

function toggle() {
  if (expanded) collapse();
  else expand();
}

function reposition() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(targetBounds());
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
        checked: settings.get().launchPlayer !== false,
        click: (item) => {
          const s = settings.get();
          s.launchPlayer = item.checked;
          settings.set(s);
        },
      },
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
  return s.yandexToken || null;
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
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => expand());
  app.whenReady().then(init);
}

async function init() {
  app.setAppUserModelId('com.vidget.overlay');

  web = await startServer();
  if (!web) console.warn('[server] loopback port unavailable, YouTube tab will be limited');

  const dir = app.getPath('userData');
  settings = new Store(dir, 'settings', {
    autostart: true,
    launchPlayer: true,
    hotkey: 'Control+Alt+Space',
    tab: 'music',
  });
  const clipStore = new Store(dir, 'clipboard', { items: [] });
  const noteStore = new Store(dir, 'notes', { notes: [] });
  stores = [settings, clipStore, noteStore];

  media = new MediaBridge();
  clip = new ClipboardWatcher(clipStore, path.join(dir, 'images'));
  notes = new Notes(noteStore);
  yandex = new YandexMusic();
  player = new Player();

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

  // Retries on its own: right after a reboot there is often no network yet.
  yandex.startAutoConnect(loadToken);

  // Nothing publishes a media session until the player is running, so bring it
  // up quietly once the desktop has settled.
  if (settings.get().launchPlayer !== false) {
    setTimeout(() => player.launch({ minimized: true }).catch(() => {}), 6000);
  }

  // Apply the stored autostart preference on every launch so a moved or
  // reinstalled binary keeps the registry entry pointing at the right exe.
  setAutostart(settings.get().autostart !== false);

  registerHotkey(settings.get().hotkey);

  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (media) media.stop();
    if (clip) clip.stop();
    for (const store of stores) store.flush();
    if (web) web.server.close();
  });
}

const HOTKEY_FALLBACKS = ['Control+Alt+Space', 'Control+Shift+Space', 'Control+Alt+Q', 'Alt+Shift+V'];

/** Registers the first accelerator that Windows has not already handed out. */
function registerHotkey(preferred) {
  globalShortcut.unregisterAll();
  const candidates = [preferred, ...HOTKEY_FALLBACKS].filter(Boolean);
  for (const accel of candidates) {
    try {
      if (globalShortcut.register(accel, () => toggle())) {
        if (accel !== preferred) {
          const s = settings.get();
          s.hotkey = accel;
          settings.set(s);
        }
        console.log('[hotkey] using', accel);
        return accel;
      }
    } catch (err) {
      console.error('[hotkey]', accel, err.message);
    }
  }
  console.warn('[hotkey] no accelerator available');
  return null;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// --- ipc --------------------------------------------------------------------
function registerIpc() {
  ipcMain.on('ui:prepare', () => prepare());
  ipcMain.on('ui:expand', () => expand());
  ipcMain.on('ui:request-close', () => collapse());
  ipcMain.on('ui:collapsed', () => finishCollapse());

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

  ipcMain.handle('ya:status', () => yandex.status());
  ipcMain.handle('ya:track', () => yandex.trackState());
  ipcMain.handle('ya:connect', async (_e, token) => {
    const st = await yandex.connect(token);
    saveToken(st.connected ? (token || '').trim() : null);
    return st;
  });
  ipcMain.handle('ya:disconnect', () => {
    saveToken(null);
    yandex.disconnect();
    return yandex.status();
  });
  ipcMain.handle('ya:search', (_e, query) => yandex.searchTracks(query));
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

  ipcMain.handle('app:settings', () => settings.get());
  ipcMain.handle('app:set-setting', (_e, { key, value }) => {
    const s = settings.get();
    s[key] = value;
    settings.set(s);
    if (key === 'autostart') setAutostart(value);
    if (key === 'hotkey') registerHotkey(value);
    return s;
  });
  ipcMain.on('app:quit', () => quit());
}
