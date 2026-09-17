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

// Kept in step with the main process, which measures the display; the value
// here is only the starting point until the first message arrives.
let PANEL_H = 288;
const OPEN_THRESHOLD = 70;

// Which edge of the screen the strip lives on, and where on the window it and
// the panel sit. The main process works this out; the panel only draws it.
const layout = {
  edge: 'top',
  handle: { x: 0, y: 0 },
  panelRect: { x: 0, y: 0, width: 980, height: 288 },
  karaoke: { width: 420, height: 594 },
  window: { width: 980, height: 356 },
};
const isSideEdge = () => layout.edge === 'left' || layout.edge === 'right';

/**
 * One row of buttons on the phone-shaped panel, with play in the middle.
 *
 * The reactions and the speaker live in their own places in the wide panel.
 * CSS cannot move an element into another box, so here they are carried into
 * the two sides of the play row, and carried back when the panel turns wide.
 */
const playerHome = {};
function arrangePlayer(portrait) {
  const reactions = document.querySelector('#reactions');
  const vol = document.querySelector('#vol');
  const left = document.querySelector('.ctl-side.left');
  const right = document.querySelector('.ctl-side.right');
  if (!reactions || !vol || !left || !right) return;
  if (!playerHome.reactions) {
    playerHome.reactions = document.createComment('reactions');
    reactions.before(playerHome.reactions);
    playerHome.vol = document.createComment('vol');
    vol.before(playerHome.vol);
  }
  if (portrait) {
    if (reactions.parentElement !== left) left.prepend(reactions);
    if (vol.parentElement !== right) right.append(vol);
  } else {
    if (reactions.parentElement === left) playerHome.reactions.after(reactions);
    if (vol.parentElement === right) playerHome.vol.after(vol);
    vol.classList.remove('open', 'held');
  }
}

// How far the shade travels to open: its height when it drops from the top or
// rises from the bottom, its width when it slides out of a side.
const pullSpan = () => (isSideEdge() ? layout.panelRect.width : PANEL_H);

/** Distance the hand has moved in the direction that opens the shade. */
function pullDelta(dx, dy) {
  if (layout.edge === 'bottom') return -dy;
  if (layout.edge === 'left') return dx;
  if (layout.edge === 'right') return -dx;
  return dy;
}

/** Distance moved along the edge — the direction that slides the strip. */
const alongDelta = (dx, dy) => (isSideEdge() ? dy : dx);

function applyShadeSize(size) {
  if (!size || !size.shade) return;
  PANEL_H = size.shade;
  const root = document.documentElement.style;

  const edgeChanged = size.edge && size.edge !== layout.edge;
  if (size.edge) layout.edge = size.edge;
  if (size.handle) layout.handle = size.handle;
  if (size.panelRect) layout.panelRect = size.panelRect;
  if (size.karaoke) layout.karaoke = size.karaoke;
  if (size.window) layout.window = size.window;

  // On a side the panel is a phone-sized screen of its own height; on the top
  // and bottom it is the shade, as tall as the display allows.
  const portrait = isSideEdge();
  if (portrait) PANEL_H = layout.panelRect.height;
  root.setProperty('--panel-h', `${PANEL_H}px`);
  document.body.classList.toggle('portrait', portrait);
  arrangePlayer(portrait);
  root.setProperty('--panel-w', `${layout.panelRect.width}px`);
  root.setProperty('--panel-x', `${layout.panelRect.x}px`);
  root.setProperty('--panel-y', `${layout.panelRect.y}px`);
  root.setProperty('--karaoke-w', `${layout.karaoke.width}px`);
  root.setProperty('--karaoke-h', `${layout.karaoke.height}px`);

  for (const edge of ['top', 'bottom', 'left', 'right']) {
    document.body.classList.toggle(`edge-${edge}`, layout.edge === edge);
  }
  placeHandle();
  // The words scroll differently on a side, so start them afresh there.
  if (edgeChanged && typeof paintLyrics === 'function') {
    words.shown = -2;
    paintLyrics();
  }
}

const body = document.body;
const handle = $('#handle');
const panel = $('#panel');

// ============================================================
//  the shade: hover, pull, open, close
// ============================================================
let isOpen = false;
let drag = null;
// A message that arrived while the shade was rolled up, waiting for a panel to
// sit under.
let heldToast = null;

// How far the hand has to travel before a drag off the handle commits to being
// a pull down or a slide sideways.
const AXIS_THRESHOLD = 6;

// The main process owns hover detection: it watches the real cursor and hands
// the mouse to this window only while the pointer is over the handle.
api.ui.onSize(applyShadeSize);

api.ui.onHover((on) => {
  if (isOpen || drag) return;
  body.classList.toggle('hover', on);
});

const setPull = (px) => panel.style.setProperty('--pull', `${px}px`);

function beginDrag(e, from) {
  // A drag off the grip can only be a pull; one off the handle is undecided —
  // it may turn out to be a sideways move of the whole strip.
  drag = { startX: e.screenX, startY: e.screenY, moved: 0, from, mode: from === 'grip' ? 'pull' : null };
  body.classList.remove('animating');
  if (from === 'grip') body.classList.add('dragging');
  else {
    // Hold the mouse without committing to anything: the cursor watch would
    // otherwise hand it straight back the moment the pointer left the handle.
    api.ui.grab();
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
  const dy = e.screenY - drag.startY;
  const dx = e.screenX - drag.startX;

  // Whichever way the hand went first is what the gesture means: away from the
  // edge pulls the shade out, along the edge slides the strip — round corners
  // and onto other monitors too, following the cursor.
  const pull = pullDelta(dx, dy);
  const along = alongDelta(dx, dy);
  if (!drag.mode) {
    if (Math.abs(along) > AXIS_THRESHOLD && Math.abs(along) > Math.abs(pull)) {
      drag.mode = 'move';
      body.classList.add('moving');
      api.ui.moveStart(e.screenX, e.screenY);
    } else if (Math.abs(pull) > AXIS_THRESHOLD) {
      drag.mode = 'pull';
      body.classList.add('dragging');
      api.ui.prepare(); // take the mouse and let the shade slide
    } else {
      return; // too small to mean anything yet
    }
  }

  if (drag.mode === 'move') {
    api.ui.move(e.screenX, e.screenY);
    return;
  }

  drag.moved = Math.max(drag.moved, Math.abs(pull));
  const span = pullSpan();
  const base = drag.from === 'handle' ? 0 : span;
  if (drag.from === 'grip') body.classList.remove('open');
  setPull(Math.max(0, Math.min(span, base + pull)));
});

document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { from, moved, mode } = drag;
  const delta = pullDelta(e.screenX - drag.startX, e.screenY - drag.startY);
  drag = null;
  body.classList.remove('dragging', 'moving');

  if (mode === 'move') {
    // The strip was moved, not opened: hand the mouse back to the desktop.
    api.ui.moveEnd();
    api.ui.release();
    return;
  }

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
  resumeVaultPlace();
  body.classList.remove('hover');
  body.classList.add('animating', 'open');
  setPull(0);
  paintLyrics();
  refreshAll();
  // Anything that happened behind a closed shade gets said now, once there is
  // a panel for it to sit under.
  if (heldToast) {
    const held = heldToast;
    heldToast = null;
    setTimeout(() => toast(held), 500);
  }
});

api.ui.onClose(() => {
  isOpen = false;
  body.classList.add('animating');
  body.classList.remove('open');
  setPull(0);
  paintLyrics();
  hidePreview();
  closeYa();
  closeSettings();
  closeMenu();
  closeVaultMenu();
  // Where the user was among the passwords is kept for a few minutes: the
  // usual round trip is to copy the login, paste it, and come back for the
  // password — landing at the top of the list again would mean hunting for
  // the same entry twice. What was revealed is hidden again at once, though.
  keepVaultPlace();
  $('#vault-password').value = '';
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
  if (name === 'vault') loadVault();
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
      useCover(lastTrack.cover);
    } else {
      setText(titleBox, 'Моя волна');
      setText(artistBox, 'нажмите ▶, чтобы включить');
      appBox.textContent = '';
      $('#art-letter').textContent = '♫';
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
    // Whatever is playing now is what the panel should offer to resume after a
    // restart — even when it played somewhere else entirely.
    rememberTrack({ title: s.title, artists: s.artist });
    artState.ya = null; // the new track's cover has not arrived yet
    setText(titleBox, s.title || 'Без названия');
    setText(artistBox, s.artist || '');
    $('#art-letter').textContent = (s.title || '♫').trim().charAt(0).toUpperCase() || '♫';
  }
  const ours = s.app === 'com.vidget.overlay' || s.app === 'electron.exe';
  appBox.textContent = ours && wave.on ? 'Моя волна' : APP_NAMES[s.app] || s.app || '';
  updateButtons();
}

function updateButtons() {
  const can = mediaState.can || {};
  const playing = mediaState.status === 'Playing';
  const play = $('#play');
  $('#play-use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  play.disabled = !mediaState.active && !lastTrack && !yaStatus.connected;
  // Our own queue is ours to steer, whatever the system session reports.
  const steering = wave.on && ownActive();
  $('#prev').disabled = !can.prev && !(steering && wave.history.length);
  $('#next').disabled = !can.next && !steering;

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
  // The words are followed whether or not the panel is open — the whole point
  // is singing along while working, with the shade shut.
  paintLyrics();

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
  if (ownActive()) {
    if (audio.paused) audio.play().catch(() => toast('Трек не запустился'));
    else audio.pause();
    return;
  }
  if (!mediaState.active) {
    // An unfinished track gets picked up first; after it the wave takes over.
    return lastTrack ? resumeLastTrack() : startWave();
  }
  api.media.cmd('playpause');
});

/** Merges what we learn about the current track into the one we can resume. */
function rememberTrack(patch) {
  const same = lastTrack && (!patch.title || patch.title === lastTrack.title);
  lastTrack = same ? { ...lastTrack, ...patch } : { ...patch };
  api.app.setSetting('lastTrack', lastTrack);
}

/**
 * Starts the remembered track in the widget's own player. If it was never
 * resolved to a Yandex id — the widget was restarted before that happened —
 * look it up now by title and artist.
 */
async function resumeLastTrack() {
  if (lastTrack.id && lastTrack.albumId) return playTrack(lastTrack);

  if (!yaStatus.connected) {
    toast('Сначала подключите аккаунт Яндекса');
    return openYa();
  }

  toast('Ищем трек…');
  const query = [lastTrack.artists, lastTrack.title].filter(Boolean).join(' ');
  const res = await api.ya.searchTracks(query);
  const hit = res && res.ok && res.items[0];
  if (!hit || !hit.albumId) {
    toast('Трек не найден, включаем волну');
    return startWave();
  }

  rememberTrack({ id: hit.id, albumId: hit.albumId, cover: hit.cover });
  playTrack(lastTrack);
}
// The wave is ours to steer: Windows has no next/previous to offer for the
// embedded player, so these drive the queue directly.
$('#next').addEventListener('click', () => {
  if (wave.on && ownActive()) return advanceWave();
  api.media.cmd('next');
});

$('#prev').addEventListener('click', () => {
  if (wave.on && ownActive() && wave.history.length) return goBack();
  api.media.cmd('prev');
});
$('#shuffle').addEventListener('click', () => api.media.cmd('shuffle', !mediaState.shuffle));
$('#repeat').addEventListener('click', () => {
  if (ownActive()) {
    own.repeat = own.repeat === 'Track' ? 'None' : 'Track';
    pushOwnState();
    return;
  }
  const order = { None: 'List', List: 'Track', Track: 'None' };
  api.media.cmd('repeat', order[mediaState.repeat] || 'List');
});

