'use strict';

const api = window.vidget;
const $ = (sel) => document.querySelector(sel);
const svgIcon = (id) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const PANEL_H = 288;
const OPEN_THRESHOLD = 70;

const body = document.body;
const handle = $('#handle');
const panel = $('#panel');

// ============================================================
//  the shade: hover, pull, open, close
// ============================================================
let isOpen = false;
let drag = null;

// The main process owns hover detection: it watches the real cursor and hands
// the mouse to this window only while the pointer is over the handle.
api.ui.onHover((on) => {
  if (isOpen || drag) return;
  body.classList.toggle('hover', on);
});

const setPull = (px) => panel.style.setProperty('--pull', `${px}px`);

function beginDrag(e, from) {
  drag = { startY: e.screenY, moved: 0, from };
  body.classList.add('dragging');
  body.classList.remove('animating');
  if (from === 'handle') {
    // Grow the window first, so the shade has somewhere to slide into.
    api.ui.prepare();
    setPull(0);
  }
  e.currentTarget.setPointerCapture?.(e.pointerId);
}

handle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  beginDrag(e, 'handle');
});

$('#grip').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  beginDrag(e, 'grip');
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const delta = e.screenY - drag.startY;
  drag.moved = Math.max(drag.moved, Math.abs(delta));
  const base = drag.from === 'handle' ? 0 : PANEL_H;
  if (drag.from === 'grip') body.classList.remove('open');
  setPull(Math.max(0, Math.min(PANEL_H, base + delta)));
});

document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { from, moved } = drag;
  const delta = e.screenY - drag.startY;
  drag = null;
  body.classList.remove('dragging');
  body.classList.add('animating');

  if (from === 'handle') {
    if (moved < 5 || delta > OPEN_THRESHOLD) api.ui.expand();
    else api.ui.requestClose();
  } else if (-delta > OPEN_THRESHOLD || moved < 5) {
    api.ui.requestClose();
  } else {
    api.ui.expand();
  }
});

$('#backdrop').addEventListener('pointerdown', () => api.ui.requestClose());

api.ui.onOpen(() => {
  isOpen = true;
  body.classList.remove('hover');
  body.classList.add('animating', 'open');
  setPull(0);
  refreshAll();
});

api.ui.onClose(() => {
  isOpen = false;
  body.classList.add('animating');
  body.classList.remove('open');
  setPull(0);
  hidePreview();
  closeYa();
  closeMenu();
  if (!noteEditor.hidden) closeNote();
});

panel.addEventListener('transitionend', (e) => {
  if (e.propertyName !== 'transform' || isOpen) return;
  body.classList.remove('animating'); // drops the shadow that bled past the handle
  api.ui.collapsed();
});

// ============================================================
//  tabs
// ============================================================
const tabsBar = $('#tabs');
const menuBtn = $('#menu-btn');

let activeTab = 'music';
let tabDrag = null;

const tabNodes = () => [...tabsBar.querySelectorAll('.tab')];
const tabOrder = () => tabNodes().map((t) => t.dataset.tab);

function selectTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  api.app.setSetting('tab', name);
  if (name === 'clip') renderClips();
  if (name === 'notes') renderNotes();
  if (name === 'yt' && !ytResults.length) ytMsg('Введите запрос и нажмите Enter');
}

/** Puts the tabs back in the order the user last left them. */
function applyTabOrder(order) {
  if (!Array.isArray(order) || !order.length) return;
  const byName = new Map(tabNodes().map((t) => [t.dataset.tab, t]));
  const placed = new Set();
  for (const name of order) {
    const node = byName.get(name);
    if (!node) continue;
    tabsBar.insertBefore(node, menuBtn);
    placed.add(name);
  }
  // Anything the saved order predates goes last rather than first.
  for (const node of tabNodes()) {
    if (!placed.has(node.dataset.tab)) tabsBar.insertBefore(node, menuBtn);
  }
}

// --- drag to reorder --------------------------------------------------------
// Tabs are not all the same width, so the target slot is worked out from where
// the dragged tab's centre lands relative to the others, and the tabs it passes
// shift by exactly the footprint it vacates.
function tabGeometry(nodes) {
  const rects = nodes.map((n) => n.getBoundingClientRect());
  return {
    centers: rects.map((r) => r.left + r.width / 2),
    rects,
  };
}

function shiftNeighbours() {
  const { nodes, from, to, tab, gap, rects } = tabDrag;
  const span = rects[from].width + gap;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === tab) continue;
    let shift = 0;
    if (from < to && i > from && i <= to) shift = -span;
    else if (from > to && i >= to && i < from) shift = span;
    node.style.transform = shift ? `translateX(${shift}px)` : '';
  }
}

tabsBar.addEventListener('pointerdown', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || e.button !== 0) return;
  e.preventDefault();

  const nodes = tabNodes();
  const from = nodes.indexOf(tab);
  const { centers, rects } = tabGeometry(nodes);
  const gap = parseFloat(getComputedStyle(tabsBar).columnGap) || 0;

  tabDrag = { tab, nodes, from, to: from, startX: e.clientX, centers, rects, gap, moved: 0 };
  tab.setPointerCapture(e.pointerId);
});

