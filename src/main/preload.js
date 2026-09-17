'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const { lineAt } = require('../shared/lrc');
const markdown = require('../shared/markdown');
const updateOffer = require('../shared/update-offer');
const mdEdit = require('../shared/md-edit');

// The panel asks which line is being sung several times a second. Handing the
// whole list across the bridge each time would copy it each time, so the lines
// stay here and only a number crosses.
let timedLines = [];

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

contextBridge.exposeInMainWorld('vidget', {
  ui: {
    onHover: on('ui:hover'),
    size: () => ipcRenderer.invoke('ui:size'),
    onSize: on('ui:size'),
    prepare: () => ipcRenderer.send('ui:prepare'),
    expand: () => ipcRenderer.send('ui:expand'),
    collapsed: () => ipcRenderer.send('ui:collapsed'),
    requestClose: () => ipcRenderer.send('ui:request-close'),
    grab: () => ipcRenderer.send('ui:grab'),
    release: () => ipcRenderer.send('ui:release'),
    moveStart: (x, y) => ipcRenderer.send('ui:move-start', { x, y }),
    move: (x, y) => ipcRenderer.send('ui:move', { x, y }),
    moveEnd: () => ipcRenderer.send('ui:move-end'),
    center: () => ipcRenderer.send('ui:center'),
    // Where the strip is drawn, relative to the window, so the main process knows
    // which part of it stops being click-through.
    grabZone: (rect) => ipcRenderer.send('ui:grab-zone', rect),
    onOpen: on('ui:open'),
    onClose: on('ui:close'),
  },
  media: {
    snapshot: () => ipcRenderer.invoke('media:snapshot'),
    cmd: (cmd, arg) => ipcRenderer.send('media:cmd', { cmd, arg }),
    onState: on('media:state'),
    onArt: on('media:art'),
    onVol: on('media:vol'),
  },
  clip: {
    list: () => ipcRenderer.invoke('clip:list'),
    full: (id) => ipcRenderer.invoke('clip:full', id),
    restore: (id) => ipcRenderer.invoke('clip:restore', id),
    remove: (id) => ipcRenderer.send('clip:remove', id),
    pin: (id) => ipcRenderer.send('clip:pin', id),
    clear: () => ipcRenderer.send('clip:clear'),
    onItems: on('clip:items'),
  },
  // Markdown for the notes: pure functions, run here where require works.
  md: {
    parse: (text) => markdown.parse(text),
    newLine: (text, start, end) => mdEdit.newLine(text, start, end),
    toggleWrap: (text, start, end, mark) => mdEdit.toggleWrap(text, start, end, mark),
    toggleTask: (text, line) => mdEdit.toggleTask(text, line),
  },
  notes: {
    openUrl: (url) => ipcRenderer.send('notes:open-url', url),
    list: () => ipcRenderer.invoke('notes:list'),
    create: (text) => ipcRenderer.invoke('notes:create', text),
    update: (id, text) => ipcRenderer.send('notes:update', { id, text }),
    remove: (id) => ipcRenderer.send('notes:remove', id),
    pin: (id) => ipcRenderer.send('notes:pin', id),
    onItems: on('notes:items'),
  },
  yt: {
    origin: () => ipcRenderer.invoke('yt:origin'),
    search: (query) => ipcRenderer.invoke('yt:search', query),
    open: (id) => ipcRenderer.send('yt:open', id),
  },
  player: {
    status: () => ipcRenderer.invoke('player:status'),
    launch: () => ipcRenderer.invoke('player:launch'),
  },
  ya: {
    status: () => ipcRenderer.invoke('ya:status'),
    track: () => ipcRenderer.invoke('ya:track'),
    login: () => ipcRenderer.invoke('ya:login'),
    connect: (token) => ipcRenderer.invoke('ya:connect', token),
    disconnect: () => ipcRenderer.invoke('ya:disconnect'),
    searchTracks: (query) => ipcRenderer.invoke('ya:search', query),
    waveStart: () => ipcRenderer.invoke('ya:wave-start'),
    waveNext: (playedId, playedSeconds) => ipcRenderer.invoke('ya:wave-next', { playedId, playedSeconds }),
    play: (id, albumId) => ipcRenderer.invoke('ya:play', { id, albumId }),
    stream: (id) => ipcRenderer.invoke('ya:stream', id),
    lyrics: (id) => ipcRenderer.invoke('ya:lyrics', id),
    // Timed lines live on this side; the panel asks for an index by seconds.
    setLines: (lines) => {
      timedLines = Array.isArray(lines) ? lines : [];
    },
    lineAt: (seconds) => lineAt(timedLines, seconds),
    // The own player's exact track, so the heart is never a guess.
    pinTrack: (t) =>
      ipcRenderer.send('ya:pin', t ? { id: t.id, albumId: t.albumId, title: t.title, artists: t.artists } : null),
    like: () => ipcRenderer.invoke('ya:like'),
    dislike: () => ipcRenderer.invoke('ya:dislike'),
    openAuth: () => ipcRenderer.send('ya:open-auth'),
    onStatus: on('ya:status'),
    onTrack: on('ya:track'),
    onArt: on('ya:art'),
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.send('vault:lock'),
    list: (query) => ipcRenderer.invoke('vault:list', query),
    forWindow: () => ipcRenderer.invoke('vault:for-window'),
    // One secret at a time, and only when something asks: the list the panel
    // holds never contains a password.
    reveal: (id, field) => ipcRenderer.invoke('vault:reveal', { id, field }),
    copy: (id, field, pastIndex) => ipcRenderer.invoke('vault:copy', { id, field, pastIndex }),
    totp: (id) => ipcRenderer.invoke('vault:totp', id),
    history: (id) => ipcRenderer.invoke('vault:history', id),
    past: (id, index, field) => ipcRenderer.invoke('vault:past', { id, index, field }),
    openUrl: (id) => ipcRenderer.invoke('vault:open-url', id),
    type: (id) => ipcRenderer.invoke('vault:type', id),
    saveAttachment: (id, name) => ipcRenderer.invoke('vault:save-attachment', { id, name }),
    pickFile: (what) => ipcRenderer.invoke('vault:pick-file', what),
    groups: () => ipcRenderer.invoke('vault:groups'),
    inGroup: (id) => ipcRenderer.invoke('vault:in-group', id),
    createGroup: (parentId, name) => ipcRenderer.invoke('vault:create-group', { parentId, name }),
    renameGroup: (id, name) => ipcRenderer.invoke('vault:rename-group', { id, name }),
    deleteGroup: (id) => ipcRenderer.invoke('vault:delete-group', id),
    create: (groupId, fields) => ipcRenderer.invoke('vault:create', { groupId, fields }),
    update: (id, fields, groupId) => ipcRenderer.invoke('vault:update', { id, fields, groupId }),
    remove: (id) => ipcRenderer.invoke('vault:delete', id),
    generate: (options) => ipcRenderer.invoke('vault:generate', options),
    onStatus: on('vault:status'),
    onLocked: on('vault:locked'),
    onList: on('vault:list'),
    onWindow: on('vault:window'),
    onHint: on('vault:hint'),
    onOpen: on('vault:open'),
    onTyped: on('vault:typed'),
    onCleared: on('vault:cleared'),
  },
  app: {
    settings: () => ipcRenderer.invoke('app:settings'),
    setSetting: (key, value) => ipcRenderer.invoke('app:set-setting', { key, value }),
    checkUpdate: () => ipcRenderer.invoke('app:check-update'),
    updateState: () => ipcRenderer.invoke('app:update-state'),
    updateNow: () => ipcRenderer.invoke('app:update-now'),
    skipUpdate: (version) => ipcRenderer.invoke('app:update-skip', version),
    shouldOffer: (state, skipped, dismissed) => updateOffer.shouldOffer(state, skipped, dismissed),
    onUpdate: on('app:update'),
    quit: () => ipcRenderer.send('app:quit'),
  },
});