function ratioFrom(track, e) {
  const r = track.getBoundingClientRect();
  // The volume slider stands upright on the phone-shaped panel: up is louder.
  if (r.height > r.width * 2) return Math.max(0, Math.min(1, (r.bottom - e.clientY) / r.height));
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
  if (ownActive()) audio.currentTime = pos;
  else api.media.cmd('seek', pos);
});

// While we are the one making the sound, SMTC only echoes us back — with a
// lag, and through a PowerShell sidecar. Our own player is the better witness.
api.media.onState((s) => {
  smtcState = s || { active: false };
  if (!ownActive()) applyState(smtcState);
});

// Two sources: whatever SMTC publishes, and the cover the Yandex API returns
// for the resolved track. SMTC wins when it has one; the Yandex player has none.
const artState = { smtc: null, ya: null };

function paintArt() {
  const url = artState.smtc || artState.ya;
  artBox.style.backgroundImage = url ? `url("${url}")` : '';
  artBox.classList.toggle('has-art', !!url);
}

/** A remembered cover is a plain URL and may be stale; check it before use. */
function useCover(url) {
  artState.ya = null;
  paintArt();
  if (!url) return;
  const probe = new Image();
  probe.onload = () => {
    artState.ya = url;
    paintArt();
  };
  probe.src = url;
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
  // One number drives both shapes: width and left in a row, height and bottom
  // when the slider stands upright.
  volBox.style.setProperty('--vol', `${pct}%`);
  $('#vol-pct').textContent = String(Math.round(pct));
  $('#vol-use').setAttribute('href', volState.muted || volState.value < 0.01 ? '#i-mute' : '#i-vol');
  volBox.classList.toggle('off', !volState.available);
}

function applyVol(v) {
  if (!v) return;
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
}

api.media.onVol(applyVol);

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
  volBox.classList.remove('held');
});

volTrack.addEventListener('pointerdown', () => volBox.classList.add('held'));

// On the phone-shaped panel the slider is a bubble over the speaker. It opens
// under the cursor and stays while the hand is on it or dragging; the speaker
// itself still mutes on click, as everywhere else.
let volCloseTimer = null;
volBox.addEventListener('pointerenter', () => {
  if (volCloseTimer) clearTimeout(volCloseTimer);
  volBox.classList.add('open');
});
volBox.addEventListener('pointerleave', () => {
  if (volCloseTimer) clearTimeout(volCloseTimer);
  volCloseTimer = setTimeout(() => {
    if (!volBox.classList.contains('held')) volBox.classList.remove('open');
  }, 350);
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

// Liking is one click; taking a favourite away is two. A heart sits where the
// hand goes for play and next, and a stray click used to quietly drop a track
// out of the collection.
let unlikeArmed = null;
likeBtn.addEventListener('click', async () => {
  if (!yaStatus.connected) return openYa();
  if (yaTrack.liked && unlikeArmed !== yaTrack.id) {
    unlikeArmed = yaTrack.id;
    likeBtn.classList.add('armed');
    toast('Уже в избранном. Нажмите ещё раз, чтобы убрать');
    setTimeout(() => {
      unlikeArmed = null;
      likeBtn.classList.remove('armed');
    }, 3000);
    return;
  }
  unlikeArmed = null;
  likeBtn.classList.remove('armed');
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
  // Once the track is resolved we know how to start it again by ourselves.
  if (t.id && t.albumId) rememberTrack({ id: t.id, albumId: t.albumId, cover: t.cover });
  paintReactions();
});

// --- account panel ---------------------------------------------------------
function paintYaPanel() {
  $('#ya-connected').hidden = !yaStatus.connected;
  $('#ya-form').hidden = !!yaStatus.connected;
  $('#ya-login').textContent = yaStatus.login || 'аккаунт Яндекса';
  // The panel plays the track itself now, straight from a link the API signs,
  // so a browser session is no longer part of making sound.
  $('#ya-web').textContent = 'Панель играет треки сама — приложение Яндекс Музыки для этого не нужно.';
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

// --- the widget's own player -------------------------------------------------
// Sound used to come from Yandex's embedded page, parked off-screen. That page
// loads its player from a host this connection cannot reach, so it arrived
// empty and silent — and even when it worked, it reported nothing about
// itself, which is why the wave had to guess from silence when a track ended.
// Now the panel plays the track itself and simply knows.
const audio = $('#ym-audio');

// Anything the widget starts rolls on into Моя волна when it ends.
const wave = { on: false, current: null, history: [], busy: false };

// The track loaded into our own player, or null when the panel is only acting
// as a remote for somebody else's.
// repeat is 'None' or 'Track'. A wave has no list to loop, so the middle rung
// of the usual three-way cycle would be a button that promises nothing.
const own = { track: null, failures: 0, repeat: 'None' };
const ownActive = () => !!own.track;

// The last thing SMTC said, so the panel can fall back to it once our own
// player stops.
let smtcState = { active: false };

// --- the words ---------------------------------------------------------------
// Two lines at a time: the one being sung and the one about to be. More than
// that is a lyrics sheet, and somebody working with music on does not read a
// sheet — they glance.
const lyricsBox = $('#lyrics');
const lyricsDock = $('#lyrics-dock');
const lyricReel = $('#lyric-reel');
const lyricsBtn = $('#lyrics-btn');

const words = { on: false, trackId: null, lines: null, shown: -2, handleH: '', mode: '' };

/** Only tracks Yandex has timed words for can offer the button at all. */
function paintLyricsButton() {
  const offered = !!(own.track && own.track.lyrics);
  lyricsBtn.hidden = !offered;
  lyricsBtn.classList.toggle('on', words.on);
  lyricsBtn.title = words.on ? 'Скрыть текст песни' : 'Показать текст песни';
}

/** Fetches the words for the track now playing, if they are wanted. */
async function loadLyrics(track) {
  words.lines = null;
  words.shown = -2;
  api.ya.setLines(null);
  buildReel(null);
  paintLyrics();

  if (!words.on || !track || !track.lyrics) return;
  words.trackId = track.id;

  const res = await api.ya.lyrics(track.id);
  if (words.trackId !== track.id) return; // moved on while we were asking
  if (!res || !res.ok) {
    // Nothing to sing along to is not worth a toast on every track; the button
    // going quiet says it well enough.
    words.lines = null;
    api.ya.setLines(null);
  } else {
    words.lines = res.lines;
    api.ya.setLines(res.lines);
  }
  buildReel(words.lines);
  paintLyrics();
}

/**
 * Puts the reel where it belongs for the state the shade is in.
 *
 * The same node moves rather than a second copy being kept in step: one text,
 * one place it is written, wherever that place happens to be.
 */
function dockLyrics() {
  const home = isOpen ? lyricsBox : lyricsDock;
  if (lyricReel.parentElement !== home) home.append(lyricReel);
}

/** Builds the reel: every line of the song, stacked, ready to slide. */
function buildReel(lines) {
  lyricReel.textContent = '';
  if (!lines) return;
  for (const line of lines) lyricReel.append(el('div', 'lyric', line.text));
  // A fresh reel starts at the top with no animation, or it would fly in from
  // wherever the last song happened to be.
  lyricReel.style.transition = 'none';
  lyricReel.style.transform = 'translateY(0)';
  void lyricReel.offsetHeight; // let the browser take that before we re-enable
  lyricReel.style.transition = '';
}

/**
 * Tells the main process which part of the window the strip covers.
 *
 * Outside that rectangle the window is click-through, so without this a plate
 * would be a picture you cannot grab. A long plate only takes the mouse along
 * a band as long as the plain tab, centred on the strip: the rest of the words
 * hang over the desktop, readable, while what is behind them still clicks.
 */
function reportHandleHeight() {
  const box = handle.getBoundingClientRect();
  const side = isSideEdge();
  const BAND = 260;
  let x = box.left;
  let y = box.top;
  let w = box.width;
  let h = box.height;
  if (!side && w > BAND) {
    x = Math.max(box.left, Math.min(box.right - BAND, layout.handle.x - BAND / 2));
    w = BAND;
  } else if (side && h > BAND) {
    y = Math.max(box.top, Math.min(box.bottom - BAND, layout.handle.y - BAND / 2));
    h = BAND;
  }
  const zone = { x: Math.round(x), y: Math.round(y), width: Math.ceil(w), height: Math.ceil(h) };
  const key = `${zone.x},${zone.y},${zone.width},${zone.height}`;
  if (key === words.handleH) return;
  words.handleH = key;
  api.ui.grabZone(zone);
}

/**
 * Sets the strip where the main process says its centre is, kept inside the
 * window. Near a corner a wide plate cannot be centred on the strip, so it
 * shifts inwards and the grab bar slides along it to stay under the hand.
 */
function placeHandle() {
  if (!handle) return;
  const W = layout.window.width;
  const H = layout.window.height;
  const w = handle.offsetWidth;
  const h = handle.offsetHeight;
  const clampTo = (v, max) => Math.max(0, Math.min(Math.max(0, max), v));
  let left;
  let top;
  if (layout.edge === 'left' || layout.edge === 'right') {
    left = layout.edge === 'left' ? 0 : W - w;
    // A tall plate keeps the same margin as the phone panel, so its corners
    // and shadow do not run into the end of the window.
    const m = Math.max(0, Math.min(24, (H - h) / 2));
    top = m + clampTo(layout.handle.y - h / 2 - m, H - h - 2 * m);
  } else {
    left = clampTo(layout.handle.x - w / 2, W - w);
    top = layout.edge === 'top' ? 0 : H - h;
  }
  handle.style.transform = 'none';
  handle.style.left = `${Math.round(left)}px`;
  handle.style.top = `${Math.round(top)}px`;
  handle.style.setProperty('--bar-x', `${Math.round(layout.handle.x - left)}px`);
  handle.style.setProperty('--bar-y', `${Math.round(layout.handle.y - top)}px`);
  if (typeof words !== 'undefined') reportHandleHeight();
}

// The strip changes size on its own — hover, the words coming and going — and
// has to be re-centred and re-reported every time it does.
new ResizeObserver(() => placeHandle()).observe(handle);

// In the karaoke column the reel is moved by where lines really start, and that
// changes while the plate is still unfolding from the narrow tab: measured then,
// lines wrap a word at a time and the reel flies thousands of pixels off. Measure
// again whenever the column settles into a new size.
new ResizeObserver(() => {
  if (words.mode !== 'karaoke') return;
  words.shown = -2;
  paintLyrics();
}).observe(lyricsDock);

function paintLyrics() {
  const showing = !!(words.on && words.lines && words.lines.length);
  dockLyrics();
  // One of the two is always the wrong place to be, so exactly one shows.
  lyricsBox.hidden = !showing || !isOpen;
  lyricsDock.hidden = !showing || isOpen;
  body.classList.toggle('has-lyrics', showing);
  if (!showing) {
    words.shown = -2;
    reportHandleHeight();
    return;
  }
  reportHandleHeight();

  // Our own player knows exactly where it is; the extrapolated clock is only
  // for somebody else's playback, which has no words here anyway.
  const pos = ownActive() ? audio.currentTime : currentPos();
  const i = api.ya.lineAt(pos);
  // On a side edge the closed strip is a karaoke column: lines wrap, so the
  // reel is moved by where a line really starts rather than by a fixed height.
  const mode = isSideEdge() && !isOpen ? 'karaoke' : 'lines';
  if (i === words.shown && mode === words.mode) return;
  words.mode = mode;

  const rows = lyricReel.children;
  const was = rows[words.shown];
  if (was) was.classList.remove('is-now');
  words.shown = i;

  // -1 is the intro: the reel drops by one so the top slot is empty and the
  // first line waits below, which is exactly what a singer wants to see.
  if (mode === 'karaoke') {
    // One sung line stays in view above the current one, the rest of the song
    // runs on below it.
    const anchor = rows[Math.max(0, i - 1)];
    const offset = anchor && rows[0] ? anchor.offsetTop - rows[0].offsetTop : 0;
    lyricReel.style.transform = `translateY(${-offset}px)`;
  } else {
    lyricReel.style.transform = `translateY(calc(var(--lyric-h) * ${-i}))`;
  }

  for (let n = 0; n < rows.length; n++) rows[n].classList.toggle('is-past', n < i);
  if (rows[i]) rows[i].classList.add('is-now');
}

lyricsBtn.addEventListener('click', () => {
  words.on = !words.on;
  api.app.setSetting('lyrics', words.on);
  paintLyricsButton();
  if (words.on) loadLyrics(own.track);
  else {
    words.lines = null;
    api.ya.setLines(null);
    buildReel(null);
    paintLyrics();
  }
});

/**
 * Publishes our player in the same shape the SMTC bridge uses.
 *
 * Everything above — the title, the seek bar, the clock, the buttons — was
 * written against that shape, so speaking it means none of it has to change.
 */
function pushOwnState() {
  const t = own.track;
  if (!t) return;
  applyState({
    active: true,
    app: 'com.vidget.overlay',
    key: `own|${t.id}`,
    title: t.title,
    artist: t.artists,
    status: audio.paused ? 'Paused' : 'Playing',
    position: audio.currentTime || 0,
    duration: audio.duration || (t.durationMs || 0) / 1000,
    // Ours to do, all of it: the queue is right here.
    can: { next: true, prev: true, seek: true, shuffle: false, repeat: true },
    repeat: own.repeat,
    stampedAt: Date.now(),
  });
}

/** Hands the panel back to whatever else Windows has, if anything. */
function releaseOwn() {
  own.track = null;
  api.ya.pinTrack(null);
  own.repeat = 'None';
  words.lines = null;
  words.shown = -2;
  api.ya.setLines(null);
  buildReel(null);
  paintLyricsButton();
  paintLyrics();
  audio.removeAttribute('src');
  audio.load();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  applyState(smtcState);
}

// Windows shows this in the volume flyout and on the media keys.
function describeOwn(track) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || '',
    artist: track.artists || '',
    album: wave.on ? 'Моя волна' : 'Яндекс Музыка',
    artwork: track.cover ? [{ src: track.cover, sizes: '200x200', type: 'image/jpeg' }] : [],
  });
}