document.addEventListener('pointermove', (e) => {
  if (!tabDrag) return;
  const dx = e.clientX - tabDrag.startX;
  tabDrag.moved = Math.max(tabDrag.moved, Math.abs(dx));
  if (tabDrag.moved < 4) return;

  tabDrag.tab.classList.add('dragging');
  tabDrag.tab.style.transform = `translateX(${dx}px)`;

  const { centers, from } = tabDrag;
  const center = centers[from] + dx;
  let to = from;
  for (let i = 0; i < centers.length; i++) {
    if (i === from) continue;
    if (i < from && center < centers[i]) to = Math.min(to, i);
    else if (i > from && center > centers[i]) to = Math.max(to, i);
  }

  if (to !== tabDrag.to) {
    tabDrag.to = to;
    shiftNeighbours();
  }
});

document.addEventListener('pointerup', () => {
  if (!tabDrag) return;
  const { tab, nodes, from, to, moved } = tabDrag;
  tabDrag = null;

  tab.classList.remove('dragging');
  for (const node of nodes) node.style.transform = '';

  if (moved < 4) {
    selectTab(tab.dataset.tab); // it was a plain click after all
    return;
  }
  if (to !== from) {
    if (to > from) nodes[to].after(tab);
    else nodes[to].before(tab);
    api.app.setSetting('tabOrder', tabOrder());
  }
});

// ============================================================
//  music
// ============================================================
const artBox = $('#art');
const titleBox = $('#np-title');
const artistBox = $('#np-artist');
const appBox = $('#np-app');
const seekFill = $('#seek-fill');
const seekKnob = $('#seek-knob');
const seekTrack = $('#seek-track');

const APP_NAMES = {
  'com.vidget.overlay': 'играет в виджете',
  'electron.exe': 'играет в виджете',
  'ru.yandex.desktop.music': 'Яндекс Музыка',
  'ru.yandex.music': 'Яндекс Музыка',
  'Spotify.exe': 'Spotify',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Microsoft Edge',
};

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// SMTC only reports a position when the player pushes one, so anchor on the
// last *changed* report and run the clock locally from there.
const clock = { anchorPos: 0, anchorAt: 0, reported: -1, playing: false, duration: 0, key: null };
let mediaState = { active: false };
let seekDrag = false;

function currentPos() {
  if (!clock.playing) return clock.anchorPos;
  return clock.anchorPos + (Date.now() - clock.anchorAt) / 1000;
}

function applyState(s) {
  mediaState = s || { active: false };
  // With nothing sounding anywhere the panel still has something to offer, as
  // long as the widget itself played something earlier.
  body.classList.toggle('no-media', !mediaState.active && !lastTrack);

  if (!mediaState.active) {
    Object.assign(clock, { playing: false, duration: 0, anchorPos: 0, key: null });
    setSeek(0, 0);

    if (lastTrack) {
      setText(titleBox, lastTrack.title || 'Последний трек');
      setText(artistBox, lastTrack.artists || '');
      appBox.textContent = 'на паузе';
      $('#art-letter').textContent = (lastTrack.title || '♫').trim().charAt(0).toUpperCase() || '♫';
      artState.smtc = null;
      artState.ya = lastTrack.cover || null;
      paintArt();
    } else {
      setText(titleBox, 'Ничего не играет');
      setText(artistBox, '');
      appBox.textContent = '';
      artBox.classList.remove('has-art');
      artBox.style.backgroundImage = '';
    }
    updateButtons();
    return;
  }

  const now = Date.now();
  const trackChanged = s.key !== clock.key;
  const jumped = Math.abs(s.position - clock.reported) > 1.5;

  if (trackChanged || jumped || clock.anchorAt === 0) {
    clock.anchorPos = s.position;
    clock.anchorAt = now;
  }
  clock.reported = s.position;
  clock.duration = s.duration;
  clock.key = s.key;

  const playing = s.status === 'Playing';
  if (playing !== clock.playing) {
    // Freeze the clock where it stands on pause, resume from the same spot.
    clock.anchorPos = currentPos();
    clock.anchorAt = now;
    clock.playing = playing;
  }

  if (trackChanged) {
    artState.ya = null; // the new track's cover has not arrived yet
    setText(titleBox, s.title || 'Без названия');
    setText(artistBox, s.artist || '');
    $('#art-letter').textContent = (s.title || '♫').trim().charAt(0).toUpperCase() || '♫';
  }
  appBox.textContent = APP_NAMES[s.app] || s.app || '';
  updateButtons();
}

