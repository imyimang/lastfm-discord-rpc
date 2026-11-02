require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, RichPresence, Activity, ActivityFlags, RichPresenceAssets } = require('discord.js-selfbot-v13');
const fetch = require('node-fetch').default;
const settings = require('./config.json');

// Monkey-patch Activity to preserve fields not handled by the library
const origPatch = Activity.prototype._patch;
Activity.prototype._patch = function (data) {
  origPatch.call(this, data);
  if ('status_display_type' in data) this.status_display_type = data.status_display_type;
  if ('details_url' in data) this.details_url = data.details_url;
  if ('state_url' in data) this.state_url = data.state_url;
};

// Monkey-patch RichPresenceAssets to preserve large_url / small_url
const origAssetsPatch = RichPresenceAssets.prototype._patch;
RichPresenceAssets.prototype._patch = function (assets) {
  origAssetsPatch.call(this, assets);
  if (assets?.large_url) this.large_url = assets.large_url;
  if (assets?.small_url) this.small_url = assets.small_url;
};
const origAssetsToJSON = RichPresenceAssets.prototype.toJSON;
RichPresenceAssets.prototype.toJSON = function () {
  const base = origAssetsToJSON.call(this);
  if (!base) return null;
  if (this.large_url) base.large_url = this.large_url;
  if (this.small_url) base.small_url = this.small_url;
  return base;
};

// Secrets from .env, settings from config.json
const discordToken = process.env.DISCORD_TOKEN;
const discordClientId = process.env.DISCORD_CLIENT_ID;
const apiKey = process.env.LASTFM_API_KEY;
const username = settings.username;

if (!discordToken || !discordClientId || !apiKey || !username) {
  console.error('[Config] Missing required fields. Check .env (DISCORD_TOKEN, DISCORD_CLIENT_ID, LASTFM_API_KEY) and config.json (username)');
  process.exit(1);
}

console.log(`[Config] hideWithSpotify=${settings.hideWithSpotify}, hideWithActivity=${settings.hideWithActivity}`);

const client = new Client({ checkUpdate: false });
let lastTrackKey = null;
let lastActivityKey = null;
let reconnectTimer = null;
let intervalTimer = null;
let cachedAssets = new Map();
let cachedSmallImage = null;
let externalActivities = [];
const durationCache = new Map();

const DURATION_CACHE_FILE = path.join(__dirname, 'data', 'duration-cache.json');
const NEGATIVE_CACHE_TTL = 24 * 60 * 60 * 1000;
const MUSICBRAINZ_USER_AGENT = 'lastfm-discord-rpc/1.0';

const LASTFM_LOGO = 'https://www.last.fm/static/images/lastfm_avatar_twitter.png';

function buildTrackKey(track) {
  return `${track.artist['#text'] || ''} - ${track.name} - ${track.album['#text'] || ''}`;
}

function buildActivityKey(track) {
  return `${track.artist['#text'] || ''} - ${track.name} - ${track.album['#text'] || ''} - ${settings.statusDisplayType} - ${settings.nameFormat} - ${settings.useListeningStatus}`;
}

function formatName(artist, song, album) {
  switch (settings.nameFormat) {
    case 'artist-first': return `${artist} - ${song}`;
    case 'song-first':   return `${song} - ${artist}`;
    case 'artist':       return artist;
    case 'song':         return song;
    case 'album':        return album || artist;
    default:
      return settings.statusName
        .replace(/\{artist\}/g, artist)
        .replace(/\{title\}/g, song)
        .replace(/\{album\}/g, album || artist);
  }
}

function statusDisplayTypeValue() {
  switch (settings.statusDisplayType) {
    case 'artist': return 1;
    case 'track':  return 2;
    default:       return undefined;
  }
}

function isOtherActivityActive() {
  for (const a of externalActivities) {
    if (settings.hideWithSpotify && a.name === 'Spotify') {
      console.log('[Hide] Spotify detected, hiding Last.fm presence');
      return true;
    }
    if (settings.hideWithActivity) {
      console.log(`[Hide] External activity "${a.name}" detected, hiding`);
      return true;
    }
  }
  return false;
}