if ('mediaSession' in navigator) {
  const handlers = {
    play: () => ownActive() && audio.play().catch(() => {}),
    pause: () => ownActive() && audio.pause(),
    nexttrack: () => ownActive() && advanceWave(),
    previoustrack: () => ownActive() && goBack(),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch {
      /* an action this build of Chromium does not know */
    }
  }
}

audio.addEventListener('playing', () => {
  own.failures = 0;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  pushOwnState();
});
audio.addEventListener('pause', () => {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  pushOwnState();
});
audio.addEventListener('loadedmetadata', pushOwnState);
audio.addEventListener('timeupdate', pushOwnState);

// The honest end of a track — no guessing from silence any more.
audio.addEventListener('ended', () => {
  // Round again, for learning the words: the wave can wait.
  if (ownActive() && own.repeat === 'Track') {
    audio.currentTime = 0;
    audio.play().catch(() => advanceWave());
    return;
  }
  advanceWave();
});

audio.addEventListener('error', () => {
  if (!ownActive()) return;
  // One bad track should not stop the wave, but a run of them means something
  // larger is wrong and skipping forever would only hide it.
  own.failures += 1;
  if (!wave.on || own.failures >= 3) {
    toast('Трек не проигрывается');
    wave.on = false;
    return releaseOwn();
  }
  toast('Трек не проигрывается, идём дальше');
  advanceWave();
});

/** Hands the wave the track that just finished and starts the next one. */
async function advanceWave() {
  if (wave.busy || !wave.on) return;
  wave.busy = true;

  const played = audio.currentTime || 0;
  const res = await api.ya.waveNext(wave.current && wave.current.id, played);
  wave.busy = false;

  if (!res || !res.ok) {
    wave.on = false;
    toast((res && res.error) || 'Волна остановилась');
    return releaseOwn();
  }
  playTrack(res.track);
}

/** Back to the track before this one, keeping the rest of the history. */
function goBack() {
  if (!wave.history.length) return;
  const back = wave.history.pop();
  const keep = wave.history.slice();
  playTrack(back);
  wave.history = keep; // playTrack would otherwise re-add the track we left
}

async function startWave() {
  if (!yaStatus.connected) {
    toast('Сначала подключите аккаунт Яндекса');
    return openYa();
  }
  toast('Включаем Мою волну…');
  const res = await api.ya.waveStart();
  if (!res || !res.ok) return toast((res && res.error) || 'Не удалось включить волну');
  playTrack(res.track);
}

/**
 * Plays the chosen track and returns the panel to its usual controls.
 *
 * The link is signed and stamped with a time, so it is fetched for every play
 * rather than remembered.
 */
async function playTrack(track) {
  showMusicPane('player');

  // Everything the widget plays becomes the start of a wave.
  if (wave.current && wave.current.id !== track.id) {
    wave.history.push(wave.current);
    if (wave.history.length > 20) wave.history.shift();
  }
  wave.on = true;
  wave.current = track;
  own.track = track;
  api.ya.pinTrack(track);

  lastTrack = {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    artists: track.artists,
    cover: track.cover || null,
    durationMs: track.durationMs || 0,
  };
  api.app.setSetting('lastTrack', lastTrack);

  describeOwn(track);
  useCover(track.cover);
  paintLyricsButton();
  loadLyrics(track);
  pushOwnState();

  // Quiet whatever else is sounding. Our own player is not on that list — it
  // is about to start.
  if (smtcState.active && smtcState.app !== 'com.vidget.overlay') api.media.cmd('pause');

  toast('Включаем…');
  const res = await api.ya.stream(track.id);
  if (own.track !== track) return; // the wave moved on while we were asking

  if (!res || !res.ok) {
    toast((res && res.error) || 'Трек не запустился');
    if (wave.on && own.failures < 3) {
      own.failures += 1;
      return advanceWave();
    }
    wave.on = false;
    return releaseOwn();
  }
  if (res.preview) toast('Яндекс отдал только фрагмент этого трека');

  audio.src = res.url;
  audio.play().catch((err) => {
    if (own.track !== track) return;
    toast(`Трек не запустился: ${err.message}`);
  });
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
      if (it.thumbUrl) shot.style.backgroundImage = `url("${it.thumbUrl}")`;
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
  if (body.classList.contains('portrait')) return; // a column scrolls by itself
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
    if (data.pending) {
      // The picture is still being written; it is only ever a moment.
      bodyEl.textContent = 'Сохраняем картинку…';
      $('#pv-meta').textContent = `${data.w}×${data.h}`;
    } else {
      // Loaded by address from our own origin, so the bytes never travel
      // through IPC as a base64 string.
      const img = el('img');
      img.src = data.url;
      bodyEl.append(img);
      $('#pv-meta').textContent = `${data.w}×${data.h} · ${humanBytes(data.bytes || 0)}`;
    }
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
    // The rest of the note, formatted. The line that became the title is not
    // repeated, and a card shows only what fits at a glance.
    const lines = api.md.parse(n.text || '');
    const titleLine = lines.findIndex((l) => l.segments.some((s) => !s.mark && s.text.trim()));
    const view = el('div', 'txt md-view');
    let shown = 0;
    lines.forEach((line, index) => {
      if (index <= titleLine || shown >= 8) return;
      if (!shown && line.kind === 'blank') return;
      view.append(mdLine(line, index, false));
      shown += 1;
    });
    chip.append(view);

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
  // A box ticked straight on the card, without opening the note.
  const box = e.target.closest('.md-box');
  if (box) {
    const note = noteItems.find((n) => n.id === id);
    if (note) api.notes.update(id, api.md.toggleTask(note.text || '', Number(box.dataset.task)));
    return;
  }
  const link = e.target.closest('.md-link');
  if (link && link.dataset.href) return api.notes.openUrl(link.dataset.href);
  openNote(id);
});

noteStrip.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  if (body.classList.contains('portrait')) return;
  noteStrip.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

noteSearch.addEventListener('input', renderNotes);

function growQuick() {
  noteQuick.style.height = 'auto';
  noteQuick.style.height = `${Math.min(88, Math.max(34, noteQuick.scrollHeight))}px`;
}

noteQuick.addEventListener('input', growQuick);

// The quick note is a plain field, but the same keys work in it as in the
// editor: Shift+Enter carries a list on, Ctrl+B and Ctrl+I wrap the selection.
function quickEdit(result) {
  noteQuick.value = result.text;
  noteQuick.setSelectionRange(result.start, result.end);
  growQuick();
}

noteQuick.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    quickEdit(api.md.newLine(noteQuick.value, noteQuick.selectionStart, noteQuick.selectionEnd));
    return;
  }
  const wrap = mdWrapKey(e);
  if (wrap) {
    e.preventDefault();
    quickEdit(api.md.toggleWrap(noteQuick.value, noteQuick.selectionStart, noteQuick.selectionEnd, wrap));
  }
});

noteQuick.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
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

// ============================================================
//  Markdown: drawing a line, and the live editor
// ============================================================

/** Ctrl+B → '**', Ctrl+I → '*', anything else → null. Layout-proof: by key code. */
function mdWrapKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  if (e.code === 'KeyB') return '**';
  if (e.code === 'KeyI') return '*';
  return null;
}

/**
 * One parsed line as elements.
 *
 * Every character of the line is in a text node, markup included, so the
 * line's textContent is exactly what was typed. What is not text — the tick
 * box, the bullet dot — is an empty element drawn by CSS, which adds nothing
 * to that text. Markup is hidden by CSS too, never removed.
 */
function mdLine(line, index, editable) {
  const classes = ['md-line', `md-${line.kind}`];
  if (line.level) classes.push(`md-h${line.level}`);
  if (line.checked) classes.push('md-done');
  const row = el('div', classes.join(' '));
  row.dataset.line = String(index);

  if (line.indent) row.append(el('span', 'md-indent', line.indent));
  if (line.kind === 'task') {
    const box = el('span', `md-box${line.checked ? ' on' : ''}`);
    box.dataset.task = String(index);
    box.contentEditable = 'false';
    box.title = line.checked ? 'Снять отметку' : 'Отметить';
    row.append(box);
  }
  if (line.kind === 'bullet') {
    const dot = el('span', 'md-dot');
    dot.contentEditable = 'false';
    row.append(dot);
  }
  if (line.marker) row.append(el('span', `md-mark md-marker${line.kind === 'ordered' ? ' md-num' : ''}`, line.marker));

  for (const seg of line.segments) {
    const span = el('span', null, seg.text);
    const cls = [];
    if (seg.mark) cls.push('md-mark');
    for (const style of seg.styles) cls.push(`md-${style}`);
    if (seg.href && !seg.mark) {
      cls.push('md-link');
      span.dataset.href = seg.href;
      span.title = editable ? `${seg.href}  (клик — открыть, в редактируемой строке Ctrl+клик)` : seg.href;
    }
    if (cls.length) span.className = cls.join(' ');
    row.append(span);
  }
  // An empty line still needs a height, and a place for the caret.
  if (editable && !line.raw) row.append(document.createElement('br'));
  return row;
}