function updateButtons() {
  const can = mediaState.can || {};
  const playing = mediaState.status === 'Playing';
  const play = $('#play');
  $('#play-use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  play.disabled = !mediaState.active && !lastTrack;
  $('#prev').disabled = !can.prev;
  $('#next').disabled = !can.next;

  // Yandex Music does not hand Windows any shuffle or repeat control, and a
  // button that can never do anything is worse than no button: hide those the
  // current player does not expose.
  const sh = $('#shuffle');
  sh.hidden = !can.shuffle;
  sh.classList.toggle('on', !!mediaState.shuffle);

  const rp = $('#repeat');
  rp.hidden = !can.repeat;
  rp.classList.toggle('on', mediaState.repeat === 'Track' || mediaState.repeat === 'List');
  $('#repeat-use').setAttribute('href', mediaState.repeat === 'Track' ? '#i-repeat1' : '#i-repeat');
}

function setText(node, text) {
  const span = node.firstElementChild;
  span.textContent = text;
  node.classList.remove('marquee');
  requestAnimationFrame(() => {
    const over = span.scrollWidth - node.clientWidth;
    if (over > 6) {
      node.style.setProperty('--drift', `${-over - 8}px`);
      node.classList.add('marquee');
    }
  });
}

function setSeek(pos, dur) {
  const ratio = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  seekFill.style.width = `${ratio * 100}%`;
  seekKnob.style.left = `${ratio * 100}%`;
  $('#t-pos').textContent = fmt(pos);
  $('#t-dur').textContent = fmt(dur);
}

setInterval(() => {
  if (!isOpen || seekDrag || activeTab !== 'music') return;
  const dur = clock.duration;
  setSeek(Math.min(currentPos(), dur || Infinity), dur);
}, 250);

$('#open-player').addEventListener('click', async () => {
  const btn = $('#open-player');
  btn.disabled = true;
  btn.textContent = 'Запускаем…';
  const res = await api.player.launch();
  btn.disabled = false;
  btn.textContent = 'Открыть Яндекс Музыку';
  if (!res || !res.ok) {
    toast(res && res.reason === 'not-found' ? 'Яндекс Музыка не найдена' : 'Не удалось запустить');
  } else if (!res.started) {
    toast('Плеер уже запущен');
  }
});

$('#play').addEventListener('click', () => {
  // Nothing is sounding, but the widget remembers what it played last.
  if (!mediaState.active && lastTrack) return playTrack(lastTrack);
  api.media.cmd('playpause');
});
$('#next').addEventListener('click', () => api.media.cmd('next'));
$('#prev').addEventListener('click', () => api.media.cmd('prev'));
$('#shuffle').addEventListener('click', () => api.media.cmd('shuffle', !mediaState.shuffle));
$('#repeat').addEventListener('click', () => {
  const order = { None: 'List', List: 'Track', Track: 'None' };
  api.media.cmd('repeat', order[mediaState.repeat] || 'List');
});

function ratioFrom(track, e) {
  const r = track.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

seekTrack.addEventListener('pointerdown', (e) => {
  if (!clock.duration || !(mediaState.can && mediaState.can.seek)) return;
  seekDrag = true;
  body.classList.add('seeking');
  seekTrack.setPointerCapture(e.pointerId);
  setSeek(ratioFrom(seekTrack, e) * clock.duration, clock.duration);
});

seekTrack.addEventListener('pointermove', (e) => {
  if (seekDrag) setSeek(ratioFrom(seekTrack, e) * clock.duration, clock.duration);
});

seekTrack.addEventListener('pointerup', (e) => {
  if (!seekDrag) return;
  seekDrag = false;
  body.classList.remove('seeking');
  const pos = ratioFrom(seekTrack, e) * clock.duration;
  clock.anchorPos = pos;
  clock.anchorAt = Date.now();
  clock.reported = pos;
  api.media.cmd('seek', pos);
});

api.media.onState(applyState);

// Two sources: whatever SMTC publishes, and the cover the Yandex API returns
// for the resolved track. SMTC wins when it has one; the Yandex player has none.
const artState = { smtc: null, ya: null };

function paintArt() {
  const url = artState.smtc || artState.ya;
  artBox.style.backgroundImage = url ? `url("${url}")` : '';
  artBox.classList.toggle('has-art', !!url);
}

function setArt(data) {
  artState.smtc = data ? `data:image/png;base64,${data}` : null;
  paintArt();
}

api.media.onArt(({ data }) => setArt(data));
api.ya.onArt(({ dataUrl }) => {
  artState.ya = dataUrl || null;
  paintArt();
});

// --- volume ----------------------------------------------------------------
const volBox = $('#vol');
const volTrack = $('#vol-track');
let volDrag = false;
let volState = { available: false, value: 0.5, muted: false };

function paintVolume() {
  const pct = (volState.muted ? 0 : volState.value) * 100;
  $('#vol-fill').style.width = `${pct}%`;
  $('#vol-knob').style.left = `${pct}%`;
  $('#vol-use').setAttribute('href', volState.muted || volState.value < 0.01 ? '#i-mute' : '#i-vol');
  volBox.classList.toggle('off', !volState.available);
}

api.media.onVol((v) => {
  volState = {
    available: v.available !== false,
    value: v.value ?? 0,
    muted: !!v.muted,
    scope: v.scope || 'system',
    app: v.app || '',
  };
  const where = volState.scope === 'app' ? `Громкость: ${volState.app}` : 'Громкость системы';
  volBox.title = where;
  $('#vol-icon').title = `${where} — выключить звук`;
  if (!volDrag) paintVolume();
});

volTrack.addEventListener('pointerdown', (e) => {
  if (!volState.available) return;
  volDrag = true;
  volTrack.setPointerCapture(e.pointerId);
  volState.value = ratioFrom(volTrack, e);
  volState.muted = false;
  paintVolume();
  api.media.cmd('volset', volState.value);
});

volTrack.addEventListener('pointermove', (e) => {
  if (!volDrag) return;
  volState.value = ratioFrom(volTrack, e);
  paintVolume();
  api.media.cmd('volset', volState.value);
});

volTrack.addEventListener('pointerup', () => {
  volDrag = false;
});

// Wheel over the volume group nudges it; the UI paints at once and the actual
// set is throttled so a fast scroll does not queue dozens of COM calls.
const VOL_STEP = 0.05;
let volSendTimer = null;
let volPending = null;

function nudgeVolume(delta) {
  if (!volState.available) return;
  volState.value = Math.max(0, Math.min(1, (volState.muted ? 0 : volState.value) + delta));
  volState.muted = false;
  paintVolume();

  volPending = volState.value;
  if (volSendTimer) return;
  api.media.cmd('volset', volPending);
  volPending = null;
  volSendTimer = setTimeout(() => {
    volSendTimer = null;
    if (volPending != null) {
      api.media.cmd('volset', volPending);
      volPending = null;
    }
  }, 90);
}

volBox.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!e.deltaY) return;
    nudgeVolume(e.deltaY < 0 ? VOL_STEP : -VOL_STEP);
  },
  { passive: false }
);

