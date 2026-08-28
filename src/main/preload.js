'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

contextBridge.exposeInMainWorld('vidget', {
  ui: {
    onHover: on('ui:hover'),
    prepare: () => ipcRenderer.send('ui:prepare'),
    expand: () => ipcRenderer.send('ui:expand'),
    collapsed: () => ipcRenderer.send('ui:collapsed'),
    requestClose: () => ipcRenderer.send('ui:request-close'),
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
  notes: {
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
    play: (id, albumId) => ipcRenderer.invoke('ya:play', { id, albumId }),
    like: () => ipcRenderer.invoke('ya:like'),
    dislike: () => ipcRenderer.invoke('ya:dislike'),
    openAuth: () => ipcRenderer.send('ya:open-auth'),
    onStatus: on('ya:status'),
    onTrack: on('ya:track'),
    onArt: on('ya:art'),
  },
  app: {
    settings: () => ipcRenderer.invoke('app:settings'),
    setSetting: (key, value) => ipcRenderer.invoke('app:set-setting', { key, value }),
    quit: () => ipcRenderer.send('app:quit'),
  },
});