// --- the live editor --------------------------------------------------------
// The text is the truth; the elements are redrawn from it after every change,
// and the caret is put back by counting characters. That is why it does not
// matter what the browser does to the elements while typing: whatever they
// hold is read back as text and drawn again, correctly.
const mdState = { text: '', composing: false, history: [], future: [], lastAt: 0 };

const mdLines = () => [...noteText.children];

/** The editor's text, line by line. */
function mdRead() {
  const parts = [];
  for (const node of noteText.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent);
    else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'BR') parts.push(node.textContent);
  }
  return (parts.length ? parts.join('\n') : '').replace(/\u200b/g, '');
}

/** Character offset of a DOM position inside the editor. */
function mdOffset(node, offset) {
  if (node === noteText) {
    let total = 0;
    const kids = [...noteText.childNodes];
    for (let i = 0; i < offset && i < kids.length; i++) total += kids[i].textContent.length + 1;
    return Math.max(0, total - (offset >= kids.length && kids.length ? 1 : 0));
  }
  let total = 0;
  for (const line of noteText.childNodes) {
    if (line === node || line.contains(node)) {
      const range = document.createRange();
      range.selectNodeContents(line);
      try {
        range.setEnd(node, offset);
      } catch {
        return total;
      }
      return total + range.toString().length;
    }
    total += line.textContent.length + 1;
  }
  return Math.max(0, total - 1);
}

function mdSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !noteText.contains(sel.anchorNode)) {
    const end = mdState.text.length;
    return { start: end, end };
  }
  const range = sel.getRangeAt(0);
  const a = mdOffset(range.startContainer, range.startOffset);
  const b = mdOffset(range.endContainer, range.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

/** The DOM position for a character offset. */
function mdPoint(pos) {
  const lines = mdLines();
  let rest = pos;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const length = line.textContent.length;
    if (rest <= length || i === lines.length - 1) {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node;
      let last = null;
      while ((node = walker.nextNode())) {
        if (rest <= node.length) return [node, rest];
        rest -= node.length;
        last = node;
      }
      return last ? [last, last.length] : [line, 0];
    }
    rest -= length + 1;
  }
  return [noteText, 0];
}

function mdSetSelection(start, end) {
  const sel = window.getSelection();
  const range = document.createRange();
  const [sn, so] = mdPoint(start);
  const [en, eo] = mdPoint(end);
  try {
    range.setStart(sn, so);
    range.setEnd(en, eo);
  } catch {
    return;
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

const mdLineIndex = (text, pos) => text.slice(0, pos).split('\n').length - 1;

/** Shows the markup on the lines the selection touches, hides it elsewhere. */
function mdMarkActive(start, end) {
  const from = mdLineIndex(mdState.text, start);
  const to = mdLineIndex(mdState.text, end);
  mdLines().forEach((line, i) => line.classList.toggle('active', i >= from && i <= to));
}

function mdRender(text, start, end) {
  mdState.text = text;
  const lines = api.md.parse(text);
  noteText.textContent = '';
  lines.forEach((line, i) => noteText.append(mdLine(line, i, true)));
  noteText.classList.toggle('is-empty', !text);
  mdMarkActive(start, end);
  if (document.activeElement === noteText) mdSetSelection(start, end);
}

/**
 * Remembers a state for undo. Typing in quick succession is one step, the
 * way a text field does it; a structural edit is always its own step.
 */
function mdRecord(kind) {
  const now = Date.now();
  const top = mdState.history[mdState.history.length - 1];
  const sel = mdSelection();
  const entry = { text: mdState.text, start: sel.start, end: sel.end, kind };
  if (top && top.text === entry.text) return;
  if (top && kind === 'typing' && top.kind === 'typing' && now - mdState.lastAt < 800) {
    mdState.history[mdState.history.length - 1] = entry;
  } else {
    mdState.history.push(entry);
    if (mdState.history.length > 200) mdState.history.shift();
  }
  mdState.future = [];
  mdState.lastAt = now;
}

/** Applies a new text and selection from an editing move, as one undo step. */
function mdApply(result, kind = 'edit') {
  mdRender(result.text, result.start, result.end);
  mdRecord(kind);
  scheduleNoteSave();
}

function mdUndo() {
  if (mdState.history.length < 2) return;
  mdState.future.push(mdState.history.pop());
  const prev = mdState.history[mdState.history.length - 1];
  mdRender(prev.text, prev.start, prev.end);
  scheduleNoteSave();
}

function mdRedo() {
  const next = mdState.future.pop();
  if (!next) return;
  mdState.history.push(next);
  mdRender(next.text, next.start, next.end);
  scheduleNoteSave();
}

function scheduleNoteSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNote, 350);
}

function openNote(id) {
  const note = noteItems.find((n) => n.id === id);
  if (!note) return;
  editingId = id;
  $('#note-stamp').textContent = `изменено ${timeAgo(note.updated)}`;
  $('#note-pin').classList.toggle('on', !!note.pinned);
  noteEditor.hidden = false;
  const text = note.text || '';
  mdState.history = [];
  mdState.future = [];
  mdRender(text, text.length, text.length);
  mdRecord('open');
  setTimeout(() => {
    noteText.focus();
    mdSetSelection(text.length, text.length);
    mdMarkActive(text.length, text.length);
  }, 30);
}

function flushNote() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (editingId) api.notes.update(editingId, mdState.text);
}

function closeNote() {
  flushNote();
  editingId = null;
  noteEditor.hidden = true;
  loadNotes();
}

noteText.addEventListener('beforeinput', (e) => {
  const type = e.inputType;
  // New lines, undo and the browser's own formatting are ours to do; left to
  // the browser they would build elements the text model knows nothing about.
  if (type === 'insertParagraph' || type === 'insertLineBreak' || type.startsWith('format') || type === 'insertFromDrop') {
    e.preventDefault();
  } else if (type === 'historyUndo') {
    e.preventDefault();
    mdUndo();
  } else if (type === 'historyRedo') {
    e.preventDefault();
    mdRedo();
  }
});

noteText.addEventListener('input', () => {
  if (mdState.composing) return;
  const sel = mdSelection();
  mdRender(mdRead(), sel.start, sel.end);
  mdRecord('typing');
  scheduleNoteSave();
});

noteText.addEventListener('compositionstart', () => {
  mdState.composing = true;
});
noteText.addEventListener('compositionend', () => {
  mdState.composing = false;
  const sel = mdSelection();
  mdRender(mdRead(), sel.start, sel.end);
  mdRecord('typing');
  scheduleNoteSave();
});

noteText.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    // Enter saves and goes back to the notes; a new line is Shift+Enter.
    e.preventDefault();
    closeNote();
    toast('Заметка сохранена');
    return;
  }
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    const sel = mdSelection();
    mdApply(api.md.newLine(mdState.text, sel.start, sel.end));
    return;
  }
  const wrap = mdWrapKey(e);
  if (wrap) {
    e.preventDefault();
    const sel = mdSelection();
    mdApply(api.md.toggleWrap(mdState.text, sel.start, sel.end, wrap));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) mdRedo();
    else mdUndo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') {
    e.preventDefault();
    mdRedo();
    return;
  }
  if (e.key === 'Tab') {
    // Tab and Shift+Tab move a line in or out — how lists get nested.
    e.preventDefault();
    const sel = mdSelection();
    const text = mdState.text;
    const lineStart = text.lastIndexOf('\n', sel.start - 1) + 1;
    if (e.shiftKey) {
      const lead = /^ {1,2}/.exec(text.slice(lineStart));
      if (!lead) return;
      const n = lead[0].length;
      mdApply({
        text: text.slice(0, lineStart) + text.slice(lineStart + n),
        start: Math.max(lineStart, sel.start - n),
        end: Math.max(lineStart, sel.end - n),
      });
    } else {
      mdApply({ text: text.slice(0, lineStart) + '  ' + text.slice(lineStart), start: sel.start + 2, end: sel.end + 2 });
    }
  }
});

noteText.addEventListener('paste', (e) => {
  e.preventDefault();
  const pasted = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  if (!pasted) return;
  const clean = pasted.replace(/\r\n?/g, '\n');
  const sel = mdSelection();
  const text = mdState.text;
  const pos = sel.start + clean.length;
  mdApply({ text: text.slice(0, sel.start) + clean + text.slice(sel.end), start: pos, end: pos });
});

// The tick box: pressed with the mouse, never a place for the caret.
noteText.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;

  // A link opens on a plain click where it is shown as a link — on a line not
  // being edited. On the line under the caret the address is text being
  // edited, so there a plain click places the caret and Ctrl+click opens.
  const link = e.target.closest('.md-link');
  if (link && link.dataset.href) {
    const line = link.closest('.md-line');
    if (e.ctrlKey || e.metaKey || (line && !line.classList.contains('active'))) {
      e.preventDefault();
      api.notes.openUrl(link.dataset.href);
      return;
    }
  }

  const box = e.target.closest('.md-box');
  if (!box) return;
  e.preventDefault();
  const sel = mdSelection();
  mdApply({ text: api.md.toggleTask(mdState.text, Number(box.dataset.task)), start: sel.start, end: sel.end });
});