$('#vol-icon').addEventListener('click', () => {
  if (!volState.available) return;
  volState.muted = !volState.muted;
  paintVolume();
  api.media.cmd('mute', volState.muted);
});

// ============================================================
//  Yandex Music account: likes and dislikes
// ============================================================
const likeBtn = $('#like');
const dislikeBtn = $('#dislike');
const yaPanel = $('#ya-auth');

let yaStatus = { connected: false };
let lastTrack = null;
let yaTrack = { state: 'idle', liked: false, disliked: false };

function paintReactions() {
  const busy = yaTrack.state === 'resolving';
  const dead = !yaStatus.connected || yaTrack.state === 'unknown' || yaTrack.state === 'idle';

  likeBtn.classList.toggle('on', !!yaTrack.liked);
  dislikeBtn.classList.toggle('on', !!yaTrack.disliked);
  for (const b of [likeBtn, dislikeBtn]) {
    b.classList.toggle('pending', busy);
    b.classList.toggle('off', dead && !busy);
  }
  $('#like-use').setAttribute('href', yaTrack.liked ? '#i-heart-fill' : '#i-heart');

  const why = !yaStatus.connected
    ? 'Подключить Яндекс Музыку'
    : busy
      ? 'Ищем трек в Яндекс Музыке…'
      : yaTrack.state === 'unknown'
        ? 'Трек не найден в Яндекс Музыке'
        : null;
  likeBtn.title = why || (yaTrack.liked ? 'Убрать из избранного' : 'Нравится');
  dislikeBtn.title = why || (yaTrack.disliked ? 'Снять дизлайк' : 'Не нравится — не рекомендовать');
}

likeBtn.addEventListener('click', async () => {
  if (!yaStatus.connected) return openYa();
  const r = await api.ya.like();
  toast(r.ok ? (r.liked ? 'Добавлено в избранное' : 'Убрано из избранного') : r.error);
});

dislikeBtn.addEventListener('click', async () => {
  if (!yaStatus.connected) return openYa();
  const r = await api.ya.dislike();
  if (!r.ok) return toast(r.error);
  if (!r.disliked) return toast('Дизлайк снят');
  // Yandex skips a disliked track, and so do we.
  toast('Больше не рекомендовать');
  api.media.cmd('next');
});

api.ya.onStatus((st) => {
  yaStatus = st;
  paintReactions();
  paintYaPanel();
});

api.ya.onTrack((t) => {
  yaTrack = t;
  paintReactions();
});

// --- account panel ---------------------------------------------------------
function paintYaPanel() {
  $('#ya-connected').hidden = !yaStatus.connected;
  $('#ya-form').hidden = !!yaStatus.connected;
  $('#ya-login').textContent = yaStatus.login || 'аккаунт Яндекса';
  $('#ya-web').textContent = yaStatus.web
    ? 'Треки играют в панели целиком.'
    : 'Вход в плеер не выполнен — трек в панели оборвётся примерно через сорок секунд. Нажмите «Отключить аккаунт» и войдите заново, чтобы это починить.';
  $('#m-ya').textContent = yaStatus.connected ? 'подключено' : 'не подключено';
}

function yaMsg(text, kind) {
  const node = $('#ya-msg');
  node.textContent = text || '';
  node.className = kind || '';
}

function openYa() {
  paintYaPanel();
  yaMsg('');
  yaPanel.hidden = false;
  if (!yaStatus.connected) setTimeout(() => $('#ya-token').focus(), 40);
}

function closeYa() {
  yaPanel.hidden = true;
}

