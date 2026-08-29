'use strict';

const { autoUpdater } = require('electron-updater');

/**
 * Updates from the project's GitHub releases.
 *
 * The address is baked in at build time, so an installed copy already knows
 * where to look. A different host can still be given in the settings, which
 * takes over when it is filled in.
 */
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

let wired = false;
let state = { message: 'ещё не проверялось' };

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
  wire(onState);
  try {
    // Only override the address the build already carries when one was given.
    if (url) autoUpdater.setFeedURL({ provider: 'generic', url });
    await autoUpdater.checkForUpdates();
    return state;
  } catch (err) {
    const message = (err && err.message) || 'ошибка';
    // Running from source there is no build to update, and no feed description
    // beside it — worth saying plainly instead of showing a raw failure.
    state = /app-update\.yml/i.test(message)
      ? { message: 'работает только в установленной версии' }
      : { message: `не удалось: ${message}` };
    return state;
  }
}

/** Quiet check on start: never interrupts, only reports through onState. */
function checkQuietly(url, onState) {
  setTimeout(() => check(url, onState).catch(() => {}), 20000);
}

module.exports = { check, checkQuietly };