// Moving the caret with the keys or the mouse changes which line shows its markup.
document.addEventListener('selectionchange', () => {
  if (noteEditor.hidden || document.activeElement !== noteText || mdState.composing) return;
  const sel = mdSelection();
  mdMarkActive(sel.start, sel.end);
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
    if (body.classList.contains('portrait')) return;
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
  if (!ytOrigin) {
    // The embed refuses to run without a real origin, and the panel only has
    // one while the local address is up.
    toast('Локальный адрес недоступен — открываю в браузере');
    api.yt.open(item.id);
    return;
  }
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
//  passwords
// ============================================================
// The panel never holds a password. It holds titles, user names and groups;
// a value is fetched one at a time, shown for a moment, and dropped.
const vaultSearch = $('#vault-search');
const vaultList = $('#vault-list');
const vaultEntry = $('#vault-entry');

let vaultStatus = { configured: false, unlocked: false };
let vaultItems = []; // what the list is showing now
let vaultSuggested = new Map(); // id -> why it suits the window in front
let vaultWindow = null; // the window the user came from
let vaultCursor = -1; // which row the keyboard is on
let vaultEntryId = null;
let totpTimer = null;

function paintVaultPanes() {
  const setup = !vaultStatus.configured;
  const locked = vaultStatus.configured && !vaultStatus.unlocked;
  $('#vault-setup').hidden = !setup;
  $('#vault-unlock').hidden = !locked;
  $('#vault-open-pane').hidden = setup || locked;
  $('#vault-lock').hidden = !vaultStatus.unlocked;

  if (locked) {
    const file = String(vaultStatus.file || '');
    $('#vault-file-name').textContent = file.split(/[\/]/).pop() || file;
  }
  if (!vaultStatus.unlocked) {
    vaultItems = [];
    vaultList.textContent = '';
    closeVaultEntry();
    // A locked database has nothing to come back to.
    if (typeof forgetVaultPlace === 'function' && vaultPlace) forgetVaultPlace();
  }
}

/** The strip above the list, naming where a password would be typed. */
function paintVaultWindow() {
  const box = $('#vault-window');
  const title = vaultWindow && vaultWindow.title;
  if (!title || !vaultStatus.unlocked) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.textContent = '';
  box.append(document.createTextNode('Напечатать в: '));
  const b = el('b', null, title);
  box.append(b);
}

function vaultIconFor(item) {
  if (item.expired) return 'clock';
  if (item.hasTotp) return 'key';
  return 'lock';
}

function renderVaultList() {
  vaultList.textContent = '';
  $('#vault-empty').style.display = vaultItems.length ? 'none' : '';

  vaultItems.forEach((item, index) => {
    const row = el('div', `prow${index === vaultCursor ? ' current' : ''}${item.expired ? ' stale' : ''}`);
    row.dataset.id = item.id;

    const icon = el('div', 'pico');
    if (item.iconData) {
      // The icon the entry carries in the database — that is how its owner
      // picks it out of a list without reading.
      const img = document.createElement('img');
      img.src = item.iconData;
      img.alt = '';
      icon.append(img);
    } else {
      icon.append(svgIcon(vaultIconFor(item)));
    }
    row.append(icon);

    const info = el('div', 'pinfo');
    info.append(el('div', 'pname', item.title));
    const under = [item.user, shortGroupPath(item.group)].filter(Boolean).join('  ·  ');
    info.append(el('div', 'puser', under));
    row.append(info);

    const why = vaultSuggested.get(item.id);
    if (why) row.append(el('div', 'pwhy', why));

    // Two things by hand, because they are what a password list is for; the
    // rest behind the dots, because a row of six identical squares is not a
    // list any more. Clicking the row itself opens the entry.
    const acts = [
      ['type', 'type', 'Напечатать в окно'],
      ['copy', 'copy', 'Скопировать пароль'],
      ['menu', 'more', 'Ещё'],
    ];

    const box = el('div', 'pacts');
    for (const [act, icon2, title] of acts) {
      const b = el('button');
      b.dataset.act = act;
      b.title = title;
      b.append(svgIcon(icon2));
      box.append(b);
    }
    row.append(box);

    vaultList.append(row);
  });
}

/**
 * Refills the list.
 *
 * With an empty search box the entries that suit the window in front come
 * first — that is the whole point of opening this by hotkey. Once the user
 * types, it is a plain search over everything.
 */
async function refreshVaultList(keepCursor = false) {
  if (!vaultStatus.unlocked) return;
  const query = vaultSearch.value.trim();
  vaultSuggested = new Map();
  await loadVaultGroups();

  let items = [];
  if (!query && vaultGroup) {
    // A group chosen in the tree: its entries and those of the groups under it.
    items = await api.vault.inGroup(vaultGroup);
  } else if (!query) {
    const suited = await api.vault.forWindow();
    vaultWindow = suited.window || vaultWindow;
    for (const hit of suited.items) vaultSuggested.set(hit.entry.id, hit.why);
    const rest = await api.vault.list('');
    const seen = new Set(suited.items.map((h) => h.entry.id));
    items = [...suited.items.map((h) => h.entry), ...rest.filter((e) => !seen.has(e.id))];
  } else {
    items = await api.vault.list(query);
  }

  vaultItems = items;
  if (!keepCursor) vaultCursor = items.length ? 0 : -1;
  else vaultCursor = Math.min(vaultCursor, items.length - 1);
  renderVaultList();
  renderVaultTree();
  paintVaultWindow();
}

// --- the group tree ---------------------------------------------------------
// KeePass users sort their passwords into groups and find them there. The tree
// sits beside the list in the wide panel; on a side edge, where the panel is a
// phone, it becomes a list of folders opened from a bar above the entries.
let vaultGroups = [];
let vaultGroup = null; // chosen group id, or null for everything
let vaultNewGroup = null; // { parentId, name, error } while a new group is being named
let vaultRenaming = null; // { id, name, error } while a group is being renamed
const vaultFolded = new Set(); // groups whose branch is folded away

async function loadVaultGroups() {
  vaultGroups = vaultStatus.unlocked ? await api.vault.groups() : [];
  // A group that disappeared — deleted in KeePass — takes the choice with it.
  if (vaultGroup && !vaultGroups.some((g) => g.id === vaultGroup)) vaultGroup = null;
}

const groupById = (id) => vaultGroups.find((g) => g.id === id);

/**
 * A group path without the database's own root in front: every path starts
 * with it, so it says nothing and only pushes the useful part out of view.
 */
function shortGroupPath(path) {
  const root = vaultGroups.length && vaultGroups[0].depth === 0 ? vaultGroups[0].name : null;
  if (!root || !path) return path || '';
  if (path === root) return '';
  return path.startsWith(`${root} / `) ? path.slice(root.length + 3) : path;
}

/** Hidden when any group above it is folded. */
function groupVisible(group) {
  let parent = group.parentId && groupById(group.parentId);
  while (parent) {
    if (vaultFolded.has(parent.id)) return false;
    parent = parent.parentId && groupById(parent.parentId);
  }
  return true;
}

function renderVaultTree() {
  const tree = $('#vault-tree');
  tree.textContent = '';
  const searching = !!vaultSearch.value.trim();

  const all = el('button', `vtree-row all${!vaultGroup ? ' current' : ''}`);
  all.dataset.group = '';
  all.append(svgIcon('key'));
  all.append(el('span', 'vtree-name', 'Все записи'));
  tree.append(all);

  // A database has one root group and the real ones under it; showing the root
  // as a level of its own would only push everything one step to the right.
  const rootId = vaultGroups.length && vaultGroups[0].depth === 0 ? vaultGroups[0].id : null;
  for (const group of vaultGroups) {
    if (group.id === rootId) continue;
    if (!groupVisible(group)) continue;
    const depth = rootId ? group.depth - 1 : group.depth;

    // Being renamed: the row turns into a field in its own place.
    if (vaultRenaming && vaultRenaming.id === group.id) {
      const form = el('form', 'vtree-new rename');
      form.style.paddingLeft = `${8 + depth * 14 + 20}px`;
      const input = el('input');
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.maxLength = 100;
      input.value = vaultRenaming.name;
      input.addEventListener('input', () => {
        vaultRenaming.name = input.value;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          vaultRenaming = null;
          renderVaultTree();
        }
      });
      form.append(svgIcon('folder'), input);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        saveGroupRename();
      });
      tree.append(form);
      if (vaultRenaming.error) tree.append(el('div', 'vtree-error', vaultRenaming.error));
      setTimeout(() => {
        if (document.activeElement !== input) {
          input.focus();
          if (!vaultRenaming.touched) input.select();
          vaultRenaming.touched = true;
        }
      }, 0);
      continue;
    }

    const row = el('button', `vtree-row${group.id === vaultGroup ? ' current' : ''}${group.total ? '' : ' no-entries'}`);
    row.dataset.group = group.id;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = group.path;

    const fold = el('span', `vtree-fold${group.children ? '' : ' none'}${vaultFolded.has(group.id) ? ' folded' : ''}`);
    fold.dataset.fold = group.id;
    if (group.children) fold.append(svgIcon('back'));
    row.append(fold);
    row.append(svgIcon('folder'));
    row.append(el('span', 'vtree-name', group.name));
    if (group.total) row.append(el('span', 'vtree-count', String(group.total)));
    tree.append(row);
  }

  // A new group goes inside the one chosen, or at the top when none is.
  if (vaultNewGroup) {
    const form = el('form', 'vtree-new');
    const parent = vaultNewGroup.parentId && groupById(vaultNewGroup.parentId);
    const input = el('input');
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = 100;
    input.placeholder = parent && parent.depth > 0 ? `Новая группа в «${parent.name}»` : 'Новая группа';
    input.value = vaultNewGroup.name || '';
    input.addEventListener('input', () => {
      vaultNewGroup.name = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        vaultNewGroup = null;
        renderVaultTree();
      }
    });
    form.append(svgIcon('folder'), input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      saveNewGroup();
    });
    tree.append(form);
    if (vaultNewGroup.error) tree.append(el('div', 'vtree-error', vaultNewGroup.error));
    setTimeout(() => input.focus(), 0);
  } else {
    const add = el('button', 'vtree-row vtree-add');
    add.dataset.newGroup = '1';
    add.append(el('span', 'vtree-plus', '+'));
    const chosenGroup = vaultGroup && groupById(vaultGroup);
    add.append(el('span', 'vtree-name', chosenGroup ? `Группа в «${chosenGroup.name}»` : 'Новая группа'));
    tree.append(add);
  }

  // Searching looks through everything, whatever is chosen in the tree.
  tree.classList.toggle('searching', searching);

  const crumb = $('#vault-crumb');
  const chosen = vaultGroup && groupById(vaultGroup);
  crumb.textContent = '';
  crumb.append(svgIcon('folder'));
  crumb.append(el('span', null, searching ? 'Поиск по всем группам' : chosen ? shortGroupPath(chosen.path) || chosen.name : 'Все записи'));
  crumb.append(el('span', 'vcrumb-hint', 'группы'));
}

function chooseVaultGroup(id) {
  vaultGroup = id || null;
  vaultNewGroup = null;
  vaultRenaming = null;
  document.body.classList.remove('vault-tree-open');
  if (vaultSearch.value) vaultSearch.value = '';
  refreshVaultList();
}

async function saveNewGroup() {
  if (!vaultNewGroup) return;
  const name = (vaultNewGroup.name || '').trim();
  if (!name) {
    vaultNewGroup = null;
    renderVaultTree();
    return;
  }
  const res = await api.vault.createGroup(vaultNewGroup.parentId, name);
  if (!res || !res.ok) {
    vaultNewGroup = { ...vaultNewGroup, error: (res && res.error) || 'Не удалось создать группу' };
    renderVaultTree();
    return;
  }
  const parentId = vaultNewGroup.parentId;
  vaultNewGroup = null;
  // The branch it went into is opened, so the new group is not hidden away.
  if (parentId) vaultFolded.delete(parentId);
  vaultGroup = res.id;
  document.body.classList.remove('vault-tree-open');
  await refreshVaultList();
  toast(`Группа «${name}» создана`);
}

async function saveGroupRename() {
  if (!vaultRenaming) return;
  const { id } = vaultRenaming;
  const name = (vaultRenaming.name || '').trim();
  const res = await api.vault.renameGroup(id, name);
  if (!res || !res.ok) {
    vaultRenaming = { ...vaultRenaming, error: (res && res.error) || 'Не удалось переименовать' };
    renderVaultTree();
    return;
  }
  vaultRenaming = null;
  await refreshVaultList(true);
  toast(`Группа теперь «${name}»`);
}

/**
 * Right click on a group: what can be done with it.
 *
 * Deleting asks twice, in the menu itself — the shade has nowhere to put a
 * dialog box, and a group can hold dozens of passwords.
 */