// Accepts the bare token or the whole redirect URL it arrives in.
function extractToken(raw) {
  const m = /access_token=([^&\s#]+)/.exec(raw);
  return (m ? m[1] : raw).trim();
}

async function saveYaToken() {
  const token = extractToken($('#ya-token').value);
  if (!token) return yaMsg('Вставьте токен', 'bad');
  yaMsg('Проверяем токен…');
  yaStatus = await api.ya.connect(token);
  paintYaPanel();
  paintReactions();
  if (yaStatus.connected) {
    $('#ya-token').value = '';
    yaMsg(`Готово — ${yaStatus.login || 'аккаунт подключён'}`, 'good');
  } else {
    yaMsg(yaStatus.error || 'Не удалось подключиться', 'bad');
  }
}

$('#ya-login-btn').addEventListener('click', async () => {
  const btn = $('#ya-login-btn');
  btn.disabled = true;
  yaMsg('Ждём окно входа…');
  yaStatus = await api.ya.login();
  btn.disabled = false;
  paintYaPanel();
  paintReactions();
  if (yaStatus.connected) yaMsg(`Готово — ${yaStatus.login || 'аккаунт подключён'}`, 'good');
  else if (yaStatus.cancelled) yaMsg('Вход отменён');
  else yaMsg(yaStatus.error || 'Не удалось войти', 'bad');
});

$('#ya-back').addEventListener('click', closeYa);
$('#ya-open').addEventListener('click', () => api.ya.openAuth());
$('#ya-save').addEventListener('click', saveYaToken);
$('#ya-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveYaToken();
});
$('#ya-forget').addEventListener('click', async () => {
  yaStatus = await api.ya.disconnect();
  paintYaPanel();
  paintReactions();
  yaMsg('Аккаунт отключён', 'good');
});

// --- track search ----------------------------------------------------------
const ymSearch = $('#ym-search');
const ymStrip = $('#ym-strip');
const playerCard = document.querySelector('.player');

let ymResults = [];

/** Only one of: the SMTC card, or the list of search results. */
function showMusicPane(pane) {
  playerCard.hidden = pane !== 'player';
  ymStrip.hidden = pane !== 'results';
  $('#np-app').hidden = pane !== 'player';
  $('#ym-clear').hidden = pane === 'player';
}

function showTrackResults(on) {
  showMusicPane(on ? 'results' : 'player');
}

const ymEngine = $('#ym-engine');

/**
 * Plays the chosen track and returns the panel to its usual controls.
 *
 * The sound comes from Yandex's own embedded player, parked off-screen: the
 * deep link into the desktop app only opens the track's page and waits for a
 * click, so it cannot start anything by itself. The embed registers a Windows
 * media session, which is how the buttons above keep working.
 */
async function playTrack(track) {
  showMusicPane('player');

  if (!track.albumId) {
    toast('Открываем в приложении');
    api.ya.play(track.id, track.albumId);
    return;
  }

  lastTrack = {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    artists: track.artists,
    cover: track.cover || null,
  };
  api.app.setSetting('lastTrack', lastTrack);

  api.media.cmd('pause'); // do not let the desktop player talk over it
  ymEngine.textContent = '';

  const frame = document.createElement('iframe');
  frame.allow = 'autoplay; encrypted-media';
  frame.src = `https://music.yandex.ru/iframe/track/${track.id}/${track.albumId}?autoplay=1`;
  ymEngine.append(frame);
  toast('Включаем…');
}

function clearTrackSearch() {
  ymResults = [];
  ymSearch.value = '';
  ymStrip.textContent = '';
  showMusicPane('player');
}

async function runTrackSearch() {
  const q = ymSearch.value.trim();
  if (!q) return clearTrackSearch();
  if (!yaStatus.connected) {
    toast('Сначала подключите аккаунт Яндекса');
    return openYa();
  }

  ymStrip.textContent = '';
  ymStrip.append(el('div', 'empty-inline', 'Ищем…'));
  showTrackResults(true);

  const res = await api.ya.searchTracks(q);
  ymStrip.textContent = '';
  if (!res || !res.ok) {
    ymStrip.append(el('div', 'empty-inline', (res && res.error) || 'Поиск не удался'));
    return;
  }
  ymResults = res.items;
  if (!ymResults.length) {
    ymStrip.append(el('div', 'empty-inline', 'Ничего не нашлось'));
    return;
  }

  for (const t of ymResults) {
    const row = el('div', 'trow');
    row.dataset.id = t.id;
    row.title = 'Включить в Яндекс Музыке';

    const cover = el('div', 'tcover');
    if (t.cover) cover.style.backgroundImage = `url("${t.cover}")`;
    row.append(cover);

    const info = el('div', 'tinfo');
    info.append(el('div', 'tname', t.title));
    info.append(el('div', 'tart', t.artists));
    row.append(info);

    if (t.liked) {
      const heart = svgIcon('heart-fill');
      heart.classList.add('theart');
      row.append(heart);
    }
    if (t.duration) row.append(el('div', 'tdur', t.duration));

    ymStrip.append(row);
  }
}

ymStrip.addEventListener('click', (e) => {
  const row = e.target.closest('.trow');
  if (!row) return;
  const track = ymResults.find((t) => t.id === row.dataset.id);
  if (!track) return;
  ymSearch.value = '';
  ymStrip.textContent = '';
  ymResults = [];
  playTrack(track);
});

ymSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runTrackSearch();
  if (e.key === 'Escape' && ymResults.length) {
    e.stopPropagation();
    clearTrackSearch();
  }
});

$('#ym-clear').addEventListener('click', clearTrackSearch);

// ============================================================
//  clipboard
// ============================================================
const clipStrip = $('#clip-strip');
const clipSearch = $('#clip-search');
let clipItems = [];

const CODE_HINT = /[{};()=><]|^\s{2,}\S|function |const |def |class |import /m;

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'только что';
  const date = new Date(ts);
  const hhmm = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return hhmm;
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (date.toDateString() === yest.toDateString()) return `вчера, ${hhmm}`;
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${hhmm}`;
}

const ARCHIVE = /\.(zip|rar|7z|tar|gz|bz2|xz|iso|cab)$/i;
const PICTURE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|heic)$/i;

function fileIcon(f) {
  if (f.dir) return 'folder';
  if (ARCHIVE.test(f.name)) return 'zip';
  if (PICTURE.test(f.name)) return 'image';
  return 'file';
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const humanBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`);

/** Pinned entries carry a star of their own; the action row only shows on hover. */
function pinFlag(chip, pinned) {
  if (!pinned) return;
  const flag = el('div', 'pin-flag');
  flag.append(svgIcon('star'));
  chip.append(flag);
}

function actionButtons(defs) {
  const acts = el('div', 'acts');
  for (const [act, icon, title, on] of defs) {
    const b = el('button', on ? 'on' : null);
    b.dataset.act = act;
    b.title = title;
    const svg = svgIcon(icon);
    svg.style.pointerEvents = 'none'; // clicks must land on the button itself
    b.append(svg);
    acts.append(b);
  }
  return acts;
}

