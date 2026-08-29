'use strict';

const { autoUpdater } = require('electron-updater');

/**
 * Updates from a plain static host.
 *
 * The address is a setting rather than something baked into the build, so the
 * same installer works whether the files end up on a site, a share or nowhere
 * at all. Point it at the folder holding `latest.yml` and the installer that
 * `npm run dist` produced.
 */
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

let wired = false;
let state = { message: 'не настроено' };

function wire(onState) {
  if (wired) return;
  wired = true;

  const set = (message, extra = {}) => {
    state = { message, ...extra };
    if (onState) onState(state);
  };

  autoUpdater.on('update-available', (info) => set(`есть версия ${info.version}, качаем`, { available: true }));
  autoUpdater.on('update-not-available', () => set('установлена последняя версия'));
  autoUpdater.on('download-progress', (p) => set(`загрузка ${Math.round(p.percent)} %`));
  autoUpdater.on('update-downloaded', (info) =>
    set(`версия ${info.version} готова, встанет при выходе`, { downloaded: true })
  );
  autoUpdater.on('error', (err) => set(`не удалось: ${(err && err.message) || 'ошибка'}`));
}

/**
 * Asks the host whether something newer exists. Returns what to show the user;
 * the download, if any, carries on in the background.
 */
async function check(url, onState) {
  if (!url) {
    state = { message: 'адрес обновлений не задан' };
    return state;
  }

  wire(onState);
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url });
    const res = await autoUpdater.checkForUpdates();
    if (!res || !res.updateInfo) return state;
    return state;
  } catch (err) {
    state = { message: `не удалось: ${(err && err.message) || 'ошибка'}` };
    return state;
  }
}

/** Quiet check on start: never interrupts, only reports through onState. */
function checkQuietly(url, onState) {
  if (!url) return;
  setTimeout(() => check(url, onState).catch(() => {}), 20000);
}

module.exports = { check, checkQuietly };