function openGroupMenu(group, x, y) {
  closeVaultMenu();
  const count = group.total;
  const items = [
    ['note', 'Переименовать', () => {
      vaultNewGroup = null;
      vaultRenaming = { id: group.id, name: group.name, error: null, touched: false };
      renderVaultTree();
    }],
    ['folder', 'Новая группа внутри', () => {
      vaultRenaming = null;
      vaultFolded.delete(group.id);
      vaultNewGroup = { parentId: group.id, name: '', error: null };
      renderVaultTree();
    }],
    null,
    ['trash', 'Удалить группу', null],
  ];

  for (const item of items) {
    if (!item) {
      vaultMenu.append(el('div', 'sep'));
      continue;
    }
    const [icon, label, run] = item;
    const button = el('button', run ? null : 'danger');
    button.append(svgIcon(icon));
    const text = el('span', null, label);
    button.append(text);
    button.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (run) {
        closeVaultMenu();
        run();
        return;
      }
      if (button.dataset.armed !== 'yes') {
        button.dataset.armed = 'yes';
        button.classList.add('armed');
        text.textContent = count
          ? `Ещё раз — в корзину вместе с ${count} ${count === 1 ? 'записью' : 'записями'}`
          : 'Ещё раз — в корзину';
        return;
      }
      closeVaultMenu();
      const res = await api.vault.deleteGroup(group.id);
      if (!res || !res.ok) {
        toast((res && res.error) || 'Не удалось удалить группу');
        return;
      }
      if (vaultGroup === group.id) vaultGroup = group.parentId || null;
      await refreshVaultList();
      toast(res.permanent ? `Группа «${res.name}» удалена навсегда` : `Группа «${res.name}» в корзине базы`);
    });
    vaultMenu.append(button);
  }

  // At the cursor, nudged back inside the panel when it would hang off it.
  vaultMenu.hidden = false;
  const size = vaultMenu.getBoundingClientRect();
  const box = panel.getBoundingClientRect();
  const left = Math.max(8, Math.min(x - box.left, box.width - size.width - 8));
  const top = Math.max(8, Math.min(y - box.top, box.height - size.height - 8));
  vaultMenu.style.left = `${Math.round(left)}px`;
  vaultMenu.style.top = `${Math.round(top)}px`;
}

$('#vault-tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.vtree-row');
  const id = row && row.dataset.group;
  const group = id && groupById(id);
  if (!group) return;
  e.preventDefault();
  // The root of the database is not in the tree; everything that is may be
  // renamed or removed.
  openGroupMenu(group, e.clientX, e.clientY);
});

$('#vault-tree').addEventListener('click', (e) => {
  if (e.target.closest('[data-new-group]')) {
    e.stopPropagation();
    vaultNewGroup = { parentId: vaultGroup, name: '', error: null };
    renderVaultTree();
    return;
  }
  if (e.target.closest('.vtree-new')) return;
  if (vaultRenaming) {
    vaultRenaming = null;
    renderVaultTree();
  }
  const fold = e.target.closest('[data-fold]');
  if (fold && fold.dataset.fold) {
    e.stopPropagation();
    const id = fold.dataset.fold;
    if (vaultFolded.has(id)) vaultFolded.delete(id);
    else vaultFolded.add(id);
    renderVaultTree();
    return;
  }
  const row = e.target.closest('.vtree-row');
  if (row) chooseVaultGroup(row.dataset.group);
});

// On the phone-shaped panel the tree lives behind the folder bar.
const toggleVaultTree = () => document.body.classList.toggle('vault-tree-open');
$('#vault-crumb').addEventListener('click', toggleVaultTree);
$('#vault-groups-btn').addEventListener('click', toggleVaultTree);

async function loadVault(focusSearch = false, keepCursor = false) {
  vaultStatus = await api.vault.status();
  vaultWindow = vaultStatus.window || vaultWindow;
  paintVaultPanes();
  paintVaultWindow();
  if (vaultStatus.unlocked) await refreshVaultList(keepCursor || !!vaultPlace);
  if (focusSearch) {
    const box = vaultStatus.unlocked ? vaultSearch : $('#vault-password');
    setTimeout(() => box.focus(), 60);
  }
}

// --- doing something with an entry -----------------------------------------
async function vaultCopy(id, field, what, pastIndex) {
  const res = await api.vault.copy(id, field, pastIndex);
  if (!res || !res.ok) return toast((res && res.error) || 'Не удалось скопировать');
  toast(`${what} в буфере — сотрётся через ${res.seconds} с`);
}

/**
 * Types the entry into the window the user came from.
 *
 * The panel closes on its way: Windows puts back whatever was in front, and
 * only then may anything be typed.
 */
async function vaultType(id) {
  if (!vaultWindow || !vaultWindow.title) return toast('Не видно, в каком окне вы работали');
  const res = await api.vault.type(id);
  // A refusal comes back through vault:onTyped as well, with the panel
  // reopened; success needs nothing said — the password is already in the form.
  if (res && !res.ok && !res.error) toast('Не удалось напечатать');
}

vaultList.addEventListener('click', (e) => {
  const row = e.target.closest('.prow');
  if (!row) return;
  const id = row.dataset.id;
  const act = e.target.dataset.act;
  if (act === 'copy') return vaultCopy(id, 'Password', 'Пароль');
  if (act === 'type') return vaultType(id);
  if (act === 'menu') {
    e.stopPropagation();
    const item = vaultItems.find((i) => i.id === id);
    if (item) openVaultMenu(item, e.target);
    return;
  }
  openVaultEntry(id);
});

vaultSearch.addEventListener('input', () => refreshVaultList());

vaultSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!vaultItems.length) return;
    vaultCursor = (vaultCursor + (e.key === 'ArrowDown' ? 1 : -1) + vaultItems.length) % vaultItems.length;
    renderVaultList();
    const row = vaultList.children[vaultCursor];
    if (row) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const item = vaultItems[vaultCursor];
  if (!item) return;
  // Enter types it; Shift+Enter copies instead, for the places where synthetic
  // typing is not welcome.
  if (e.shiftKey) vaultCopy(item.id, 'Password', 'Пароль');
  else vaultType(item.id);
});

$('#vault-lock').addEventListener('click', () => {
  api.vault.lock();
  toast('Пароли закрыты');
});

$('#vault-pick').addEventListener('click', () => pickVaultFile());

// --- what else can be done with an entry ------------------------------------
const vaultMenu = $('#vault-menu');

function closeVaultMenu() {
  vaultMenu.hidden = true;
  vaultMenu.textContent = '';
}

/**
 * Opens the little menu next to the row's dots.
 *
 * Copying the user name and the address belongs here rather than as two more
 * squares in every row: a list of entries should read as a list, not as a wall
 * of identical buttons.
 */
function openVaultMenu(item, anchor) {
  closeVaultMenu();

  const entries = [
    ['copy', 'Скопировать логин', 'copy', item.user, () => vaultCopy(item.id, 'UserName', 'Логин')],
    ['copy', 'Скопировать пароль', 'copy', item.hasPassword, () => vaultCopy(item.id, 'Password', 'Пароль')],
    ['copy', 'Скопировать адрес', 'copy', item.url, () => vaultCopy(item.id, 'URL', 'Адрес')],
    ['clock', 'Скопировать одноразовый код', 'clock', item.hasTotp, () => vaultCopy(item.id, 'TOTP', 'Код')],
    [null, null, null, true, null], // separator
    ['expand', 'Открыть адрес в браузере', 'expand', item.url, async () => {
      const res = await api.vault.openUrl(item.id);
      if (res && !res.ok) toast(res.error);
    }],
    ['key', 'Показать запись', 'key', true, () => openVaultEntry(item.id)],
    ['note', 'Изменить запись', 'note', true, () => openVaultForm(item.id)],
  ];

  for (const [icon, label, , available, run] of entries) {
    if (!available) continue;
    if (!label) {
      vaultMenu.append(el('div', 'sep'));
      continue;
    }
    const button = el('button', null);
    button.append(svgIcon(icon));
    button.append(document.createTextNode(label));
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      closeVaultMenu();
      run();
    });
    vaultMenu.append(button);
  }

  // Placed under the dots, and nudged back inside the panel when it would hang
  // off the edge.
  vaultMenu.hidden = false;
  const spot = anchor.getBoundingClientRect();
  const size = vaultMenu.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const left = Math.min(Math.max(8, spot.right - size.width), panelBox.width - size.width - 8);
  const below = spot.bottom + 4;
  const top = below + size.height > panelBox.height - 8 ? spot.top - size.height - 4 : below;
  vaultMenu.style.left = `${Math.round(left)}px`;
  vaultMenu.style.top = `${Math.round(Math.max(8, top))}px`;
}

document.addEventListener('click', (e) => {
  if (!vaultMenu.hidden && !vaultMenu.contains(e.target)) closeVaultMenu();
});

// --- unlocking --------------------------------------------------------------
$('#vault-unlock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('#vault-password');
  const msg = $('#vault-unlock-msg');
  const button = $('#vault-open');
  // A database can be locked with a key file alone, and then there is no
  // password to type — but with neither, there is nothing to try.
  if (!box.value && !vaultStatus.keyFile) {
    msg.textContent = 'Введите мастер-пароль';
    return;
  }

  button.disabled = true;
  msg.textContent = 'Открываем…';
  const res = await api.vault.unlock(box.value);
  // The master password has no business staying in a text box on a window that
  // sits above everything else on the screen.
  box.value = '';
  button.disabled = false;

  if (!res || !res.ok) {
    msg.textContent = (res && res.error) || 'Не удалось открыть';
    box.focus();
    return;
  }
  msg.textContent = '';
  vaultStatus = res.status;
  paintVaultPanes();
  await refreshVaultList();
  setTimeout(() => vaultSearch.focus(), 40);
});

// --- one entry, in full -----------------------------------------------------
function stopTotpTimer() {
  if (totpTimer) clearInterval(totpTimer);
  totpTimer = null;
}

function fieldRow(name, value, options = {}) {
  const row = el('div', 'vfield');
  row.append(el('div', 'vname', name));
  const box = el('div', `vvalue${options.mono ? ' mono' : ''}`, value);
  row.append(box);
  const acts = el('div', 'vacts');
  row.append(acts);
  return { row, box, acts };
}

function actionButton(icon, title, onClick) {
  const b = el('button');
  b.title = title;
  b.append(svgIcon(icon));
  b.addEventListener('click', onClick);
  return b;
}

/** Shows a secret for a moment, then puts the dots back. */
function revealRow(box, button, fetch, seconds = 10) {
  let shown = false;
  let timer = null;
  const hide = () => {
    shown = false;
    clearTimeout(timer);
    box.textContent = '••••••••••';
    box.classList.add('hidden-value');
    button.querySelector('use').setAttribute('href', '#i-eye');
  };
  button.addEventListener('click', async () => {
    if (shown) return hide();
    const value = await fetch();
    if (value == null) return toast('Значение не найдено');
    shown = true;
    box.textContent = value;
    box.classList.remove('hidden-value');
    button.querySelector('use').setAttribute('href', '#i-eye-off');
    // This window sits above everything else: a password left showing here is
    // a password shown to whoever walks past.
    timer = setTimeout(hide, seconds * 1000);
  });
  return hide;
}