async function loadClips() {
  clipItems = await api.clip.list();
  if (activeTab === 'clip') renderClips();
}

function renderClips() {
  const q = clipSearch.value.trim().toLowerCase();
  const items = q
    ? clipItems.filter((i) =>
        i.type === 'files'
          ? i.files.some((f) => f.name.toLowerCase().includes(q))
          : i.type === 'text' && (i.preview || '').toLowerCase().includes(q)
      )
    : clipItems;

  clipStrip.textContent = '';
  $('#clip-empty').style.display = items.length ? 'none' : '';

  for (const it of items) {
    const chip = el('div', `chip${it.pinned ? ' pinned' : ''}`);
    chip.dataset.id = it.id;
    pinFlag(chip, it.pinned);

    if (it.type === 'files') {
      chip.classList.add('files');
      const list = el('div', 'flist');
      for (const f of it.files.slice(0, 3)) {
        const row = el('div', `frow${f.dir ? ' dir' : ''}${f.missing ? ' gone' : ''}`);
        row.append(svgIcon(fileIcon(f)));
        const name = el('span', 'fname', f.name);
        name.title = f.name;
        row.append(name);
        list.append(row);
      }
      if (it.count > 3) list.append(el('div', 'fmore', `и ещё ${it.count - 3}`));
      chip.append(list);
    } else if (it.type === 'image') {
      const shot = el('div', 'shot');
      if (it.thumb) shot.style.backgroundImage = `url("${it.thumb}")`;
      chip.append(shot);
    } else if (it.kind === 'color') {
      const sw = el('div', 'swatch');
      sw.style.background = it.preview.trim();
      chip.append(sw);
    } else {
      const code = CODE_HINT.test(it.preview || '');
      chip.append(el('div', `txt${it.kind === 'url' ? ' url' : code ? ' mono' : ''}`, it.preview));
    }

    const foot = el('div', 'foot');
    const detail =
      it.type === 'image'
        ? `${timeAgo(it.ts)} · ${it.w}×${it.h}`
        : it.type === 'files'
          ? `${timeAgo(it.ts)} · ${plural(it.count, 'объект', 'объекта', 'объектов')}`
          : timeAgo(it.ts);
    foot.append(el('span', null, detail));
    foot.append(
      actionButtons([
        ['pin', 'star', it.pinned ? 'Открепить' : 'Закрепить', it.pinned],
        ['view', 'expand', 'Предпросмотр'],
        ['del', 'close', 'Удалить'],
      ])
    );
    chip.append(foot);

    clipStrip.append(chip);
  }
}

clipStrip.addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.id;
  const act = e.target.dataset.act;
  if (act === 'pin') return api.clip.pin(id);
  if (act === 'del') return api.clip.remove(id);
  if (act === 'view') return showPreview(id);
  toast((await api.clip.restore(id)) ? 'Скопировано' : 'Не удалось скопировать');
});

clipStrip.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  clipStrip.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

clipSearch.addEventListener('input', renderClips);
$('#clip-clear').addEventListener('click', () => {
  api.clip.clear();
  toast('Буфер очищен');
});

api.clip.onItems((items) => {
  clipItems = items;
  if (activeTab === 'clip') renderClips();
});

// --- preview overlay -------------------------------------------------------
let previewId = null;

async function showPreview(id) {
  const data = await api.clip.full(id);
  if (!data) return;
  previewId = id;
  const bodyEl = $('#pv-body');
  bodyEl.textContent = '';
  if (data.type === 'files') {
    for (const f of data.files) {
      const row = el('div', 'pv-file');
      row.append(svgIcon(fileIcon(f)));
      row.append(el('div', 'pv-path', f.path));
      row.append(el('div', 'pv-size', f.missing ? 'нет на диске' : f.dir ? 'папка' : humanBytes(f.size || 0)));
      bodyEl.append(row);
    }
    $('#pv-meta').textContent = plural(data.files.length, 'объект', 'объекта', 'объектов');
  } else if (data.type === 'image') {
    const img = el('img');
    img.src = data.dataUrl;
    bodyEl.append(img);
    $('#pv-meta').textContent = `${data.w}×${data.h} · ${humanBytes(data.bytes || 0)}`;
  } else {
    bodyEl.textContent = data.text;
    $('#pv-meta').textContent = `${data.text.length} символов`;
  }
  $('#preview').hidden = false;
}

function hidePreview() {
  $('#preview').hidden = true;
  previewId = null;
}

$('#pv-back').addEventListener('click', hidePreview);
$('#pv-copy').addEventListener('click', async () => {
  if (!previewId) return;
  await api.clip.restore(previewId);
  toast('Скопировано');
});

// ============================================================
//  notes
// ============================================================
const noteStrip = $('#note-strip');
const noteSearch = $('#note-search');
const noteQuick = $('#note-quick');
const noteEditor = $('#note-editor');
const noteText = $('#note-text');

const NOTE_TINTS = ['#f6e7a8', '#cadcf1', '#cbe9d3', '#f2d7cd', '#ded3f0'];
const tintFor = (id) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return NOTE_TINTS[h % NOTE_TINTS.length];
};

let noteItems = [];
let editingId = null;
let saveTimer = null;

async function loadNotes() {
  noteItems = await api.notes.list();
  if (activeTab === 'notes') renderNotes();
}

