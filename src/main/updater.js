'use strict';

const { autoUpdater } = require('electron-updater');
const { describe } = require('../shared/update-offer');

/**
 * Updates from the project's GitHub releases.
 *
 * The address is baked in at build time, so an installed copy already knows
 * where to look. A different host can still be given in the settings, which
 * takes over when it is filled in.
 *
 * Nothing is downloaded or installed behind the user's back any more. The
 * widget checks on its own — shortly after it starts and then every few hours
 * — and when there is something newer the panel offers it: update now, or
 * skip this version. Before, a found update downloaded itself and went in on
 * the next quit, which left no way to say no.
 */
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = null;

const FIRST_CHECK_MS = 20 * 1000;
const EVERY_MS = 6 * 60 * 60 * 1000;

let wired = false;
let listener = null;
let state = { status: 'idle', message: 'ещё не проверялось' };
let installWhenReady = false;
let manualCheck = false; // the last check was asked for from the settings
let timer = null;

function set(next) {
  state = { ...next, message: describe(next) };
  if (listener) listener(state);
  return state;
}

function wire() {
  if (wired) return;
  wired = true;

  autoUpdater.on('checking-for-update', () => {
    // A check on top of a known update must not hide that update.
    if (state.status === 'available' || state.status === 'downloading' || state.status === 'ready') return;
    set({ status: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    if (state.status === 'downloading' || state.status === 'ready') return;
    set({ status: 'available', version: info.version, notes: releaseNotes(info), manual: manualCheck });
  });
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('download-progress', (p) =>
    set({ status: 'downloading', version: state.version, percent: Math.round(p.percent || 0), userStarted: true })
  );
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version });
    if (installWhenReady) install();
  });
  autoUpdater.on('error', (err) => {
    const userStarted = installWhenReady || !!state.userStarted;
    installWhenReady = false;
    set({ status: 'error', version: state.version, userStarted, error: explain((err && err.message) || 'ошибка') });
  });
}

/** The release description, as plain text, when the feed carries one. */
function releaseNotes(info) {
  const notes = info && info.releaseNotes;
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]+>/g, '').trim().slice(0, 600);
}

/** Turns the library's wording into something worth showing a person. */
function explain(message) {
  // Running from source there is no build to update, and no feed description
  // beside it.
  if (/app-update\.yml/i.test(message)) return 'работает только в установленной версии';
  if (/no published versions/i.test(message)) return 'пока нет ни одного релиза';
  if (/net::|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(message)) return 'нет связи с GitHub';
  if (/404/.test(message)) return 'релизы не найдены';
  return `не удалось: ${message}`;
}

/** Tells whoever shows it what the updater is doing. */
function onState(fn) {
  listener = fn;
  wire();
}

/** Asks the host whether something newer exists. */
async function check(url, { manual = false } = {}) {
  wire();
  manualCheck = manual;
  try {
    // Only override the address the build already carries when one was given.
    if (url) autoUpdater.setFeedURL({ provider: 'generic', url });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ status: 'error', manual, error: explain((err && err.message) || 'ошибка') });
  }
  return state;
}

/**
 * Checks on its own: a little after start, once the network has usually come
 * up after a reboot, and then every few hours while the widget runs.
 */
function schedule(getUrl) {
  wire();
  if (timer) clearTimeout(timer);
  const run = async () => {
    await check(getUrl()).catch(() => {});
    timer = setTimeout(run, EVERY_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(run, FIRST_CHECK_MS);
  if (timer.unref) timer.unref();
}

/**
 * «Обновить»: downloads the found version and, once it is in, restarts into it.
 * Pressed again while it is still downloading, it does nothing new.
 */
async function update() {
  wire();
  if (state.status === 'ready') return install();
  if (state.status !== 'available' && state.status !== 'error') return state;
  installWhenReady = true;
  set({ status: 'downloading', version: state.version, percent: 0, userStarted: true });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    installWhenReady = false;
    set({ status: 'error', version: state.version, userStarted: true, error: explain((err && err.message) || 'ошибка') });
  }
  return state;
}

function install() {
  set({ status: 'installing', version: state.version, userStarted: true });
  // Give the panel a moment to say so before the window goes.
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 600);
  return state;
}

const current = () => state;

module.exports = { check, schedule, update, onState, current };