async function openVaultEntry(id) {
  const item = vaultItems.find((e) => e.id === id);
  if (!item) return;
  vaultEntryId = id;
  stopTotpTimer();

  const where = shortGroupPath(item.group);
  $('#ve-title').textContent = item.title + (where ? `  ·  ${where}` : '');
  const body = $('#ve-body');
  body.textContent = '';

  if (item.user) {
    const { row, acts } = fieldRow('Логин', item.user);
    acts.append(actionButton('copy', 'Скопировать логин', () => vaultCopy(id, 'UserName', 'Логин')));
    body.append(row);
  }

  if (item.hasPassword) {
    const { row, box, acts } = fieldRow('Пароль', '••••••••••', { mono: true });
    box.classList.add('hidden-value');
    const eye = actionButton('eye', 'Показать на десять секунд', () => {});
    acts.append(eye);
    revealRow(box, eye, () => api.vault.reveal(id, 'Password'));
    acts.append(actionButton('copy', 'Скопировать пароль', () => vaultCopy(id, 'Password', 'Пароль')));
    body.append(row);
  }

  if (item.url) {
    const { row, acts } = fieldRow('Адрес', item.url);
    acts.append(
      actionButton('expand', 'Открыть в браузере', async () => {
        const res = await api.vault.openUrl(id);
        if (res && !res.ok) toast(res.error);
      })
    );
    acts.append(actionButton('copy', 'Скопировать адрес', () => vaultCopy(id, 'URL', 'Адрес')));
    body.append(row);
  }

  if (item.hasTotp) {
    const { row, box, acts } = fieldRow('Одноразовый код', '……', { mono: true });
    const bar = el('div', 'totp-left');
    const fill = el('i');
    bar.append(fill);
    row.insertBefore(bar, acts);
    acts.append(actionButton('copy', 'Скопировать код', () => vaultCopy(id, 'TOTP', 'Код')));
    body.append(row);

    const tick = async () => {
      const code = await api.vault.totp(id);
      if (!code) return;
      box.textContent = code.text;
      fill.style.width = `${Math.round((code.secondsLeft / code.period) * 100)}%`;
    };
    tick();
    totpTimer = setInterval(tick, 1000);
  }

  for (const field of item.customFields) {
    // The one-time secret is shown as a code above, not as its raw seed.
    if (field.name === 'otp' || field.name === 'TOTP Seed' || field.name === 'TOTP Settings') continue;
    const { row, box, acts } = fieldRow(field.name, field.protected ? '••••••••••' : '…');
    if (field.protected) {
      box.classList.add('hidden-value');
      const eye = actionButton('eye', 'Показать на десять секунд', () => {});
      acts.append(eye);
      revealRow(box, eye, () => api.vault.reveal(id, field.name));
    } else {
      api.vault.reveal(id, field.name).then((v) => {
        box.textContent = v == null ? '' : v;
      });
    }
    acts.append(actionButton('copy', 'Скопировать', () => vaultCopy(id, field.name, field.name)));
    body.append(row);
  }

  if (item.notes) {
    const { row, box } = fieldRow('Заметки', item.notes);
    box.style.whiteSpace = 'pre-wrap';
    body.append(row);
  }

  if (item.attachments.length) {
    body.append(el('div', 'vgroup', 'Вложения'));
    for (const name of item.attachments) {
      const { row, acts } = fieldRow(name, '');
      acts.append(
        actionButton('attach', 'Сохранить на диск', async () => {
          const res = await api.vault.saveAttachment(id, name);
          if (res && res.ok) toast('Сохранено');
          else if (res && !res.cancelled) toast(res.error || 'Не удалось сохранить');
        })
      );
      body.append(row);
    }
  }

  if (item.history) {
    const past = await api.vault.history(id);
    if (past.length) {
      // The reason to open the history is almost always that the new password
      // has not reached somewhere yet, so the old one has to be gettable.
      body.append(el('div', 'vgroup', `Прежние версии записи: ${past.length}`));
      for (const old of past.slice(0, 5)) {
        const { row, box, acts } = fieldRow(
          old.modified ? timeAgo(old.modified) : 'когда-то',
          old.hasPassword ? '••••••••••' : old.user || '—',
          { mono: old.hasPassword }
        );
        if (old.hasPassword) {
          box.classList.add('hidden-value');
          const eye = actionButton('eye', 'Показать прежний пароль', () => {});
          acts.append(eye);
          revealRow(box, eye, () => api.vault.past(id, old.index, 'Password'));
          acts.append(
            actionButton('copy', 'Скопировать прежний пароль', () =>
              vaultCopy(id, 'Password', 'Прежний пароль', old.index)
            )
          );
        }
        body.append(row);
      }
    }
  }

  const marks = [];
  if (item.expired) marks.push('срок записи истёк');
  if (item.tags.length) marks.push(`метки: ${item.tags.join(', ')}`);
  if (!item.autoType.enabled) marks.push('автоввод для неё выключен');
  if (marks.length) body.append(el('div', 'vgroup', marks.join('  ·  ')));

  vaultEntry.hidden = false;
}

function closeVaultEntry() {
  stopTotpTimer();
  vaultEntryId = null;
  vaultEntry.hidden = true;
}

// --- remembering where the user was -----------------------------------------
const VAULT_KEEP_MS = 3 * 60 * 1000;
let vaultPlace = null; // { at, window } while a place among the passwords is kept
let vaultPlaceTimer = null;

/** The shade closed: hold on to the search, the list position and any open card. */
function keepVaultPlace() {
  const somewhere = !vaultEntry.hidden || !vaultForm.hidden || vaultSearch.value || activeTab === 'vault';
  if (!somewhere || !vaultStatus.unlocked) {
    forgetVaultPlace();
    return;
  }
  vaultPlace = { at: Date.now(), window: vaultWindow && vaultWindow.title };

  // Re-drawing the card masks every value that was shown and stops the
  // one-time code ticking behind a closed shade.
  if (vaultEntryId) {
    const id = vaultEntryId;
    openVaultEntry(id).then(() => {
      if (!isOpen) stopTotpTimer();
    });
  }
  const typed = $('#vf-password');
  if (typed) {
    typed.type = 'password';
    $('#vf-eye-use').setAttribute('href', '#i-eye');
  }

  if (vaultPlaceTimer) clearTimeout(vaultPlaceTimer);
  vaultPlaceTimer = setTimeout(() => {
    if (!isOpen) forgetVaultPlace();
  }, VAULT_KEEP_MS);
}

/** Back to the top of the list, the way the tab looks when first opened. */
function forgetVaultPlace() {
  if (vaultPlaceTimer) clearTimeout(vaultPlaceTimer);
  vaultPlaceTimer = null;
  const had = !!vaultPlace;
  vaultPlace = null;
  closeVaultEntry();
  closeVaultForm();
  if (vaultSearch.value) vaultSearch.value = '';
  vaultGroup = null;
  document.body.classList.remove('vault-tree-open');
  if (had && vaultStatus.unlocked) refreshVaultList();
}

/** The shade opened again: carry on from the kept place, if it is still fresh. */
function resumeVaultPlace() {
  if (!vaultPlace) return;
  if (Date.now() - vaultPlace.at > VAULT_KEEP_MS || !vaultStatus.unlocked) {
    forgetVaultPlace();
    return;
  }
  if (vaultPlaceTimer) clearTimeout(vaultPlaceTimer);
  vaultPlaceTimer = null;
  // The card comes back masked; its one-time code starts ticking again.
  if (vaultEntryId && !vaultEntry.hidden) openVaultEntry(vaultEntryId);
  vaultPlace = null;
}

$('#ve-back').addEventListener('click', closeVaultEntry);
$('#ve-type').addEventListener('click', () => {
  if (vaultEntryId) vaultType(vaultEntryId);
});
$('#ve-edit').addEventListener('click', () => {
  if (!vaultEntryId) return;
  const id = vaultEntryId;
  closeVaultEntry();
  openVaultForm(id);
});

// --- adding an entry, and changing one --------------------------------------
const vaultForm = $('#vault-form');
let vaultFormId = null; // the entry being changed, or null for a new one

async function openVaultForm(id) {
  vaultFormId = id || null;
  const item = id ? vaultItems.find((e) => e.id === id) : null;

  $('#vf-title').textContent = item ? 'Изменить запись' : 'Новая запись';
  $('#vf-delete').hidden = !item;
  $('#vf-msg').textContent = '';
  $('#vf-msg').className = 'note';

  $('#vf-name').value = item ? item.title : '';
  $('#vf-user').value = item ? item.user : '';
  $('#vf-url').value = item ? item.url : '';
  $('#vf-notes').value = item ? item.notes : '';
  // The password is fetched rather than carried in the list, like every other
  // secret; the field starts empty for a new entry.
  $('#vf-password').value = item && item.hasPassword ? await api.vault.reveal(id, 'Password') : '';
  $('#vf-password').type = 'password';
  $('#vf-eye-use').setAttribute('href', '#i-eye');

  const picker = $('#vf-group');
  picker.textContent = '';
  for (const group of await api.vault.groups()) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.path;
    picker.append(option);
  }
  if (item) {
    const match = [...picker.options].find((o) => o.value === item.groupId || o.textContent === item.group);
    if (match) picker.value = match.value;
  } else if (vaultGroup) {
    // A new entry goes where the user is looking.
    picker.value = vaultGroup;
  }

  vaultForm.hidden = false;
  setTimeout(() => $('#vf-name').focus(), 50);
}

function closeVaultForm() {
  vaultFormId = null;
  vaultForm.hidden = true;
  // Nothing typed into the form outlives it, the password least of all.
  $('#vf-password').value = '';
  $('#vf-notes').value = '';
}

$('#vault-add').addEventListener('click', () => openVaultForm(null));
$('#vf-back').addEventListener('click', closeVaultForm);

$('#vf-eye').addEventListener('click', () => {
  const box = $('#vf-password');
  const shown = box.type === 'text';
  box.type = shown ? 'password' : 'text';
  $('#vf-eye-use').setAttribute('href', shown ? '#i-eye' : '#i-eye-off');
});

$('#vf-make').addEventListener('click', async () => {
  const made = await api.vault.generate({ length: 20 });
  const box = $('#vf-password');
  box.value = made;
  box.type = 'text';
  $('#vf-eye-use').setAttribute('href', '#i-eye-off');
});

vaultForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#vf-msg');
  const title = $('#vf-name').value.trim();
  if (!title) {
    msg.textContent = 'Без названия запись потом не найти';
    msg.className = 'note bad';
    return $('#vf-name').focus();
  }

  const fields = {
    Title: title,
    UserName: $('#vf-user').value,
    Password: $('#vf-password').value,
    URL: $('#vf-url').value,
    Notes: $('#vf-notes').value,
  };

  const save = $('#vf-save');
  save.disabled = true;
  msg.textContent = 'Сохраняем…';
  msg.className = 'note';

  const res = vaultFormId
    ? await api.vault.update(vaultFormId, fields, $('#vf-group').value)
    : await api.vault.create($('#vf-group').value, fields);
  save.disabled = false;

  if (!res || !res.ok) {
    msg.textContent = (res && res.error) || 'Не удалось сохранить';
    msg.className = 'note bad';
    return;
  }
  closeVaultForm();
  await refreshVaultList(true);
  toast(vaultFormId ? 'Запись изменена' : 'Запись добавлена');
});

