require('dotenv').config();
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
    lastTrackKey = key;
    lastActivityKey = activityKey;

    const artist = track.artist['#text'] || 'Unknown Artist';
    const song = track.name;
    const album = track.album['#text'] || '';
    const imageUrl = settings.showAlbumCover
      ? (track.image?.[3]?.['#text'] || track.image?.[2]?.['#text'] || '')
      : '';

    console.log(`[Playing] ${artist} - ${song}${album ? ` (${album})` : ''}`);

    const activity = {
      applicationId: discordClientId,
      name: formatName(artist, song, album),
      details: song,
      state: artist,
      type: settings.useListeningStatus ? 'LISTENING' : 'PLAYING',
      flags: ActivityFlags.FLAGS.INSTANCE,
      timestamps: { start: Date.now() },
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