function renderNotes() {
  const q = noteSearch.value.trim().toLowerCase();
  const items = q ? noteItems.filter((n) => (n.text || '').toLowerCase().includes(q)) : noteItems;

  noteStrip.textContent = '';
  $('#note-empty').style.display = items.length ? 'none' : '';

  for (const n of items) {
    const chip = el('div', `chip note${n.pinned ? ' pinned' : ''}`);
    chip.dataset.id = n.id;
    chip.style.background = tintFor(n.id);
    pinFlag(chip, n.pinned);

    chip.append(el('div', 'title', (n.title || '').trim() || 'Без заголовка'));
    const rest = (n.text || '').split('\n').slice(1).join('\n').trim();
    chip.append(el('div', 'txt', rest));

    const foot = el('div', 'foot');
    foot.append(el('span', null, timeAgo(n.updated)));
    foot.append(
      actionButtons([
        ['pin', 'star', n.pinned ? 'Открепить' : 'Закрепить', n.pinned],
        ['del', 'close', 'Удалить'],
      ])
    );
    chip.append(foot);

    noteStrip.append(chip);
  }
}

noteStrip.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const id = chip.dataset.id;
  const act = e.target.dataset.act;
  if (act === 'pin') return api.notes.pin(id);
  if (act === 'del') return api.notes.remove(id);
  openNote(id);
});

noteStrip.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  noteStrip.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

noteSearch.addEventListener('input', renderNotes);

function growQuick() {
  noteQuick.style.height = 'auto';
  noteQuick.style.height = `${Math.min(88, Math.max(34, noteQuick.scrollHeight))}px`;
}

noteQuick.addEventListener('input', growQuick);

noteQuick.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  e.preventDefault();
  const text = noteQuick.value.trim();
  if (!text) return;
  noteQuick.value = '';
  growQuick();
  // The store pushes the new list back through notes.onItems; adding it here
  // too is what produced a second copy of every note.
  await api.notes.create(text);
  toast('Заметка сохранена');
});

function openNote(id) {
  const note = noteItems.find((n) => n.id === id);
  if (!note) return;
  editingId = id;
  noteText.value = note.text || '';
  $('#note-stamp').textContent = `изменено ${timeAgo(note.updated)}`;
  $('#note-pin').classList.toggle('on', !!note.pinned);
  noteEditor.hidden = false;
  setTimeout(() => noteText.focus(), 30);
}

function flushNote() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (editingId) api.notes.update(editingId, noteText.value);
}

function closeNote() {
  flushNote();
  editingId = null;
  noteEditor.hidden = true;
  loadNotes();
}

noteText.addEventListener('input', () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNote, 350);
});

$('#note-back').addEventListener('click', closeNote);
$('#note-del').addEventListener('click', () => {
  if (!editingId) return;
  const id = editingId;
  editingId = null;
  if (saveTimer) clearTimeout(saveTimer);
  api.notes.remove(id);
  noteEditor.hidden = true;
});
$('#note-pin').addEventListener('click', () => {
  if (!editingId) return;
  api.notes.pin(editingId);
  $('#note-pin').classList.toggle('on');
});

api.notes.onItems((items) => {
  noteItems = items;
  if (activeTab === 'notes' && noteEditor.hidden) renderNotes();
});

// ============================================================
//  youtube
// ============================================================
const ytStrip = $('#yt-strip');
const ytSearchBox = $('#yt-search');
const ytPlayer = $('#yt-player');
const ytFrame = $('#yt-frame');

const YT_ORIGIN = 'https://www.youtube.com';

let ytOrigin = null; // the loopback origin the panel itself is served from
let ytResults = [];
let ytCurrent = null;
let ytPlaying = false;

function ytMsg(text) {
  const node = $('#yt-empty');
  node.textContent = text || '';
  node.style.display = text ? '' : 'none';
}

async function runYtSearch() {
  const q = ytSearchBox.value.trim();
  if (!q) return;
  ytStrip.textContent = '';
  ytMsg('Ищем…');

  const res = await api.yt.search(q);
  if (!res || !res.ok) {
    ytResults = [];
    ytMsg((res && res.error) || 'Поиск не удался');
    return;
  }
  ytResults = res.items;
  renderYt();
}

function renderYt() {
  ytStrip.textContent = '';
  if (!ytResults.length) {
    ytMsg('Ничего не нашлось');
    return;
  }
  ytMsg('');

  for (const v of ytResults) {
    const chip = el('div', 'chip video');
    chip.dataset.id = v.id;

    const cover = el('div', 'cover');
    cover.style.backgroundImage = `url("${v.thumb}")`;
    if (v.live) cover.append(el('div', 'len live', 'прямой эфир'));
    else if (v.duration) cover.append(el('div', 'len', v.duration));
    chip.append(cover);

    const title = el('div', 'vtitle', v.title);
    chip.title = [v.title, v.channel, v.views].filter(Boolean).join(' · ');
    chip.append(title);

    ytStrip.append(chip);
  }
}

ytStrip.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const item = ytResults.find((v) => v.id === chip.dataset.id);
  if (item) playYt(item);
});

ytStrip.addEventListener(
  'wheel',
  (e) => {
    if (!e.deltaY) return;
    ytStrip.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false }
);

ytSearchBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runYtSearch();
});
$('#yt-go').addEventListener('click', runYtSearch);