$('#vf-delete').addEventListener('click', async () => {
  if (!vaultFormId) return;
  const button = $('#vf-delete');
  // Two presses rather than a dialog box: the shade has nowhere to put one,
  // and an accidental single click should not throw a password away.
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.classList.add('on');
    $('#vf-msg').textContent = 'Нажмите ещё раз, чтобы отправить запись в корзину базы';
    $('#vf-msg').className = 'note bad';
    setTimeout(() => {
      button.dataset.armed = '';
      button.classList.remove('on');
    }, 4000);
    return;
  }
  const res = await api.vault.remove(vaultFormId);
  button.dataset.armed = '';
  button.classList.remove('on');
  if (!res || !res.ok) {
    $('#vf-msg').textContent = (res && res.error) || 'Не удалось удалить';
    $('#vf-msg').className = 'note bad';
    return;
  }
  closeVaultForm();
  await refreshVaultList();
  toast(`«${res.title}» в корзине базы`);
});

// --- choosing the file ------------------------------------------------------
async function pickVaultFile(what) {
  const file = await api.vault.pickFile(what);
  if (!file) return;
  await api.app.setSetting(what === 'key' ? 'vaultKeyFile' : 'vaultPath', file);
  await loadVault(true);
  paintSettings();
}

// --- what the main process tells us ----------------------------------------
api.vault.onStatus((st) => {
  vaultStatus = st;
  paintVaultPanes();
  if (activeTab === 'vault' && st.unlocked) refreshVaultList(true);
});

api.vault.onWindow((w) => {
  vaultWindow = w;
  if (activeTab === 'vault') {
    paintVaultWindow();
    // With an empty search box the list is ordered by what suits the window,
    // so a new window means a new order.
    if (!vaultSearch.value.trim()) refreshVaultList(true);
  }
});

api.vault.onLocked((reason) => {
  vaultStatus = { ...vaultStatus, unlocked: false };
  paintVaultPanes();
  if (activeTab === 'vault') toast(`Пароли закрыты: ${reason}`);
});

api.vault.onList(() => {
  if (activeTab === 'vault') refreshVaultList(true);
});

api.vault.onTyped((res) => {
  if (!res || res.ok) return;
  toast(res.error || 'Не удалось напечатать');
});

api.vault.onCleared(() => toast('Пароль стёрт из буфера обмена'));

// The strip hints that the open database has something for the window in
// front. Nothing pops up and nothing takes the focus.
api.vault.onHint((on) => body.classList.toggle('vault-hint', !!on));

// Opened by its own hotkey: straight to the passwords, with the cursor where
// typing will do something.
api.vault.onOpen((payload) => {
  const front = payload && payload.window;
  // Summoned from a different window, the user wants what suits that window,
  // not the entry they were looking at for another site.
  if (vaultPlace && front && front.title !== vaultPlace.window) forgetVaultPlace();
  if (front) vaultWindow = front;
  selectTab('vault');
  if (vaultPlace) loadVault(false, true);
  else loadVault(true);
});

// ============================================================
//  settings and the first run
// ============================================================
const settingsPane = $('#settings');
const welcomePane = $('#welcome');

const HOTKEY_NAMES = {
  'Control+Alt+Space': 'Ctrl + Alt + Пробел',
  'Control+Shift+Space': 'Ctrl + Shift + Пробел',
  'Control+Alt+Q': 'Ctrl + Alt + Q',
  'Alt+Shift+V': 'Alt + Shift + V',
};

async function paintSettings() {
  const s = await api.app.settings();

  $('#set-version').textContent = s.version ? `версия ${s.version}` : '';
  $('#set-autostart').checked = s.autostart !== false;
  $('#set-launch').checked = s.launchPlayer === true;
  $('#set-images').checked = s.keepImages !== false;
  $('#set-clip-limit').value = String(s.clipLimit || 300);
  $('#set-update-url').value = s.updateUrl || '';

  // Pictures are kept at full quality as files, so what bounds the history is
  // disk rather than a count — worth showing what it is actually using.
  const budget = Number(s.imageBudget) || 2147483648;
  const picker = $('#set-image-budget');
  if (!picker.querySelector(`option[value="${budget}"]`)) {
    const extra = document.createElement('option');
    extra.value = String(budget);
    extra.textContent = `до ${humanBytes(budget)}`;
    picker.append(extra);
  }
  picker.value = String(budget);
  const used = (s.clipImages && s.clipImages.bytes) || 0;
  $('#set-images-used').textContent = used ? `— занято ${humanBytes(used)}` : '— пока пусто';

  // The chosen combination may have been taken by another program, in which
  // case the widget picked a free one — show what is actually in force.
  const hotkey = s.hotkey || 'Control+Alt+Space';
  if (!HOTKEY_NAMES[hotkey]) {
    const extra = document.createElement('option');
    extra.value = hotkey;
    extra.textContent = hotkey;
    $('#set-hotkey').append(extra);
  }
  $('#set-hotkey').value = hotkey;

  $('#set-account').textContent = yaStatus.connected
    ? `— ${yaStatus.login || 'подключён'}`
    : '— не подключён';

  const shortFile = (p) => (p ? String(p).split(/[\/]/).pop() : '');
  $('#set-vault-file').textContent = s.vaultPath ? `— ${shortFile(s.vaultPath)}` : '— не выбрана';
  $('#set-vault-key').textContent = s.vaultKeyFile ? `— ${shortFile(s.vaultKeyFile)}` : '— не обязательно';
  $('#set-vault-lock').value = String(s.vaultLockMinutes == null ? 10 : s.vaultLockMinutes);

  const passHotkey = s.passwordHotkey || 'Control+Alt+P';
  const passPicker = $('#set-vault-hotkey');
  if (!passPicker.querySelector(`option[value="${passHotkey}"]`)) {
    const extra = document.createElement('option');
    extra.value = passHotkey;
    extra.textContent = passHotkey;
    passPicker.append(extra);
  }
  passPicker.value = passHotkey;
}

function openSettings() {
  settingsPane.hidden = false;
  paintSettings();
}

const closeSettings = () => {
  settingsPane.hidden = true;
};

$('#set-back').addEventListener('click', closeSettings);

$('#set-hotkey').addEventListener('change', async (e) => {
  const next = await api.app.setSetting('hotkey', e.target.value);
  toast(
    next.hotkey === e.target.value
      ? `Панель открывается на ${HOTKEY_NAMES[next.hotkey] || next.hotkey}`
      : 'Сочетание занято, выбрано другое'
  );
  paintSettings();
});

$('#set-autostart').addEventListener('change', (e) => api.app.setSetting('autostart', e.target.checked));
$('#set-launch').addEventListener('change', (e) => api.app.setSetting('launchPlayer', e.target.checked));
$('#set-images').addEventListener('change', (e) => api.app.setSetting('keepImages', e.target.checked));
$('#set-image-budget').addEventListener('change', async (e) => {
  await api.app.setSetting('imageBudget', Number(e.target.value));
  paintSettings();
});
$('#set-clip-limit').addEventListener('change', (e) =>
  api.app.setSetting('clipLimit', Number(e.target.value))
);

$('#set-update-url').addEventListener('change', (e) =>
  api.app.setSetting('updateUrl', e.target.value.trim())
);

api.app.onUpdate((st) => {
  $('#set-update').textContent = st && st.message ? `— ${st.message}` : '';
  if (st && st.downloaded) toast('Обновление готово, встанет при выходе');
});

$('#set-vault-pick').addEventListener('click', () => pickVaultFile());
$('#set-vault-key-pick').addEventListener('click', () => pickVaultFile('key'));

$('#set-vault-clear').addEventListener('click', async () => {
  await api.app.setSetting('vaultPath', '');
  await loadVault();
  paintSettings();
  toast('База паролей отключена');
});

$('#set-vault-key-clear').addEventListener('click', async () => {
  await api.app.setSetting('vaultKeyFile', '');
  await loadVault();
  paintSettings();
});

$('#set-vault-lock').addEventListener('change', (e) =>
  api.app.setSetting('vaultLockMinutes', Number(e.target.value))
);

$('#set-vault-hotkey').addEventListener('change', async (e) => {
  const next = await api.app.setSetting('passwordHotkey', e.target.value);
  toast(next.passwordHotkey === e.target.value ? 'Сочетание для паролей изменено' : 'Сочетание занято, выбрано другое');
  paintSettings();
});

$('#set-center').addEventListener('click', () => {
  api.ui.center();
  toast('Панель вернулась на середину');
});

$('#set-account-btn').addEventListener('click', () => {
  closeSettings();
  openYa();
});

$('#set-update-btn').addEventListener('click', async () => {
  const btn = $('#set-update-btn');
  btn.disabled = true;
  $('#set-update').textContent = '— проверяем…';
  const res = await api.app.checkUpdate();
  btn.disabled = false;
  $('#set-update').textContent = res && res.message ? `— ${res.message}` : '';
});

// --- first run --------------------------------------------------------------
async function maybeWelcome() {
  const s = await api.app.settings();
  if (s.seenWelcome) return;

  const hotkey = s.hotkey || 'Control+Alt+Space';
  $('#wel-hotkey').textContent =
    `Открыть панель можно и с клавиатуры: ${HOTKEY_NAMES[hotkey] || hotkey}. ` +
    'Полоску можно вести вдоль любого края экрана, через углы и на соседний монитор — панель откроется там, где удобнее. ' +
    'Значок в трее держит те же настройки и выход.';
  welcomePane.hidden = false;
  api.ui.expand();
}

function closeWelcome() {
  welcomePane.hidden = true;
  api.app.setSetting('seenWelcome', true);
}

$('#wel-close').addEventListener('click', closeWelcome);

$('#wel-settings').addEventListener('click', () => {
  closeWelcome();
  openSettings();
});

$('#wel-login').addEventListener('click', () => {
  closeWelcome();
  openYa();
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
  if (act === 'settings') {
    closeMenu();
    return openSettings();
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
  if (!text) return;
  // The window stays on screen with the shade rolled up — it is a transparent
  // sheet across the top of the desktop. A bubble drawn now would hang there
  // on its own with nothing around it, which is what the wave did every time
  // it changed track behind a closed shade. Hold it until there is a panel.
  if (!isOpen) {
    heldToast = text;
    return;
  }
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#preview').hidden) return hidePreview();
    if (!vaultMenu.hidden) return closeVaultMenu();
    if (!vaultForm.hidden) return closeVaultForm();
    if (!vaultEntry.hidden) return closeVaultEntry();
    if (!welcomePane.hidden) return closeWelcome();
    if (!settingsPane.hidden) return closeSettings();
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
      vault: '#vault-search',
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
    smtcState = snap.state || { active: false };
    applyState(smtcState);
    setArt(snap.art && snap.art.data);
    // Through the same door as a live report, so the slider and its tooltip do
    // not quietly forget which player they belong to.
    applyVol(snap.vol);
  }
  loadClips();
  loadNotes();

  yaStatus = await api.ya.status();
  yaTrack = await api.ya.track();
  paintYaPanel();
  paintReactions();
}

// The greeting waits for the first refresh so it can name the live hotkey.
setTimeout(() => maybeWelcome().catch(() => {}), 1200);

(async function boot() {
  applyShadeSize(await api.ui.size());
  ytOrigin = await api.yt.origin();
  const s = await api.app.settings();
  lastTrack = s.lastTrack || null;
  words.on = s.lyrics === true;
  paintLyricsButton();
  applyTabOrder(s.tabOrder);
  selectTab(s.tab || 'music');
  paintVolume();
  await refreshAll();
})();