async function getCurrentTrack() {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${username}&api_key=${apiKey}&format=json&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const track = data?.recenttracks?.track?.[0];
    if (track?.['@attr']?.nowplaying === 'true') return track;
  } catch (e) {
    console.error(`[Last.fm] ${e.message}`);
  }
  return null;
}

function loadDurationCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(DURATION_CACHE_FILE, 'utf8'));
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.t === 'number' && (typeof entry.d === 'number' || entry.d === null)) {
        durationCache.set(key, entry);
      }
    }
    console.log(`[Cache] Loaded ${durationCache.size} duration entries`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Cache] Load failed:', e.message);
  }
}

function saveDurationCache() {
  try {
    fs.mkdirSync(path.dirname(DURATION_CACHE_FILE), { recursive: true });
    const tmp = `${DURATION_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(durationCache)));
    fs.renameSync(tmp, DURATION_CACHE_FILE);
  } catch (e) {
    console.error('[Cache] Save failed:', e.message);
  }
}

function getCachedDuration(key) {
  const entry = durationCache.get(key);
  if (!entry) return undefined;
  if (entry.d === null && Date.now() - entry.t > NEGATIVE_CACHE_TTL) {
    durationCache.delete(key);
    return undefined;
  }
  return entry.d;
}

function setCachedDuration(key, duration) {
  durationCache.set(key, { d: duration ?? null, t: Date.now() });
  if (durationCache.size > 2000) durationCache.delete(durationCache.keys().next().value);
  saveDurationCache();
}

function isValidDuration(ms) {
  return Number.isFinite(ms) && ms >= 30000 && ms <= 3600000;
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\(\[][^)\]]*(feat|ft)\.?[^)\]]*[\)\]]/gi, ' ')
    .replace(/\s+(feat|ft)\.?\s+.*$/i, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasVersionTag(value) {
  return /\b(live|remix|remaster(ed)?|karaoke|instrumental|acoustic|cover|edit|demo)\b/i.test(value || '');
}

function looksLikeLive(candidate) {
  if (candidate.live) return true;
  if (hasVersionTag(candidate.title)) return true;
  return /live|演唱會|演唱会|ライブ|ライヴ/i.test(candidate.album || '');
}

function scoreCandidate(candidate, target) {
  const title = normalizeText(candidate.title);
  const targetTitle = normalizeText(target.title);
  if (!title || !targetTitle) return -Infinity;

  const artist = normalizeText(candidate.artist);
  const targetArtist = normalizeText(target.artist);
  if (targetArtist && artist && !(artist === targetArtist || artist.includes(targetArtist) || targetArtist.includes(artist))) {
    return -Infinity;
  }

  const album = normalizeText(candidate.album);
  const targetAlbum = normalizeText(target.album);
  const albumMatch = Boolean(targetAlbum && album && album === targetAlbum);

  let score = 0;
  if (title === targetTitle) score += 5;
  else if (title.includes(targetTitle) || targetTitle.includes(title)) score += 3;
  else if (!albumMatch) return -Infinity;

  if (targetArtist && artist) score += artist === targetArtist ? 3 : 2;
  if (albumMatch) score += 2;
  if (looksLikeLive(candidate) && !hasVersionTag(target.title) && !/live|演唱會|演唱会|ライブ|ライヴ/i.test(target.album || '')) {
    score -= 10;
  }

  return score;
}

function pickBestDuration(candidates, target) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!isValidDuration(candidate.duration)) continue;
    const score = scoreCandidate(candidate, target);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best?.duration ?? null;
}

async function fetchLastfmDuration(track) {
  const artist = track.artist['#text'] || '';
  const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track.name)}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const ms = parseInt(data?.track?.duration, 10);
  if (isValidDuration(ms)) return ms;
  if (data?.track?.duration) console.log(`[Last.fm] Suspicious duration "${data.track.duration}" for ${artist} - ${track.name}`);
  return null;
}

async function fetchItunesDuration(track) {
  const artist = track.artist['#text'] || '';
  const term = [artist, track.name].filter(Boolean).join(' ');
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=25`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const candidates = (data.results || []).map(r => ({
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName,
    duration: r.trackTimeMillis,
  }));
  return pickBestDuration(candidates, {
    title: track.name,
    artist,
    album: track.album['#text'] || '',
  });
}

let musicbrainzLastRequest = 0;

async function throttleMusicbrainz() {
  const wait = 1100 - (Date.now() - musicbrainzLastRequest);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  musicbrainzLastRequest = Date.now();
}

function escapeLucene(value) {
  return String(value ?? '').replace(/[\\"]/g, '\\$&');
}

async function fetchMusicbrainzDuration(track) {
  await throttleMusicbrainz();
  const artist = track.artist['#text'] || '';
  const query = `artist:"${escapeLucene(artist)}" AND recording:"${escapeLucene(track.name)}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`;
  const res = await fetch(url, {
    headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const candidates = (data.recordings || []).map(r => ({
    title: r.title,
    artist: (r['artist-credit'] || []).map(a => a.name).join(''),
    album: r.releases?.[0]?.title || '',
    duration: r.length,
    live: (r.releases || []).some(rel =>
      (rel['release-group']?.['secondary-types'] || []).some(type => /live/i.test(type))),
  }));
  return pickBestDuration(candidates, {
    title: track.name,
    artist,
    album: track.album['#text'] || '',
  });
}

const DURATION_PROVIDERS = [
  ['lastfm', fetchLastfmDuration],
  ['itunes', fetchItunesDuration],
  ['musicbrainz', fetchMusicbrainzDuration],
];

async function getTrackDuration(track, key) {
  const cached = getCachedDuration(key);
  if (cached !== undefined) return cached;

  const artist = track.artist['#text'] || '';
  for (const [name, resolver] of DURATION_PROVIDERS) {
    try {
      const duration = await resolver(track);
      if (duration) {
        console.log(`[Duration] ${artist} - ${track.name} -> ${Math.round(duration / 1000)}s (${name})`);
        setCachedDuration(key, duration);
        return duration;
      }
    } catch (e) {
      console.error(`[Duration] ${name} failed: ${e.message}`);
    }
  }

  console.log(`[Duration] ${artist} - ${track.name} -> no length found, progress bar disabled for this track`);
  setCachedDuration(key, null);
  return null;
}

loadDurationCache();

async function resolveImage(imageUrl) {
  if (!imageUrl) return null;
  const cached = cachedAssets.get(imageUrl);
  if (cached) return cached;
  try {
    const [asset] = await RichPresence.getExternal(client, discordClientId, imageUrl);
    if (asset?.external_asset_path) {
      cachedAssets.set(imageUrl, asset.external_asset_path);
      return asset.external_asset_path;
    }
  } catch (e) {
    console.error('[Image] Failed to resolve:', e.message);
  }
  return null;
}

async function updatePresence() {
  if (!client.user) return;

  try {
    if (isOtherActivityActive()) {
      if (lastTrackKey !== null) {
        console.log('[Status] Other activity detected, clearing Last.fm presence');
        await client.user.setPresence({ activities: [], status: 'online' });
        lastTrackKey = null;
      }
      return;
    }

    const track = await getCurrentTrack();

    if (!track) {
      if (lastTrackKey !== null) {
        console.log('[Status] No track playing, clearing presence');
        await client.user.setPresence({ activities: [], status: 'online' });
        lastTrackKey = null;
      }
      return;
    }

    const key = buildTrackKey(track);
    const activityKey = buildActivityKey(track);
    if (key === lastTrackKey && activityKey === lastActivityKey) return;

    const artist = track.artist['#text'] || 'Unknown Artist';
    const song = track.name;
    const album = track.album['#text'] || '';
    const imageUrl = settings.showAlbumCover
      ? (track.image?.[3]?.['#text'] || track.image?.[2]?.['#text'] || '')
      : '';

    console.log(`[Playing] ${artist} - ${song}${album ? ` (${album})` : ''}`);

    const duration = settings.showProgressBar !== false
      ? await getTrackDuration(track, key)
      : null;

    const start = Date.now();
    const timestamps = { start };
    if (duration) {
      timestamps.end = start + duration;
      console.log(`[Progress] duration=${Math.round(duration / 1000)}s start=${new Date(start).toISOString()} end=${new Date(timestamps.end).toISOString()}`);
    }

    const activity = {
      applicationId: discordClientId,
      name: formatName(artist, song, album),
      details: song,
      state: artist,
      type: settings.useListeningStatus ? 'LISTENING' : 'PLAYING',
      flags: ActivityFlags.FLAGS.INSTANCE,
      timestamps,
    };

    const sdt = statusDisplayTypeValue();
    if (sdt !== undefined) activity.status_display_type = sdt;

    if (settings.clickableLinks) {
      const encArtist = encodeURIComponent(artist.replace(/&/g, 'and'));
      const encSong = encodeURIComponent(song.replace(/&/g, 'and'));
      activity.details_url = `https://www.last.fm/music/${encArtist}/_/${encSong}`;
      activity.state_url = `https://www.last.fm/music/${encArtist}`;
    }

    if (settings.shareUsername) {
      activity.buttons = ['Last.fm Profile'];
      activity.metadata = { button_urls: [`https://www.last.fm/user/${username}`] };
    }

    const fallbackUrl = !imageUrl && settings.missingArt === 'lastfmLogo' ? LASTFM_LOGO : '';
    const [largePath, smallPath] = await Promise.all([
      (imageUrl || fallbackUrl) ? resolveImage(imageUrl || fallbackUrl) : Promise.resolve(null),
      settings.showLastFmLogo
        ? (cachedSmallImage ?? resolveImage(LASTFM_LOGO).then(p => { cachedSmallImage = p; return p; }))
        : Promise.resolve(null),
    ]);

    activity.assets = { largeText: album || song };
    if (largePath) {
      activity.assets.largeImage = largePath;
      if (settings.clickableLinks) {
        activity.assets.large_url = `https://www.last.fm/music/${encodeURIComponent(artist.replace(/&/g, 'and'))}/${encodeURIComponent(album ? album.replace(/&/g, 'and') : song.replace(/&/g, 'and'))}`;
      }
    }
    if (smallPath) {
      activity.assets.smallImage = smallPath;
      activity.assets.smallText = 'Last.fm';
    }

    await client.user.setPresence({ activities: [activity], status: 'online' });
    lastTrackKey = key;
    lastActivityKey = activityKey;
  } catch (e) {
    console.error('[Presence] Update failed:', e.message);
  }
}

function startPolling() {
  updatePresence();
  intervalTimer = setInterval(updatePresence, 5000);
}

function stopPolling() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

function scheduleReconnect(delay = 10000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  console.log(`[Reconnect] Retrying in ${delay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    client.login(discordToken).catch(() => {});
  }, delay);
}

client.on('ready', () => {
  console.log(`[Discord] Logged in as: ${client.user.tag}`);
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  externalActivities = (client.user.presence?.activities || []).filter(
    a => a.applicationId !== discordClientId && a.name !== 'Custom Status',
  );
  startPolling();
});

client.on('raw', packet => {
  if (packet.t !== 'SESSIONS_REPLACE') return;
  const acts = [];
  for (const session of packet.d || []) {
    if (session.activities?.length) {
      for (const a of session.activities) {
        if (a.application_id !== discordClientId && a.name !== 'Custom Status') {
          acts.push(a);
        }
      }
    }
  }
  if (acts.length) {
    console.log('[Detect] External activities:', acts.map(a => `${a.name}`).join(', '));
  }
  externalActivities = acts;
});

client.on('disconnected', () => {
  console.warn('[Discord] Connection lost');
  stopPolling();
  scheduleReconnect(10000);
});

process.on('SIGINT', () => {
  console.log('\n[Shutdown] Received interrupt signal');
  stopPolling();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled]', err?.message || err);
});

client.login(discordToken).catch(err => {
  console.error('[Login] Failed:', err.message);
  scheduleReconnect(15000);
});
