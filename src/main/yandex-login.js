'use strict';

const { BrowserWindow, session } = require('electron');

const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const AUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${CLIENT_ID}`;

/**
 * One sign-in that covers both halves of the integration.
 *
 * Likes and search need an OAuth token; playing a track inside the panel needs
 * the window's own browser session to be signed in, because Yandex only serves
 * a full track to a signed-in listener. Both come out of the same login: the
 * session keeps the cookies, and the token arrives in the redirect fragment.
 */
function openLogin(parent) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      width: 520,
      height: 700,
      title: 'Вход в Яндекс Музыку',
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: null, // the app's own session, so the panel's player inherits it
      },
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!win.isDestroyed()) win.close();
    };

    // The token comes back in the fragment, which never reaches a server - so
    // watch the navigations this window makes rather than any request.
    const inspect = (url) => {
      const m = /[#&?]access_token=([^&]+)/.exec(url || '');
      if (m) finish({ ok: true, token: decodeURIComponent(m[1]) });
      return !!m;
    };

    win.webContents.on('will-redirect', (e, url) => {
      if (inspect(url)) e.preventDefault();
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (inspect(url)) e.preventDefault();
    });
    win.webContents.on('did-navigate', (_e, url) => inspect(url));
    win.webContents.on('did-navigate-in-page', (_e, url) => inspect(url));

    win.on('closed', () => finish({ ok: false, reason: 'closed' }));

    win.loadURL(AUTH_URL);
  });
}

/** True when the app's session carries a Yandex sign-in. */
async function hasWebSession() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: '.yandex.ru', name: 'Session_id' });
    return cookies.length > 0;
  } catch {
    return false;
  }
}

/** Drops the Yandex cookies; the OAuth token is cleared separately. */
async function clearWebSession() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: '.yandex.ru' });
    await Promise.all(
      cookies.map((c) =>
        session.defaultSession.cookies.remove(`https://${c.domain.replace(/^\./, '')}${c.path}`, c.name).catch(() => {})
      )
    );
  } catch {
    /* nothing to clear */
  }
}

module.exports = { openLogin, hasWebSession, clearWebSession, AUTH_URL };