// --- the embedded player ---------------------------------------------------
function playYt(item) {
  ytCurrent = item;
  stopYtFrame();

  const frame = document.createElement('iframe');
  frame.allow = 'autoplay; encrypted-media';
  frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
  const params = new URLSearchParams({
    autoplay: '1',
    enablejsapi: '1',
    playsinline: '1',
    rel: '0',
    modestbranding: '1',
  });
  // The embed refuses to run for a null origin, which is why the panel is
  // served over loopback; hand YouTube that same origin.
  if (ytOrigin) params.set('origin', ytOrigin);
  frame.src = `${YT_ORIGIN}/embed/${item.id}?${params.toString()}`;

  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'vidget' }), YT_ORIGIN);
    } catch {
      /* the frame may already be gone */
    }
  });

  ytFrame.insertBefore(frame, $('#yt-click'));
  ytPlaying = true;
  ytPlayer.hidden = false;
  setText($('#yt-title'), item.title);
  $('#yt-channel').textContent = [item.channel, item.duration].filter(Boolean).join(' · ');
  paintYtControls();
}

function stopYtFrame() {
  const frame = ytFrame.querySelector('iframe');
  if (frame) frame.remove(); // the only way to be sure the sound stops
  ytPlaying = false;
}

function stopYt() {
  stopYtFrame();
  ytCurrent = null;
  ytPlayer.hidden = true;
}

function ytCommand(func) {
  const frame = ytFrame.querySelector('iframe');
  if (!frame) return;
  try {
    frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), YT_ORIGIN);
  } catch {
    /* nothing to control */
  }
}

function paintYtControls() {
  $('#yt-play-use').setAttribute('href', ytPlaying ? '#i-pause' : '#i-play');
  $('#yt-play').title = ytPlaying ? 'Пауза' : 'Продолжить';
}

$('#yt-play').addEventListener('click', () => {
  ytCommand(ytPlaying ? 'pauseVideo' : 'playVideo');
  ytPlaying = !ytPlaying;
  paintYtControls();
});

$('#yt-stop').addEventListener('click', stopYt);

const openCurrentInBrowser = () => {
  if (ytCurrent) api.yt.open(ytCurrent.id);
};

$('#yt-click').addEventListener('click', openCurrentInBrowser);
$('#yt-browser').addEventListener('click', openCurrentInBrowser);

// The player reports its own state; keep our button honest when the video
// ends or buffers on its own.
window.addEventListener('message', (e) => {
  if (e.origin !== YT_ORIGIN) return;
  let msg;
  try {
    msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  if (!msg || msg.event !== 'onStateChange') return;
  ytPlaying = msg.info === 1 || msg.info === 3;
  paintYtControls();
});

// ============================================================
//  menu, toast, keys
// ============================================================
const menu = $('#menu');
const closeMenu = () => {
  menu.hidden = true;
};

$('#menu-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const s = await api.app.settings();
  $('#m-autostart').textContent = s.autostart ? 'вкл' : 'выкл';
  $('#m-launch').textContent = s.launchPlayer === false ? 'выкл' : 'вкл';
  paintYaPanel();
  menu.hidden = !menu.hidden;
});

menu.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (act === 'quit') return api.app.quit();
  if (act === 'yandex') {
    closeMenu();
    return openYa();
  }
  if (act === 'launchPlayer') {
    const s = await api.app.settings();
    const next = await api.app.setSetting('launchPlayer', s.launchPlayer === false);
    $('#m-launch').textContent = next.launchPlayer === false ? 'выкл' : 'вкл';
    return;
  }
  if (act === 'autostart') {
    const s = await api.app.settings();
    const next = await api.app.setSetting('autostart', !s.autostart);
    $('#m-autostart').textContent = next.autostart ? 'вкл' : 'выкл';
    toast(next.autostart ? 'Автозапуск включён' : 'Автозапуск выключен');
  }
});

document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'menu-btn') closeMenu();
});

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#preview').hidden) return hidePreview();
    if (!yaPanel.hidden) return closeYa();
    if (!noteEditor.hidden) return closeNote();
    if (!menu.hidden) return closeMenu();
    return api.ui.requestClose();
  }
  if (e.ctrlKey && (e.key === 'f' || e.key === 'а')) {
    const box = {
      music: '#ym-search',
      clip: '#clip-search',
      yt: '#yt-search',
      notes: '#note-search',
    }[activeTab];
    const node = box && $(box);
    if (node) {
      node.focus();
      node.select();
      e.preventDefault();
    }
    return;
  }
  if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
    const name = tabOrder()[Number(e.key) - 1];
    if (name) {
      selectTab(name);
      e.preventDefault();
    }
  }
});

window.addEventListener('beforeunload', flushNote);

// ============================================================
//  boot
// ============================================================
async function refreshAll() {
  const snap = await api.media.snapshot();
  if (snap) {
    applyState(snap.state);
    setArt(snap.art && snap.art.data);
    if (snap.vol) {
      volState = { available: snap.vol.available !== false, value: snap.vol.value ?? 0, muted: !!snap.vol.muted };
      paintVolume();
    }
  }
  loadClips();
  loadNotes();

  yaStatus = await api.ya.status();
  yaTrack = await api.ya.track();
  paintYaPanel();
  paintReactions();
}

(async function boot() {
  ytOrigin = await api.yt.origin();
  const s = await api.app.settings();
  lastTrack = s.lastTrack || null;
  applyTabOrder(s.tabOrder);
  selectTab(s.tab || 'music');
  paintVolume();
  await refreshAll();
})();
