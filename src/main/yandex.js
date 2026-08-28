'use strict';

const { EventEmitter } = require('events');

const { mmss, coverUrl, norm } = require('../shared/format');
const { pickBestTrack } = require('../shared/match-track');

// The desktop client talks to this host; the like/dislike routes below are the
// ones it calls itself.
const API = 'https://api.music.yandex.net';
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const AUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${CLIENT_ID}`;

const TIMEOUT = 9000;
const LIKES_TTL = 10 * 60 * 1000;

// "Моя волна" is a rotor station; the API hands out a few tracks at a time and
// expects to hear back which of them were played.
const STATION = 'user:onyourwave';

/**
 * Likes and dislikes for the track SMTC says is playing.
 *
 * SMTC only hands us a title and an artist, so a track has to be resolved to a
 * Yandex id through search before it can be liked. Results are cached per
 * title+artist for the life of the process.
 */
class YandexMusic extends EventEmitter {
  constructor() {
    super();
    this.token = null;
    this.uid = null;
    this.login = null;
    this.error = null;

    this.liked = new Set();
    this.disliked = new Set();
    this.likesAt = 0;

    this.tracks = new Map(); // "artist|title" -> { id, albumId, cover } | null
    this.covers = new Map(); // track id -> data URL
    this.current = { key: null, id: null, albumId: null, cover: null, liked: false, disliked: false, state: 'idle' };
    this.tokenRejected = false;
    this._autoTimer = null;
    this.lastSeen = null;
    this.wave = { queue: [], batchId: null };
  }

  get connected() {
    return !!(this.token && this.uid);
  }

  authUrl() {
    return AUTH_URL;
  }

  status() {
    return {
      connected: this.connected,
      login: this.login,
      error: this.error,
      authUrl: AUTH_URL,
    };
  }

  // --- transport ------------------------------------------------------------
  async _req(path, { method = 'GET', query, json } = {}) {
    if (!this.token) throw new Error('Нет токена');
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `OAuth ${this.token}`,
        'Accept-Language': 'ru',
        'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (res.status === 401 || res.status === 403) throw new Error('Токен недействителен');
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body && body.error && (body.error.message || body.error.name);
      throw new Error(detail || `Яндекс ответил ${res.status}`);
    }
    return body;
  }

  // --- account --------------------------------------------------------------
  async connect(token) {
    this.token = (token || '').trim();
    this.error = null;
    if (!this.token) {
      this.disconnect();
      return this.status();
    }
    try {
      const body = await this._req('/account/status');
      const account = body && body.result && body.result.account;
      if (!account || !account.uid) throw new Error('Аккаунт не найден');
      this.uid = String(account.uid);
      this.login = account.displayName || account.login || null;
    } catch (err) {
      // A rejected token will never start working; anything else (no network
      // yet after a reboot, a hiccup at Yandex) is worth another try.
      this.tokenRejected = err.message === 'Токен недействителен';
      this.token = null;
      this.uid = null;
      this.login = null;
      this.error = err.message;
      this._pushStatus();
      return this.status();
    }
    this.tokenRejected = false;
    this._pushStatus();
    this.refreshLikes().catch(() => {});

    // A track that started before we signed in was skipped; resolve it now,
    // otherwise its cover and like state wait for the next track.
    if (this.lastSeen) {
      const seen = this.lastSeen;
      this.current.key = null;
      this.onTrack(seen.key, seen.artist, seen.title).catch(() => {});
    }
    return this.status();
  }

  /**
   * Keeps trying to sign in with the stored token. On a fresh boot the widget
   * usually starts before the network is up, so a single attempt is not enough.
   */
  startAutoConnect(getToken) {
    this.stopAutoConnect();
    const delays = [1000, 6000, 20000, 60000, 180000];
    let step = 0;

    const attempt = async () => {
      this._autoTimer = null;
      if (this.connected || this.tokenRejected) return;
      const token = getToken();
      if (!token) return;

      await this.connect(token);
      if (this.connected || this.tokenRejected || step >= delays.length - 1) return;
      step += 1;
      this._autoTimer = setTimeout(attempt, delays[step]);
    };

    this._autoTimer = setTimeout(attempt, delays[0]);
  }

  stopAutoConnect() {
    if (this._autoTimer) clearTimeout(this._autoTimer);
    this._autoTimer = null;
  }

  disconnect() {
    this.stopAutoConnect();
    this.tokenRejected = false;
    this.covers.clear();
    this.current = { key: null, id: null, albumId: null, cover: null, liked: false, disliked: false, state: 'idle' };
    this.token = null;
    this.uid = null;
    this.login = null;
    this.error = null;
    this.liked.clear();
    this.disliked.clear();
    this.likesAt = 0;
    this._pushStatus();
    this._pushTrack();
  }

  async refreshLikes(force = false) {
    if (!this.connected) return;
    if (!force && Date.now() - this.likesAt < LIKES_TTL) return;
    this.likesAt = Date.now();

    const pull = async (kind, target) => {
      const body = await this._req(`/users/${this.uid}/${kind}/tracks`);
      const list = (body && body.result && body.result.library && body.result.library.tracks) || [];
      target.clear();
      for (const t of list) target.add(String(t.id));
    };

    try {
      await Promise.all([pull('likes', this.liked), pull('dislikes', this.disliked)]);
    } catch (err) {
      this.likesAt = 0; // let the next attempt retry immediately
      this.error = err.message;
      this._pushStatus();
      return;
    }
    this._recheckCurrent();
  }

  // --- track resolution -----------------------------------------------------
  async onTrack(key, artist, title) {
    if (key) this.lastSeen = { key, artist, title };
    if (this.current.key === key) return;
    this.current = { key, id: null, albumId: null, cover: null, liked: false, disliked: false, state: 'idle' };
    if (!this.connected || !key || !title) {
      this._pushTrack();
      return;
    }

    if (this.tracks.has(key)) {
      this._apply(this.tracks.get(key));
      return;
    }

    this.current.state = 'resolving';
    this._pushTrack();

    let hit = null;
    try {
      hit = await this._search(artist, title);
    } catch (err) {
      this.error = err.message;
      this._pushStatus();
    }
    // A long listening session would otherwise remember every track forever.
    if (this.tracks.size > 500) this.tracks.clear();
    this.tracks.set(key, hit);
    if (this.current.key !== key) return; // track moved on while we searched
    this._apply(hit);
  }

  async _search(artist, title) {
    const text = [artist, title].filter(Boolean).join(' - ');
    const body = await this._req('/search', {
      query: { type: 'track', page: 0, nocorrect: false, text },
    });
    const results = body?.result?.tracks?.results || [];

    const best = pickBestTrack(results, artist, title);
    if (!best) return null;

    const album = best.albums && best.albums[0];
    return {
      id: String(best.id),
      albumId: album ? String(album.id) : null,
      cover: best.coverUri || (album && album.coverUri) || null,
    };
  }

  // --- Моя волна -----------------------------------------------------------
  /** Flattens a rotor track into what the panel needs to play it. */
  _waveTrack(entry) {
    const t = (entry && entry.track) || {};
    const album = (t.albums || [])[0];
    if (!t.id || !album) return null;
    return {
      id: String(t.id),
      albumId: String(album.id),
      title: t.title + (t.version ? ` (${t.version})` : ''),
      artists: (t.artists || []).map((a) => a.name).join(', '),
      duration: t.durationMs ? mmss(t.durationMs) : '',
      durationMs: t.durationMs || 0,
      cover: coverUrl(t.coverUri || album.coverUri, '200x200'),
      liked: this.liked.has(String(t.id)),
      wave: true,
    };
  }

  async _waveFetch(after) {
    const query = { settings2: true };
    if (after) query.queue = after;
    const body = await this._req(`/rotor/station/${STATION}/tracks`, { query });
    const result = (body && body.result) || {};
    this.wave.batchId = result.batchId || null;
    this.wave.queue = (result.sequence || []).map((e) => this._waveTrack(e)).filter(Boolean);
  }

  /** Best-effort: the station tunes itself from these, but nothing breaks without. */
  async _waveFeedback(type, extra = {}) {
    if (!this.connected) return;
    try {
      await this._req(`/rotor/station/${STATION}/feedback`, {
        method: 'POST',
        query: this.wave.batchId ? { 'batch-id': this.wave.batchId } : undefined,
        json: { type, timestamp: new Date().toISOString(), ...extra },
      });
    } catch {
      /* the station plays on regardless */
    }
  }

  /** First track of a fresh wave. */
  async waveStart() {
    if (!this.connected) return { ok: false, error: 'Аккаунт не подключён' };
    try {
      await this._waveFetch(null);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!this.wave.queue.length) return { ok: false, error: 'Волна ничего не вернула' };

    this._waveFeedback('radioStarted', { from: 'vidget' });
    return this.waveTake();
  }

  /** Next track of the running wave, refilling the queue when it runs dry. */
  async waveNext(playedId, playedSeconds) {
    if (!this.connected) return { ok: false, error: 'Аккаунт не подключён' };
    if (playedId) {
      this._waveFeedback('trackFinished', {
        trackId: String(playedId),
        totalPlayedSeconds: Math.max(0, Math.round(playedSeconds || 0)),
      });
    }
    if (!this.wave.queue.length) {
      try {
        await this._waveFetch(playedId || undefined);
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return this.waveTake();
  }

  waveTake() {
    const track = this.wave.queue.shift();
    if (!track) return { ok: false, error: 'Волна закончилась' };
    this._waveFeedback('trackStarted', { trackId: track.id });
    return { ok: true, track };
  }

  /** Track search for the panel's own search box. */
  async searchTracks(query, limit = 20) {
    const q = (query || '').trim();
    if (!q) return { ok: true, items: [] };
    if (!this.connected) return { ok: false, error: 'Аккаунт не подключён' };

    let body;
    try {
      body = await this._req('/search', { query: { type: 'track', page: 0, nocorrect: false, text: q } });
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const results = body?.result?.tracks?.results || [];
    const items = results.slice(0, limit).map((t) => {
      const album = t.albums && t.albums[0];
      const id = String(t.id);
      return {
        id,
        albumId: album ? String(album.id) : null,
        title: t.title + (t.version ? ` (${t.version})` : ''),
        artists: (t.artists || []).map((a) => a.name).join(', '),
        duration: t.durationMs ? mmss(t.durationMs) : '',
        durationMs: t.durationMs || 0,
        cover: coverUrl(t.coverUri || (album && album.coverUri), '100x100'),
        liked: this.liked.has(id),
      };
    });
    return { ok: true, items };
  }

  _apply(hit) {
    if (!hit) {
      this.current.state = 'unknown';
      this.current.id = null;
      this.current.albumId = null;
      this.current.cover = null;
    } else {
      this.current.id = hit.id;
      this.current.albumId = hit.albumId;
      this.current.cover = coverUrl(hit.cover, '200x200');
      this.current.state = 'ready';
      this.current.liked = this.liked.has(hit.id);
      this.current.disliked = this.disliked.has(hit.id);
    }
    this._pushTrack();
    if (hit) this._cover(this.current.key, hit).catch(() => {});
  }

  /**
   * Album art. SMTC gives none for the Yandex desktop player, but the search
   * result carries a cover template like "avatars.../%%" where %% is the size.
   */
  async _cover(key, hit) {
    if (!hit.cover) return;

    const cached = this.covers.get(hit.id);
    if (cached) {
      if (this.current.key === key) this.emit('art', { key, dataUrl: cached });
      return;
    }

    const res = await fetch(coverUrl(hit.cover, '400x400'), {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 4 * 1024 * 1024) return;

    const type = res.headers.get('content-type') || 'image/jpeg';
    const dataUrl = `data:${type};base64,${buf.toString('base64')}`;
    if (this.covers.size > 200) this.covers.clear();
    this.covers.set(hit.id, dataUrl);
    if (this.current.key === key) this.emit('art', { key, dataUrl });
  }

  _recheckCurrent() {
    if (!this.current.id) return;
    this.current.liked = this.liked.has(this.current.id);
    this.current.disliked = this.disliked.has(this.current.id);
    this._pushTrack();
  }

  // --- actions --------------------------------------------------------------
  async toggleLike() {
    const id = this.current.id;
    if (!this.connected) return { ok: false, error: 'Аккаунт не подключён' };
    if (!id) return { ok: false, error: 'Трек не найден в Яндекс Музыке' };

    const wasLiked = this.current.liked;
    try {
      if (wasLiked) {
        await this._req(`/users/${this.uid}/likes/tracks/${id}/remove`, { method: 'POST' });
        this.liked.delete(id);
      } else {
        await this._req(`/users/${this.uid}/likes/tracks/add`, { method: 'POST', query: { 'track-id': id } });
        this.liked.add(id);
        // A track cannot be liked and disliked at once.
        if (this.disliked.delete(id)) this.current.disliked = false;
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.current.liked = !wasLiked;
    this._pushTrack();
    return { ok: true, liked: this.current.liked };
  }

  async toggleDislike() {
    const id = this.current.id;
    if (!this.connected) return { ok: false, error: 'Аккаунт не подключён' };
    if (!id) return { ok: false, error: 'Трек не найден в Яндекс Музыке' };

    const wasDisliked = this.current.disliked;
    try {
      if (wasDisliked) {
        await this._req(`/users/${this.uid}/dislikes/tracks/${id}/remove`, { method: 'POST' });
        this.disliked.delete(id);
      } else {
        await this._req(`/users/${this.uid}/dislikes/tracks/add`, { method: 'POST', query: { 'track-id': id } });
        this.disliked.add(id);
        if (this.liked.delete(id)) this.current.liked = false;
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }
    this.current.disliked = !wasDisliked;
    this._pushTrack();
    return { ok: true, disliked: this.current.disliked };
  }

  trackState() {
    return { ...this.current };
  }

  _pushStatus() {
    this.emit('status', this.status());
  }

  _pushTrack() {
    this.emit('track', this.trackState());
  }
}

module.exports = { YandexMusic };
