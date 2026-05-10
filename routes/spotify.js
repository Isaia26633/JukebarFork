const express = require('express');
const router = express.Router();
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const db = require('../utils/database');
const { logTransaction } = require('./logging');
const queueManager = require('../utils/queueManager');
const { isAuthenticated } = require('../middleware/auth');
const { getCurrentClassId } = require('./socket');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    READ,
    MODIFY,
    playbackRateLimit,
    executePlaybackRead,
    executePlaybackModify,
    setSpotifyPlaybackCooldown
} = require('../middleware/spotifyPlaybackRateLimit');

/** Push Spotify state to all sockets soon after a playback-changing action. */
function scheduleImmediateSpotifyQueueSync() {
    setImmediate(() => {
        queueManager.syncWithSpotify(spotifyApi).catch((err) => {
            console.warn('[queue] immediate Spotify sync:', err?.message || err);
        });
    });
}

// Play random sound from /sfx folder
let isPlayingSound = false;

const APRIL_FOOLS_URI = 'spotify:track:0rQvvjAkX1B0gcJwjEGQZW';
const APRIL_FOOLS_CHANCE = 0.3; // 30% chance
const SEARCH_CACHE_TTL_MS = 12_000;
/** Minimum time between POST /search calls per user (stricter = fewer Spotify search API hits). */
const SEARCH_MIN_INTERVAL_MS = 2500;
/** Rolling cap: max search requests per user within the window (in addition to min interval). */
const SEARCH_BURST_WINDOW_MS = 60 * 1000;
const SEARCH_MAX_PER_WINDOW = 8;
const SEARCH_CACHE_MAX_ITEMS = 500;
const searchResponseCache = new Map();
const searchRequesterLastAt = new Map();
const searchRequesterBurstTimestamps = new Map();
let spotifySearchRateLimitedUntil = 0;

function isAprilFools() {
    const now = new Date();
    return now.getMonth() === 3 && now.getDate() === 1; // month is 0-indexed
}

function shouldAprilFool() {
    return isAprilFools() && Math.random() < APRIL_FOOLS_CHANCE;
}

function getSearchRequesterKey(req) {
    return String(req.session?.userId || req.ip || 'anonymous');
}

function pruneSearchBurstTimestamps(requesterKey, now) {
    const cutoff = now - SEARCH_BURST_WINDOW_MS;
    let ts = searchRequesterBurstTimestamps.get(requesterKey);
    if (!ts) {
        ts = [];
    } else {
        ts = ts.filter((t) => t > cutoff);
    }
    searchRequesterBurstTimestamps.set(requesterKey, ts);
    return ts;
}

/** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
function tryConsumeSearchBurstSlot(requesterKey, now) {
    const ts = pruneSearchBurstTimestamps(requesterKey, now);
    if (ts.length >= SEARCH_MAX_PER_WINDOW) {
        const oldest = ts[0];
        return { ok: false, retryAfterMs: Math.max(1, SEARCH_BURST_WINDOW_MS - (now - oldest)) };
    }
    ts.push(now);
    searchRequesterBurstTimestamps.set(requesterKey, ts);
    return { ok: true };
}

function sendSearchClientRateLimit(res, message, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSeconds: retryAfterSec
    });
}

function pruneSearchCache(now) {
    if (searchResponseCache.size > SEARCH_CACHE_MAX_ITEMS) {
        const entries = [...searchResponseCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const removeCount = Math.ceil(entries.length * 0.2);
        for (let i = 0; i < removeCount; i++) {
            searchResponseCache.delete(entries[i][0]);
        }
    }

    for (const [key, value] of searchResponseCache.entries()) {
        if ((now - value.timestamp) > SEARCH_CACHE_TTL_MS) {
            searchResponseCache.delete(key);
        }
    }
}

function playRandomBlockedSound() {
    if (isPlayingSound) {
        console.log('Already playing a sound; skipping');
        return null;
    }

    try {
        const sfxDir = path.join(__dirname, '..', 'public', 'sfx');
        const files = fs.readdirSync(sfxDir).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));

        if (files.length === 0) {
            console.warn('No sound files found in /sfx');
            return null;
        }

        const randomFile = files[Math.floor(Math.random() * files.length)];
        const soundPath = path.join(sfxDir, randomFile);

        console.log(`Playing blocked sound: ${randomFile}`);
        isPlayingSound = true;

        exec(`omxplayer "${soundPath}"`, (err) => {
            isPlayingSound = false;
            if (err) console.error('Error playing sound:', err);
        });

        return randomFile; // Return filename for logging
    } catch (err) {
        isPlayingSound = false;
        console.error('Error in playRandomBlockedSound:', err);
        return null;
    }
}

// Helpers for banned songs
function getBannedSongs() {
    return new Promise((resolve, reject) => {
        db.all('SELECT track_name, artist_name FROM banned_songs', (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function isTrackBannedByNameArtist(name, artist) {
    try {
        const banned = await getBannedSongs();
        const n = (name || '').trim().toLowerCase();
        const a = (artist || '').trim().toLowerCase();
        return banned.some(b => {
            const bannedName = (b.track_name || '').trim().toLowerCase();
            const bannedArtist = (b.artist_name || '').trim().toLowerCase();
            return n.startsWith(bannedName) && bannedArtist === a;
        });
    } catch (e) {
        console.error('Error checking banned songs:', e);
        return false;
    }
}

/** Spotify /v1/search — limit must be 1–10; higher values return 400 Invalid limit. */
const SPOTIFY_SEARCH_LIMIT_MAX = 10;

// Store currently playing track info (legacy - use queueManager instead)
let currentTrack = null;

// Helper function to handle Spotify API errors consistently
function handleSpotifyError(error, res, action = 'operation') {
    // spotify-web-api-node WebapiError sets error.message = String(body) when the body object
    // is passed directly to Error(), producing the sentinel "[object Object]".
    // Fall through it and extract from error.body instead.
    const rawMsg = error?.message;
    let errMsg;
    if (typeof rawMsg === 'string' && rawMsg && rawMsg !== '[object Object]') {
        errMsg = rawMsg;
    } else {
        const bodyMsg = error?.body?.error?.message;
        if (typeof bodyMsg === 'string' && bodyMsg) {
            errMsg = bodyMsg;
        } else if (error?.body && typeof error.body === 'object') {
            try { errMsg = JSON.stringify(error.body); } catch { errMsg = String(error); }
        } else {
            errMsg = String(error);
        }
    }
    console.error(`Spotify ${action} error [${error?.statusCode ?? 'unknown'}]: ${errMsg}`);

    const spotifyStatus = Number(error?.statusCode) || 500;
    const spotifyBody = error?.body || null;
    const spotifyMessage =
        (typeof error?.body?.error?.message === 'string' && error.body.error.message) ||
        (typeof rawMsg === 'string' && rawMsg && rawMsg !== '[object Object]' ? rawMsg : null) ||
        errMsg;

    // Handle network connectivity errors
    if (error.code === 'EAI_AGAIN' || error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return res.status(503).json({
            ok: false,
            error: 'Unable to connect to Spotify. Please check your internet connection and try again.',
            spotifyStatus,
            spotifyError: spotifyMessage
        });
    }

    // Handle authentication errors
    if (error.statusCode === 401) {
        return res.status(401).json({
            ok: false,
            error: spotifyMessage || 'Spotify authentication failed',
            spotifyStatus,
            spotifyBody
        });
    }

    // Handle rate limiting
    if (error.statusCode === 429) {
        return res.status(429).json({
            ok: false,
            error: spotifyMessage || 'Too many requests to Spotify. Please wait a moment and try again.',
            spotifyStatus,
            spotifyBody
        });
    }

    // Handle 404 errors (no active device)
    if (error.statusCode === 404) {
        return res.status(400).json({
            ok: false,
            error: spotifyMessage || 'No active Spotify playback found. Please start playing music on a Spotify device first.',
            spotifyStatus,
            spotifyBody
        });
    }

    // Generic error
    return res.status(spotifyStatus).json({
        ok: false,
        error: spotifyMessage || `Failed to ${action}`,
        spotifyStatus,
        spotifyBody
    });
}

function formatSpotifyErrorForLog(error) {
    const status = error?.statusCode ?? 'unknown';
    const message =
        error?.body?.error?.message ||
        (typeof error?.message === 'string' && error.message !== '[object Object]' ? error.message : null) ||
        'Unknown Spotify error';
    let body = '';
    if (error?.body && typeof error.body === 'object') {
        try { body = ` body=${JSON.stringify(error.body)}`; } catch { body = ''; }
    }
    return `[${status}] ${message}${body}`;
}

async function fetchAllUserPlaylists() {
    const allItems = [];
    const limit = 50;
    let offset = 0;

    while (true) {
        const playlistData = await spotifyApi.getUserPlaylists({ limit, offset });
        const items = playlistData.body?.items || [];
        allItems.push(...items);
        if (items.length < limit) break;
        offset += limit;
    }

    return allItems;
}

/** Spotify Connect device for pause/play when the active target is ambiguous. */
async function resolveSpotifyDeviceId(req) {
    let deviceId = null;
    try {
        const stateRes = await executePlaybackRead(req, 'playback-device-state', () =>
            spotifyApi.getMyCurrentPlaybackState()
        );
        deviceId = stateRes?.body?.device?.id || null;
    } catch (e) {
        console.warn('[spotify] getMyCurrentPlaybackState:', e?.message || e);
    }
    if (!deviceId) {
        try {
            const devRes = await executePlaybackRead(req, 'playback-device-list', () => spotifyApi.getMyDevices());
            const list = devRes?.body?.devices || [];
            const active = list.find((d) => d.is_active);
            deviceId = active?.id || list[0]?.id || null;
        } catch (e) {
            console.warn('[spotify] getMyDevices:', e?.message || e);
        }
    }
    return deviceId;
}

function spotifyRestrictionErrorMessage() {
    return 'Spotify refused this playback command. Common causes: Spotify Premium is required for Web API control, the account cannot control this device, or ads are playing. Try another Spotify Connect device or the official Spotify app.';
}

async function fetchPlaylistTracks(playlistId) {
    await ensureSpotifyAccessToken();
    const tracks = [];
    let offset = 0;
    const limit = 100;
    let fetchError = null;

    while (true) {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items?limit=${limit}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` }
        });

        if (!res.ok) {
            const body = await res.text();
            console.error(`[fetchPlaylistTracks] Spotify returned ${res.status} at offset=${offset}: ${body}`);
            if (res.status === 403) {
                fetchError = { status: 403, message: 'Spotify denied access to this playlist. The connected Spotify account must own or collaborate on the playlist (Feb 2026 API change).' };
            } else if (res.status === 429) {
                const retryAfter = res.headers.get('retry-after');
                console.warn(`[fetchPlaylistTracks] Rate limited. Retry-After: ${retryAfter}s`);
                fetchError = { status: 429, message: `Rate limited by Spotify. Try again in ${retryAfter || 'a few'} seconds.` };
            } else {
                fetchError = { status: res.status, message: `Spotify returned HTTP ${res.status} when fetching playlist tracks.` };
            }
            break;
        }

        const data = await res.json();
        const items = data?.items || [];
        console.log(`[fetchPlaylistTracks] offset=${offset} fetched=${items.length} total=${data?.total ?? '?'}`);
        tracks.push(...items);
        if (items.length < limit || (data?.total && tracks.length >= data.total)) break;
        offset += limit;
    }

    return { tracks, error: fetchError };
}

function computePlaylistCost(trackCount) {
    const songAmount = Number(process.env.SONG_AMOUNT) || 50;
    return Math.min(Math.round(songAmount * Math.sqrt(trackCount)), 500);
}

function isTrackBanned(t, bannedPairs) {
    const name = (t.name || '').trim().toLowerCase();
    const artist = (t.artists || []).map(a => a.name).join(', ').trim().toLowerCase();
    return bannedPairs.has(`${name}::${artist}`);
}

async function getQueueUriSet() {
    const queueUris = new Set((queueManager.queue || []).map((track) => track?.uri).filter(Boolean));
    const currentUri = queueManager.currentTrack?.uri;
    if (currentUri) queueUris.add(currentUri);
    return queueUris;
}

async function getQueueablePlaylistTracks(playlistId) {
    const [fetchResult, bannedSongs, queueUris] = await Promise.all([
        fetchPlaylistTracks(playlistId),
        getBannedSongs(),
        getQueueUriSet()
    ]);
    const rawItems = fetchResult.tracks;

    const bannedPairs = new Set(
        (bannedSongs || []).map((row) => `${(row.track_name || '').trim().toLowerCase()}::${(row.artist_name || '').trim().toLowerCase()}`)
    );

    const queueableTracks = [];
    const skipped = { unplayable: 0, banned: 0, duplicate: 0 };

    for (const item of rawItems) {
        const track = item?.item ?? item?.track; // .track renamed to .item in Feb 2026 Spotify API changes
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            skipped.unplayable += 1;
            continue;
        }

        const name = (track.name || '').trim();
        const artist = (track.artists || []).map((a) => a.name).join(', ').trim();
        const bannedKey = `${name.toLowerCase()}::${artist.toLowerCase()}`;
        if (bannedPairs.has(bannedKey)) {
            skipped.banned += 1;
            continue;
        }

        if (queueUris.has(track.uri)) {
            skipped.duplicate += 1;
            continue;
        }

        queueUris.add(track.uri);
        queueableTracks.push({
            uri: track.uri,
            name,
            artist,
            image: track.album?.images?.[0]?.url || null
        });
    }

    return { queueableTracks, skipped };
}

async function getPlaylistPlayableStats(playlistId) {
    const { tracks: rawItems, error: fetchError } = await fetchPlaylistTracks(playlistId);

    if (fetchError) {
        console.error(`[getPlaylistPlayableStats] fetch failed for ${playlistId}: ${fetchError.message}`);
        return { playableCount: 0, fetchError, skipped: { unplayable: 0, banned: 0, duplicate: 0 } };
    }

    let playableCount = 0;
    let unplayableCount = 0;

    for (const item of rawItems) {
        const track = item?.item ?? item?.track;
        if (!track || track.is_local || !track.uri || !track.uri.startsWith('spotify:track:')) {
            unplayableCount += 1;
            continue;
        }
        playableCount += 1;
    }

    console.log(`[getPlaylistPlayableStats] playlistId=${playlistId} rawItems=${rawItems.length} playable=${playableCount} unplayable=${unplayableCount}`);

    return {
        playableCount,
        skipped: {
            unplayable: unplayableCount,
            banned: 0,
            duplicate: 0
        }
    };
}

async function getCurrentTrackUri() {
    await ensureSpotifyAccessToken();
    const playback = await executePlaybackRead({ session: null, ip: 'server-helper' }, 'helper-currentTrackUri', () => spotifyApi.getMyCurrentPlayingTrack());
    return playback?.body?.item?.uri || null;
}

async function isPlaylistCurrentlyPlaying(playlistId, preloadedItems = null) {
    const currentTrackUri = await getCurrentTrackUri();
    if (!currentTrackUri) return false;

    const playlistItems =
        preloadedItems != null
            ? preloadedItems
            : (await fetchPlaylistTracks(playlistId)).tracks;
    return playlistItems.some((item) => (item?.item ?? item?.track)?.uri === currentTrackUri);
}


router.post('/search', async (req, res) => {
    try {
        let { query, source, offset, limit, desiredTotal, includeArtists, includeAlbums } = req.body || {};
        if (!query || !query.trim()) {
            return res.status(400).json({ ok: false, error: 'Missing query' });
        }
        query = query.trim();
        if (query.length < 2) {
            return res.status(400).json({ ok: false, error: 'Search query must be at least 2 characters' });
        }

        const now = Date.now();
        pruneSearchCache(now);
        if (now < spotifySearchRateLimitedUntil) {
            const retryAfterSeconds = Math.max(1, Math.ceil((spotifySearchRateLimitedUntil - now) / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                ok: false,
                error: 'Spotify search is temporarily cooling down due to rate limits. Try again in a moment.',
                retryAfterSeconds
            });
        }

        const DEFAULT_SEARCH_LIMIT = 5;
        const MAX_SEARCH_LIMIT = SPOTIFY_SEARCH_LIMIT_MAX;
        const DEFAULT_DESIRED_TOTAL = 10;
        const MAX_DESIRED_TOTAL = 20;
        const MAX_SEARCH_PAGES = 1;
        const MAX_SEARCH_OFFSET = 1000;

        const parsedLimit = Number.parseInt(limit, 10);
        const SEARCH_LIMIT = Number.isInteger(parsedLimit)
            ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, parsedLimit))
            : DEFAULT_SEARCH_LIMIT;

        const parsedDesiredTotal = Number.parseInt(desiredTotal, 10);
        const DESIRED_TOTAL = Number.isInteger(parsedDesiredTotal)
            ? Math.min(MAX_DESIRED_TOTAL, Math.max(1, parsedDesiredTotal))
            : DEFAULT_DESIRED_TOTAL;

        const parsedOffset = Number.parseInt(offset, 10);
        offset = Number.isFinite(parsedOffset)
            ? Math.min(MAX_SEARCH_OFFSET, Math.max(0, parsedOffset))
            : 0;

        const requesterKey = getSearchRequesterKey(req);
        const lastRequestAt = searchRequesterLastAt.get(requesterKey) || 0;
        if ((now - lastRequestAt) < SEARCH_MIN_INTERVAL_MS) {
            return sendSearchClientRateLimit(
                res,
                'You are searching too quickly. Please wait a moment before searching again.',
                SEARCH_MIN_INTERVAL_MS - (now - lastRequestAt)
            );
        }

        const burst = tryConsumeSearchBurstSlot(requesterKey, now);
        if (!burst.ok) {
            return sendSearchClientRateLimit(
                res,
                'Too many searches in a short period. Please wait before searching again.',
                burst.retryAfterMs
            );
        }

        searchRequesterLastAt.set(requesterKey, now);

        const cacheKey = JSON.stringify({
            query: query.toLowerCase(),
            source: source || '',
            offset,
            SEARCH_LIMIT,
            DESIRED_TOTAL,
            includeArtists: !!includeArtists,
            includeAlbums: !!includeAlbums
        });
        const cached = searchResponseCache.get(cacheKey);
        if (cached && (now - cached.timestamp) <= SEARCH_CACHE_TTL_MS) {
            return res.json(cached.payload);
        }
        
        // Debug logging for pagination and limit issues
        // console.log('[/search] Request params:', {
        //     query: query.trim(),
        //     limit: SEARCH_LIMIT,
        //     offset,
        //     desiredTotal: DESIRED_TOTAL,
        //     limitType: typeof SEARCH_LIMIT,
        //     offsetType: typeof offset
        // });
        
        await ensureSpotifyAccessToken();

        // Start artist and album searches in parallel for first-page requests
        const artistSearchPromise = (includeArtists && offset === 0 && query.length >= 3)
            ? spotifyApi.search(query, ['artist'], { limit: 5 }).catch(() => null)
            : Promise.resolve(null);

        const albumSearchPromise = (includeAlbums && offset === 0 && query.length >= 3)
            ? spotifyApi.search(query, ['album'], { limit: 8 }).catch(() => null)
            : Promise.resolve(null);

        let total = 0;
        let currentOffset = offset;
        let pagesFetched = 0;
        const aggregatedItems = [];
        let rateLimited = false;

        while (aggregatedItems.length < DESIRED_TOTAL && pagesFetched < MAX_SEARCH_PAGES) {
            let searchData;
            try {
                searchData = await spotifyApi.searchTracks(query, { limit: SEARCH_LIMIT, offset: currentOffset });
            } catch (pageErr) {
                if (pageErr.statusCode === 429) {
                    // Rate limited — return whatever we've collected so far
                    rateLimited = true;
                    const retryAfterHeader =
                        pageErr?.headers?.['retry-after'] ||
                        pageErr?.response?.headers?.['retry-after'] ||
                        pageErr?.response?.headers?.get?.('retry-after');
                    const retryAfterSeconds = Number.parseInt(String(retryAfterHeader || ''), 10);
                    const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 10000);
                    spotifySearchRateLimitedUntil = Date.now() + cooldownMs;
                    break;
                }
                throw pageErr;
            }
            const tracks = searchData.body?.tracks;
            const items = tracks?.items || [];
            total = tracks?.total || total;

            aggregatedItems.push(...items);
            pagesFetched += 1;

            if (items.length < SEARCH_LIMIT) break;

            const next = currentOffset + SEARCH_LIMIT;
            if (next > MAX_SEARCH_OFFSET) break;
            if (total && next >= total) break;
            currentOffset = next;
        }

        // console.log('[/search] Search aggregation:', { pagesFetched, fetchedItems: aggregatedItems.length, total });

        if (rateLimited && aggregatedItems.length === 0) {
            const retryAfterSeconds = Math.max(1, Math.ceil((spotifySearchRateLimitedUntil - Date.now()) / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            return res.status(429).json({
                ok: false,
                error: 'Spotify is rate limiting search requests right now. Please wait a few seconds and try again.',
                retryAfterSeconds
            });
        }

        const items = aggregatedItems.slice(0, DESIRED_TOTAL);

        let simplified = items.map(t => ({
            id: t.id,
            name: t.name,
            artist: t.artists.map(a => a.name).join(', '),
            uri: t.uri,
            album: {
                name: t.album.name,
                image: t.album.images?.[0]?.url || null
            },
            explicit: t.explicit,
            duration_ms: t.duration_ms
        }));

        // if the song is banned hide it
        const isTeacherPanel = source === 'teacher';
        const isTeacher = (req.session?.isManager === true || true);
        try {
            const banned = await getBannedSongs();
            // Use function to check if track name starts with banned name and artist matches
            if (isTeacher && isTeacherPanel) {
                simplified = simplified.map(t => ({
                    ...t,
                    isBanned: banned.some(b => {
                        const bannedName = (b.track_name || '').trim().toLowerCase();
                        const bannedArtist = (b.artist_name || '').trim().toLowerCase();
                        return t.name.trim().toLowerCase().startsWith(bannedName) && t.artist.trim().toLowerCase() === bannedArtist;
                    })
                }));
            } else {
                simplified = simplified.filter(t => !banned.some(b => {
                    const bannedName = (b.track_name || '').trim().toLowerCase();
                    const bannedArtist = (b.artist_name || '').trim().toLowerCase();
                    return t.name.trim().toLowerCase().startsWith(bannedName) && t.artist.trim().toLowerCase() === bannedArtist;
                }));
            }
        } catch (e) {
            console.warn('Could not load banned songs; proceeding without filter');
            if (isTeacher && isTeacherPanel) {
                simplified = simplified.map(t => ({ ...t, isBanned: false }));
            }
        }
        // Resolve artist search for first-page results
        let artists = [];
        if (includeArtists && offset === 0) {
            const artistData = await artistSearchPromise;
            const artistItems = artistData?.body?.artists?.items || [];
            artists = artistItems.map(a => ({
                id: a.id,
                name: a.name,
                image: a.images?.[0]?.url || null,
                genres: (a.genres || []).slice(0, 3),
                popularity: a.popularity || 0
            }));
        }

        // Resolve album search for first-page results
        let albums = [];
        if (includeAlbums && offset === 0) {
            const albumData = await albumSearchPromise;
            const albumItems = albumData?.body?.albums?.items || [];
            albums = albumItems.map(a => ({
                id: a.id,
                name: a.name,
                image: a.images?.[0]?.url || null,
                artists: (a.artists || []).map(art => art.name).join(', '),
                release_date: a.release_date || '',
                total_tracks: a.total_tracks || 0,
                album_type: a.album_type || 'album'
            }));
        }

        const nextOffset = Math.min(offset + (pagesFetched * SEARCH_LIMIT), MAX_SEARCH_OFFSET);
        const payload = {
            ok: true,
            tracks: { items: simplified },
            artists,
            albums,
            nextOffset,
            hasMore: nextOffset < total
        };
        searchResponseCache.set(cacheKey, { timestamp: Date.now(), payload });
        return res.json(payload);
    } catch (err) {
        if (err?.statusCode === 429) {
            const retryAfterHeader =
                err?.headers?.['retry-after'] ||
                err?.response?.headers?.['retry-after'] ||
                err?.response?.headers?.get?.('retry-after');
            const retryAfterSeconds = Number.parseInt(String(retryAfterHeader || ''), 10);
            const cooldownMs = (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 10000);
            spotifySearchRateLimitedUntil = Date.now() + cooldownMs;
        }
        return handleSpotifyError(err, res, 'search');
    }
});

router.get('/recentlyQueued', async (req, res) => {
    if (!req.session?.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT t.track_uri, t.track_name, t.artist_name, t.image_url, t.action FROM transactions t
                 LEFT JOIN users u ON u.id = t.user_id
                 WHERE t.user_id = ? AND t.action IN ('play', 'artist_click', 'album_click')
                   AND (u.recently_queued_cleared_at IS NULL OR t.timestamp > u.recently_queued_cleared_at)
                 ORDER BY t.timestamp DESC LIMIT 200`,
                [req.session.userId],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });

        // Deduplicate: keep only the most recent item of each URI, cap at 50
        const seen = new Set();
        const uniqueRows = rows.filter(r => {
            if (seen.has(r.track_uri)) return false;
            seen.add(r.track_uri);
            return true;
        }).slice(0, 50);

        if (uniqueRows.length === 0) {
            return res.json({ ok: true, tracks: [] });
        }

        const tracks = uniqueRows.map((r) => {
            const itemType = r.action === 'artist_click' ? 'artist' : (r.action === 'album_click' ? 'album' : 'track');
            const fallbackSubtitle = itemType === 'track' ? 'Unknown' : '';
            const subtitleText = (r.artist_name || fallbackSubtitle);
            const yearMatch = itemType === 'album' ? String(subtitleText).match(/\b(19|20)\d{2}\b/) : null;
            return {
                name: r.track_name || 'Unknown',
                artist: subtitleText,
                uri: r.track_uri,
                album: { name: '', image: r.image_url || '' },
                itemType,
                releaseYear: yearMatch ? yearMatch[0] : ''
            };
        });

        return res.json({ ok: true, tracks });
    } catch (err) {
        console.error('Error fetching recently queued:', err);
        return res.status(500).json({ ok: false, error: 'Failed to fetch recently queued songs' });
    }
});

router.post('/recentlyQueued/interactions', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { type, id, name, subtitle, image } = req.body || {};
    const normalizedType = typeof type === 'string' ? type.trim().toLowerCase() : '';
    const safeId = typeof id === 'string' ? id.trim() : '';
    const safeName = typeof name === 'string' ? name.trim() : '';

    if (!['artist', 'album'].includes(normalizedType)) {
        return res.status(400).json({ ok: false, error: 'Invalid interaction type' });
    }
    if (!safeId || !safeName) {
        return res.status(400).json({ ok: false, error: 'Missing interaction metadata' });
    }

    const action = normalizedType === 'artist' ? 'artist_click' : 'album_click';
    const uri = `spotify:${normalizedType}:${safeId}`;
    const safeSubtitle = typeof subtitle === 'string' ? subtitle.trim() : '';
    const safeImage = typeof image === 'string' ? image.trim() : '';

    try {
        await logTransaction({
            userID: userId,
            displayName: req.session.user,
            action,
            trackURI: uri,
            trackName: safeName.slice(0, 200),
            artistName: safeSubtitle.slice(0, 200),
            imageURL: safeImage || null,
            cost: 0
        });

        res.json({ ok: true });
    } catch (error) {
        console.error('Failed to log recently queued interaction:', error);
        res.status(500).json({ ok: false, error: 'Failed to save interaction' });
    }
});

router.post('/clearQueueHistory', async (req, res) => {
    if (!req.session?.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE users SET recently_queued_cleared_at = datetime('now') WHERE id = ?`,
                [req.session.userId],
                (err) => err ? reject(err) : resolve()
            );
        });

        // Emit socket event to notify the user their history was cleared
        const io = req.app.get('io');
        if (io) {
            io.to(`user:${req.session.userId}`).emit('queueHistoryUpdated', { userId: req.session.userId });
        }

        return res.json({ ok: true, message: 'Queue history cleared' });
    } catch (err) {
        console.error('Error clearing queue history:', err);
        return res.status(500).json({ ok: false, error: 'Failed to clear queue history' });
    }
});

// Clear recently queued for ALL users (transactions stay intact)
router.post('/clearAllRecentlyQueued', isAuthenticated, async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE users SET recently_queued_cleared_at = datetime('now')`,
                (err) => err ? reject(err) : resolve()
            );
        });

        const io = req.app.get('io');
        if (io) io.emit('recentlyQueuedCleared');

        return res.json({ ok: true, message: 'Recently queued cleared for all users' });
    } catch (err) {
        console.error('Error clearing all recently queued:', err);
        return res.status(500).json({ ok: false, error: 'Failed to clear recently queued' });
    }
});

/** Spotify playlists visible to the linked account (for player sidebar). */
router.get('/api/playlists/allowed', isAuthenticated, async (req, res) => {
    try {
        if (!process.env.SPOTIFY_CLIENT_ID) {
            return res.json({ ok: true, playlists: [] });
        }
        await ensureSpotifyAccessToken();
        const items = await fetchAllUserPlaylists();
        const playlists = items.map((playlist) => {
            const ownerId = playlist.owner?.id;
            return {
                id: playlist.id,
                name: playlist.name || 'Untitled Playlist',
                owner: playlist.owner?.display_name || ownerId || 'Unknown',
                image: playlist.images?.[0]?.url || null,
                totalTracks: playlist.tracks?.total ?? 0
            };
        });
        playlists.sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()));
        return res.json({ ok: true, playlists });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch playlists for player');
    }
});

function buildPlaylistQuoteFromItems(rawItems) {
    let playableCount = 0;
    const preview = [];
    const PREVIEW_MAX = 200;

    for (const item of rawItems) {
        const track = item?.item ?? item?.track;
        const playable = !!(track && !track.is_local && track.uri && track.uri.startsWith('spotify:track:'));
        if (playable) {
            playableCount += 1;
        }

        if (preview.length < PREVIEW_MAX) {
            if (!track) {
                preview.push({ name: 'Unknown item', artist: '', image: null, playable: false });
            } else {
                const name = (track.name || 'Unknown track').trim();
                const artist = (track.artists || []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist';
                const image = track.album?.images?.[0]?.url || null;
                preview.push({ name, artist, image, playable });
            }
        }
    }

    return {
        playableCount,
        preview,
        totalItems: rawItems.length,
        previewCapped: rawItems.length > preview.length
    };
}

router.post('/api/playlists/quote', isAuthenticated, async (req, res) => {
    try {
        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        await ensureSpotifyAccessToken();
        let playlistMeta;
        try {
            playlistMeta = await spotifyApi.getPlaylist(playlistId);
        } catch (err) {
            return handleSpotifyError(err, res, 'quote playlist');
        }

        const fetchResult = await fetchPlaylistTracks(playlistId);
        if (fetchResult.error) {
            const fe = fetchResult.error;
            return res.status(fe.status === 403 ? 403 : fe.status === 429 ? 429 : 502).json({ ok: false, error: fe.message });
        }

        const rawItems = fetchResult.tracks;
        const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId, rawItems);
        if (alreadyPlaying) {
            return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
        }

        const quote = buildPlaylistQuoteFromItems(rawItems);
        const queueableCount = quote.playableCount;
        const cost = computePlaylistCost(queueableCount);
        const unplayable = Math.max(0, rawItems.length - queueableCount);

        return res.json({
            ok: true,
            playlist: {
                id: playlistId,
                name: playlistMeta.body?.name || 'Untitled Playlist'
            },
            queueableCount,
            tracks: quote.preview,
            totalTracks: quote.totalItems,
            previewCapped: quote.previewCapped,
            skipped: {
                unplayable,
                banned: 0,
                duplicate: 0
            },
            cost
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'quote playlist');
    }
});

router.post('/api/playlists/queue', isAuthenticated, playbackRateLimit(MODIFY), async (req, res) => {
    try {
        const userId = req.session?.userId;
        if (!userId) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }

        const { playlistId } = req.body || {};
        if (!playlistId) {
            return res.status(400).json({ ok: false, error: 'playlistId is required' });
        }

        const alreadyPlaying = await isPlaylistCurrentlyPlaying(playlistId);
        if (alreadyPlaying) {
            return res.status(409).json({ ok: false, code: 'PLAYLIST_ALREADY_PLAYING', error: 'This playlist is already playing' });
        }

        const userIsOwner = true;

        if (!userIsOwner) {
            const userBanned = await new Promise((resolve, reject) => {
                db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
                    if (err) return reject(err);
                    resolve(row && row.isBanned === 1);
                });
            });
            if (userBanned) {
                return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
            }

            if (!true) {
                return res.status(402).json({ ok: false, error: 'Payment required to play playlist' });
            }

            const paidAction = req.session?.payment?.pendingAction;
            const paidPlaylistId = req.session?.payment?.playlistId;
            if (paidAction !== 'playlist' || paidPlaylistId !== playlistId) {
                return res.status(409).json({ ok: false, error: 'Payment is not linked to this playlist' });
            }
        }

        await ensureSpotifyAccessToken();
        const [playlistMeta, playlistStats] = await Promise.all([
            spotifyApi.getPlaylist(playlistId),
            getPlaylistPlayableStats(playlistId)
        ]);

        const queueableCount = playlistStats.playableCount;
        const expectedCost = computePlaylistCost(queueableCount);
        if (!userIsOwner) {
            const paidAmount = Number(req.session?.payment?.amount) || 0;
            if (paidAmount < expectedCost) {
                return res.status(409).json({ ok: false, error: 'Insufficient payment for current playlist contents' });
            }
        }

        if (playlistStats.fetchError) {
            const fe = playlistStats.fetchError;
            return res.status(fe.status === 403 ? 403 : fe.status === 429 ? 429 : 502).json({ ok: false, error: fe.message });
        }

        if (!queueableCount) {
            return res.status(400).json({ ok: false, error: 'No queueable tracks found in this playlist', skipped: playlistStats.skipped });
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');
        const playlistUri = playlistMeta.body?.uri || `spotify:playlist:${playlistId}`;

        await spotifyApi.play({ context_uri: playlistUri });

        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (syncErr) {
            console.warn('Playlist playback started but queue sync failed:', syncErr.message);
        }

        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'playlist',
            trackURI: playlistMeta.body?.uri || null,
            trackName: playlistMeta.body?.name || allowedRow.name || 'Playlist',
            artistName: `${queueableCount} tracks in playlist`,
            cost: 0
        });

        res.json({
            ok: true,
            queuedCount: queueableCount,
            skipped: playlistStats.skipped,
            cost: 0,
            message: `Started playlist playback (${queueableCount} tracks)`
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'queue playlist');
    }
});

router.post('/unbanTrack', isAuthenticated, async (req, res) => {
    try {
        const { name, artist } = req.body || {};
        if (!name || !artist) return res.status(400).json({ ok: false, error: 'Missing track name or artist' });

        await new Promise((resolve, reject) => {
            db.run(
                'DELETE FROM banned_songs WHERE lower(trim(track_name)) = lower(trim(?)) AND lower(trim(artist_name)) = lower(trim(?))',
                [name, artist],
                function (err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        return res.json({ ok: true, message: 'Track unbanned successfully' });
    } catch (error) {
        console.error('Unban track error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to unban track' });
    }
});

// Teacher-only: Ban a track by name/artist (optionally record URI)
router.post('/banTrack', isAuthenticated, async (req, res) => {
    try {
        const { name, artist, reason, uri, image } = req.body || {};
        if (!name || !artist) return res.status(400).json({ ok: false, error: 'Missing track name or artist' });

        const banReason = typeof reason === 'string' ? reason.trim() : '';
        if (!banReason) return res.status(400).json({ ok: false, error: 'Ban reason is required' });
        if (banReason.length > 200) return res.status(400).json({ ok: false, error: 'Ban reason must be 200 characters or fewer' });

        const bannedBy = req.session?.userId;
        if (!bannedBy) {
            return res.status(401).json({ ok: false, error: 'Missing user token id' });
        }

        // Avoid duplicates
        const alreadyBanned = await isTrackBannedByNameArtist(name, artist);
        if (alreadyBanned) {
            return res.json({ ok: true, message: 'Track already banned' });
        }

        const imageUrl = typeof image === 'string' ? image : null;

        await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO banned_songs (track_name, artist_name, track_uri, banned_by, reason, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                [name, artist, uri || null, bannedBy, banReason, imageUrl],
                function (err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });

        return res.json({ ok: true, message: 'Track banned successfully' });
    } catch (error) {
        console.error('Ban track error:', error);
        return res.status(500).json({ ok: false, error: 'Failed to ban track' });
    }
});

router.get('/getQueue', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'getQueue', async () => fetch('https://api.spotify.com/v1/me/player/queue', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /getQueue');
            return res.status(429).json({ ok: false, error: 'Spotify queue is rate limited. Please retry shortly.' });
        }
        if (response.status === 200) {
            const queueData = await response.json();
            const items = queueData.queue || [];

            // 📖 Fetch metadata for all tracks from database
            const trackUris = items.map(item => item.uri);
            const metadataArrayMap = await new Promise((resolve) => {
                if (trackUris.length === 0) {
                    resolve({});
                    return;
                }

                const placeholders = trackUris.map(() => '?').join(',');
                // Fetch added_by, added_at, and is_anon for each track, ordered so oldest is first
                const query = `SELECT track_uri, added_by, added_at, is_anon FROM queue_metadata WHERE track_uri IN (${placeholders}) ORDER BY added_at ASC`;

                db.all(query, trackUris, (err, rows) => {
                    if (err) {
                        console.error('Failed to fetch queue metadata:', err);
                        resolve({});
                    } else {
                        // Build array-based map to correctly handle duplicate URIs in the queue
                        const map = {};
                        if (rows) {
                            rows.forEach(row => {
                                if (!map[row.track_uri]) map[row.track_uri] = [];
                                map[row.track_uri].push({
                                    added_by: row.added_by,
                                    added_at: row.added_at,
                                    is_anon: row.is_anon
                                });
                            });
                        }
                        resolve(map);
                    }
                });
            });

            // Track which metadata entries have been consumed (for duplicate URIs)
            const usedMetaKeys = new Set();

            let simplified = items.map(t => {
                const entries = metadataArrayMap[t.uri] || [];
                let meta = null;
                for (const entry of entries) {
                    const key = `${t.uri}_${entry.added_at}`;
                    if (!usedMetaKeys.has(key)) {
                        meta = entry;
                        usedMetaKeys.add(key);
                        break;
                    }
                }
                if (!meta && entries.length > 0) meta = entries[0];

                let addedBy = meta?.added_by || 'Spotify';
                if (meta?.is_anon === 1 || meta?.is_anon === true) {
                    addedBy = 'Anonymous';
                }
                return {
                    id: t.id,
                    name: t.name,
                    artist: t.artists.map(a => a.name).join(', '),
                    uri: t.uri,
                    album: {
                        name: t.album.name,
                        image: t.album.images?.[0]?.url || null
                    },
                    explicit: t.explicit,
                    duration_ms: t.duration_ms,
                    addedBy,
                    addedAt: meta?.added_at || 0
                };
            });
            res.json({
                ok: true,
                tracks: { items: simplified }
            });
        } else {
            res.status(response.status).json({ ok: false, error: 'Failed to get queue' });
        }
    } catch (error) {
        console.error('Get queue error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue', details: error.message });
    }
});

router.post('/addToQueue', playbackRateLimit(MODIFY), async (req, res) => {
    //console.log('addToQueue - Session:', req.session?.userId, 'hasPaid:', true);
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (true) {
        try {
            await ensureSpotifyAccessToken();

            const { uri, anonMode, trackName: clientName, trackArtist: clientArtist, trackImage: clientImage } = req.body;
            if (!uri) return res.status(400).json({ error: "Missing track URI" });

            const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
            const match = uri.match(trackIdPattern);
            if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

            const trackId = match[1];

            // Use client-supplied metadata when available to avoid an extra Spotify API call.
            // Fall back to getTrack() only when metadata is missing (e.g. direct API calls).
            const trimName = typeof clientName === 'string' ? clientName.trim() : '';
            const trimArtist = typeof clientArtist === 'string' ? clientArtist.trim() : '';
            let track;
            if (trimName && trimArtist) {
                track = {
                    name: trimName.slice(0, 200),
                    artists: [{ name: trimArtist.slice(0, 200) }],
                    uri,
                    album: { images: [{ url: typeof clientImage === 'string' ? clientImage : '' }] }
                };
            } else {
                const trackData = await spotifyApi.getTrack(trackId);
                track = trackData.body;
            }
            const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');
            const isAnon = anonMode ? 1 : 0;

            const trackInfo = {
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                cover: track.album.images[0]?.url || '',
                addedBy: username
            };

            await executePlaybackModify(req, 'addToQueue', () => spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri));

            const queueTrack = {
                uri: track.uri,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                addedBy: username,
                addedAt: Date.now(),
                image: track.album.images[0]?.url,
                isAnon: isAnon
            };
            //console.log('Adding track to queue with addedBy:', username, 'type:', typeof username); // Debug log
            queueManager.addToQueue(queueTrack);

            // Save metadata to database (synchronously)
            //console.log('Saving to DB - URI:', track.uri, 'addedBy:', username);
            await new Promise((resolve, reject) => {
                db.run(
                    `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon)
                 VALUES (?, ?, ?, ?, ?)`,
                    [track.uri, username, Date.now(), username, isAnon],
                    function (err) {
                        if (err) {
                            console.error('Failed to save queue metadata:', err);
                            reject(err);
                        } else {
                            //console.log('Saved queue metadata for:', track.name, 'URI:', track.uri, 'LastID:', this.lastID, 'Changes:', this.changes);
                            // Verify it was actually saved
                            db.get('SELECT * FROM queue_metadata WHERE track_uri = ?', [track.uri], (verifyErr, row) => {
                                if (verifyErr) {
                                    console.error('Verification failed:', verifyErr);
                                } else {
                                    //console.log('Verification: Row exists with addedBy:', row?.added_by);
                                }
                            });
                            resolve();
                        }
                    }
                );
            });

            if (anonMode !== 1 && !true) {
                db.run(
                    "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session?.userId],
                    (err) => {
                        if (err) console.error('Error updating songs played:', err);
                    }
                );
            }

            // Log transaction for owners (cost 0)
            await logTransaction({
                userID: req.session.userId,
                displayName: req.session.user,
                action: 'play',
                trackURI: trackInfo.uri,
                trackName: trackInfo.name,
                artistName: trackInfo.artist,
                imageURL: trackInfo.cover || null,
                cost: 0
            });

            // Notify the queuing user's sockets that their recently queued list changed
            const io = req.app.get('io');
            if (io) {
                io.to(`user:${req.session.userId}`).emit('recentlyQueuedUpdate', {
                    name: trackInfo.name,
                    artist: trackInfo.artist,
                    uri: trackInfo.uri,
                    album: { name: '', image: trackInfo.cover }
                });
            }

            scheduleImmediateSpotifyQueueSync();
            //console.log(`Add to queue successful for owner (ID: ${req.session.userId})`);
            res.json({ success: true, message: "Track queued!", trackInfo });
            return;
        } catch (err) {
            return handleSpotifyError(err, res, 'addToQueue');
        }
    }

    // For non-admin users, check if banned
    const userBanned = await new Promise((resolve, reject) => {
        db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [req.session.userId], (err, row) => {
            if (err) reject(err);
            else resolve(row && row.isBanned === 1);
        });
    });
    if (userBanned) {
        return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar. Contact your teacher.' });
    }

    // Check for duplicates BEFORE payment (for non-teachers)
    const isTeacher = req.session?.isManager === true;
    if (!isTeacher) {
        const { uri } = req.body;
        if (uri) {
            const isDuplicate = queueManager.queue.some(item => item.uri === uri);
            if (isDuplicate) {
                return res.status(400).json({ ok: false, error: 'This song is already in the queue. Please choose a different song.' });
            }
        }
    }

    // For non-admin users, check payment
    if (!true) {
        //console.log('addToQueue - Payment required. User ID:', req.session.userId, 'hasPaid:', true);
        return res.status(403).json({ ok: false, error: 'Payment required to add to queue' });
    }

    try {
        await ensureSpotifyAccessToken();

        const { uri, anonMode, trackName: clientName, trackArtist: clientArtist, trackImage: clientImage } = req.body;
        if (!uri) return res.status(400).json({ error: "Missing track URI" });

        const trackIdPattern = /^spotify:track:([a-zA-Z0-9]{22})$/;
        const match = uri.match(trackIdPattern);
        if (!match) return res.status(400).json({ error: 'Invalid track URI format' });

        const trackId = match[1];

        // Use client-supplied metadata when available to avoid an extra Spotify API call.
        // Fall back to getTrack() only when metadata is missing (e.g. direct API calls).
        const trimName = typeof clientName === 'string' ? clientName.trim() : '';
        const trimArtist = typeof clientArtist === 'string' ? clientArtist.trim() : '';
        let track;
        if (trimName && trimArtist) {
            track = {
                name: trimName.slice(0, 200),
                artists: [{ name: trimArtist.slice(0, 200) }],
                uri,
                album: { images: [{ url: typeof clientImage === 'string' ? clientImage : '' }] }
            };
        } else {
            const trackData = await spotifyApi.getTrack(trackId);
            track = trackData.body;
        }
        const isAnon = anonMode ? 1 : 0;
        const trackInfo = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            uri: track.uri,
            cover: track.album.images[0]?.url || '',
        };

        // Check banned songs
        if (await isTrackBannedByNameArtist(trackInfo.name, trackInfo.artist)) {
            return res.status(403).json({ ok: false, error: 'This track has been banned by the teacher' });
        }

        await executePlaybackModify(req, 'addToQueue', () => spotifyApi.addToQueue(shouldAprilFool() ? APRIL_FOOLS_URI : uri));
        const username2 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');

        const queueTrack = {
            uri: track.uri,
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            addedBy: username2,
            addedAt: Date.now(),
            image: track.album.images[0]?.url,
            isAnon: isAnon
        };
        queueManager.addToQueue(queueTrack);

        // 📝 Save metadata to database (synchronously)
        //console.log('Saving to DB - URI:', track.uri, 'addedBy:', username2, 'type:', typeof username2);
        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon)
                 VALUES (?, ?, ?, ?, ?)`,
                [track.uri, username2, Date.now(), username2, isAnon],
                function (err) {
                    if (err) {
                        console.error('Failed to save queue metadata:', err);
                        reject(err);
                    } else {
                        //console.log('Saved queue metadata for:', track.name, 'URI:', track.uri, 'LastID:', this.lastID, 'Changes:', this.changes);
                        // Verify it was actually saved
                        db.get('SELECT * FROM queue_metadata WHERE track_uri = ?', [track.uri], (verifyErr, row) => {
                            if (verifyErr) {
                                console.error('Verification failed:', verifyErr);
                            } else {
                                //console.log('Verification: Row exists with addedBy:', row?.added_by);
                            }
                        });
                        resolve();
                    }
                }
            );
        });

        if (anonMode !== 1 && !true) {
            db.run(
                "UPDATE users SET songsPlayed = songsPlayed + 1 WHERE id = ?", [req.session?.userId],
                (err) => {
                    if (err) console.error('Error updating songs played:', err);
                }
            );
        }

        // Log the transaction - ALWAYS log, not just when currentTrack exists
        await logTransaction({
            userID: req.session.userId,
            displayName: req.session.user,
            action: 'play',
            trackURI: trackInfo.uri,
            trackName: trackInfo.name,
            artistName: trackInfo.artist,
            imageURL: trackInfo.cover || null,
            cost: Number(process.env.SONG_AMOUNT) || 50
        });

        // Clear payment flag after successful queue addition
        req.session.save(() => {
            // Notify the queuing user's sockets that their recently queued list changed
            const io = req.app.get('io');
            if (io) {
                io.to(`user:${req.session.userId}`).emit('recentlyQueuedUpdate', {
                    name: trackInfo.name,
                    artist: trackInfo.artist,
                    uri: trackInfo.uri,
                    album: { name: '', image: trackInfo.cover }
                });
            }
            scheduleImmediateSpotifyQueueSync();
            res.json({ success: true, message: "Track queued!", trackInfo });
        });

    } catch (err) {
        return handleSpotifyError(err, res, 'addToQueue');
    }
});


router.get('/currentlyPlaying', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'currentlyPlaying', async () => fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /currentlyPlaying');
            return res.status(429).json({ ok: false, error: 'Spotify playback is rate limited. Please retry shortly.' });
        }
        if (response.status === 200) {
            const data = await response.json();

            // Check if something is playing
            if (!data || !data.item) {
                currentTrack = null;
                return res.json({ ok: true, tracks: { items: [] } });
            }
            const track = data.item;
            const simplified = ({
                id: track.id,
                name: track.name,
                artist: track.artists.map(a => a.name).join(', '),
                uri: track.uri,
                album: {
                    name: track.album.name,
                    image: track.album.images?.[0]?.url || null
                },
                explicit: track.explicit,
                duration_ms: track.duration_ms
            });

            // Store current track for other endpoints
            currentTrack = simplified;

            res.json({
                ok: true,
                tracks: { items: [simplified] }
            });
        } else if (response.status === 204) {
            currentTrack = null;
            res.json({ ok: true, tracks: { items: [] } });
        } else {
            res.status(response.status).json({ ok: false, error: 'Failed to get queue' });
        }
    } catch (error) {
        console.error('Get queue error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue', details: error.message });
    }
});

router.post('/skip', playbackRateLimit(MODIFY), async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { uri } = req.body;

    try {
        await ensureSpotifyAccessToken();
        await executePlaybackModify(req, 'skip', () => spotifyApi.skipToNext());
        const nextTrack = await queueManager.skipTrack(req.session.user || 'Manager');
        scheduleImmediateSpotifyQueueSync();
        return res.json({ ok: true, currentTrack: nextTrack });
    } catch (error) {
        console.error('Skip error:', error);
        if (error.statusCode === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        return res.status(500).json({ ok: false, error: 'Failed to skip', details: error.message });
    }
});

/** PUT /me/player/pause — https://developer.spotify.com/documentation/web-api/reference/pause-a-users-playback */
router.post('/playback/pause', playbackRateLimit(MODIFY), async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
        await ensureSpotifyAccessToken();
        await executePlaybackModify(req, 'playback-pause', async () => {
            const deviceId = await resolveSpotifyDeviceId(req);
            const opts = deviceId ? { device_id: deviceId } : {};
            await spotifyApi.pause(opts);
        });
        scheduleImmediateSpotifyQueueSync();
        return res.json({ ok: true });
    } catch (error) {
        console.error('Pause error:', error);
        const status = Number(error.statusCode ?? error?.body?.error?.status);
        if (status === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        if (status === 403) {
            return res.status(403).json({ ok: false, error: spotifyRestrictionErrorMessage() });
        }
        return res.status(500).json({ ok: false, error: 'Failed to pause', details: error.message });
    }
});

/** PUT /me/player/play — https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback */
router.post('/playback/play', playbackRateLimit(MODIFY), async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
        await ensureSpotifyAccessToken();
        await executePlaybackModify(req, 'playback-play', async () => {
            const deviceId = await resolveSpotifyDeviceId(req);
            const playOptions = deviceId ? { device_id: deviceId } : {};

            try {
                await spotifyApi.play(playOptions);
            } catch (err) {
                const code = Number(err?.statusCode ?? err?.body?.error?.status);
                // Resume often needs an explicit device; transfer + play covers stubborn clients.
                if (code === 404 && deviceId) {
                    await spotifyApi.transferMyPlayback([deviceId], { play: true });
                    return;
                }
                throw err;
            }
        });
        scheduleImmediateSpotifyQueueSync();
        return res.json({ ok: true });
    } catch (error) {
        console.error('Play error:', error);
        const status = Number(error.statusCode ?? error?.body?.error?.status);
        if (status === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Open Spotify on a device, then try again.' });
        }
        if (status === 403) {
            return res.status(403).json({ ok: false, error: spotifyRestrictionErrorMessage() });
        }
        return res.status(500).json({ ok: false, error: 'Failed to start playback', details: error.message });
    }
});

/** POST /me/player/previous — https://developer.spotify.com/documentation/web-api/reference/skip-users-playback-to-previous-track */
router.post('/playback/previous', playbackRateLimit(MODIFY), async (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
        await ensureSpotifyAccessToken();
        await executePlaybackModify(req, 'playback-previous', () => spotifyApi.skipToPrevious());
        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (syncErr) {
            console.warn('[playback/previous] queue sync:', syncErr.message);
        }
        return res.json({ ok: true, state: queueManager.getCurrentState() });
    } catch (error) {
        console.error('Previous track error:', error);
        if (error.statusCode === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        return res.status(500).json({ ok: false, error: 'Failed to skip to previous track', details: error.message });
    }
});

// Get current queue state
router.get('/queue/state', (req, res) => {
    try {
        const state = queueManager.getCurrentState();
        res.json({ ok: true, ...state });
    } catch (error) {
        console.error('Queue state error:', error);
        res.status(500).json({ ok: false, error: 'Failed to get queue state' });
    }
});

// Add track to queue (instead of playing immediately)
router.post('/queue/add', async (req, res) => {
    try {
        const { uri, trackName, artist } = req.body;

        if (!uri) {
            return res.status(400).json({ ok: false, error: 'Missing track URI' });
        }

        const username3 = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Spotify');

        const track = {
            uri,
            name: trackName,
            artist,
            addedBy: username3,
            addedAt: Date.now()
        };

        queueManager.addToQueue(track);

        // Log the transaction
        if (req.session?.userId) {
            await logTransaction(req.session.userId, username3, 'QUEUE', uri, trackName, artist, 50);
        }

        res.json({ ok: true, message: 'Track added to queue', queue: queueManager.queue });
    } catch (error) {
        console.error('Queue add error:', error);
        res.status(500).json({ ok: false, error: 'Failed to add to queue' });
    }
});

// Skip current track (for teachers/admins)
router.post('/queue/skip', playbackRateLimit(MODIFY), async (req, res) => {
    try {
        // Check permissions
        if (false) {
            return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
        }

        const nextTrack = await queueManager.skipTrack(req.session.user || 'Teacher');

        if (nextTrack) {
            // Actually skip on Spotify
            await ensureSpotifyAccessToken();
            await executePlaybackModify(req, 'queue-skip', () => spotifyApi.skipToNext());

            res.json({ ok: true, message: 'Track skipped', currentTrack: nextTrack });
        } else {
            res.json({ ok: true, message: 'No tracks in queue to skip to' });
        }
    } catch (error) {
        console.error('Queue skip error:', error);
        // Handle 404 errors when no active playback device
        if (error.statusCode === 404) {
            return res.status(400).json({ ok: false, error: 'No active Spotify playback found. Please start playing music on a Spotify device first.' });
        }
        res.status(500).json({ ok: false, error: 'Failed to skip track' });
    }
});

// Check if track exists in queue or is currently playing
router.post('/checkTrackExists', isAuthenticated, async (req, res) => {
    const { trackUri } = req.body;
    const db = require('../utils/database');
    const queueManager = require('../utils/queueManager');

    try {
        // Check if it's currently playing
        const state = queueManager.getCurrentState();
        const currentTrack = state.currentTrack;
        const isCurrentlyPlaying = currentTrack && currentTrack.uri === trackUri;

        // Check if track exists in queue metadata
        const track = await new Promise((resolve, reject) => {
            db.get("SELECT track_uri FROM queue_metadata WHERE track_uri = ?", [trackUri], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        // Track exists if it's currently playing OR in the queue
        res.json({ exists: isCurrentlyPlaying || !!track });
    } catch (error) {
        console.error('Error checking track existence:', error);
        res.status(500).json({ exists: false, error: 'Server error' });
    }
});

router.get('/api/currentTrack', playbackRateLimit(READ), async (req, res) => {
    try {
        await ensureSpotifyAccessToken();
        const response = await executePlaybackRead(req, 'api-currentTrack', async () => fetch('https://api.spotify.com/v1/me/player/currently-playing', {
            headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
        }));
        if (response.status === 429) {
            setSpotifyPlaybackCooldown(READ, response.headers.get('retry-after'), 'GET /api/currentTrack');
            return res.status(429).json({ ok: false, error: 'Spotify playback is rate limited. Please retry shortly.' });
        }
        const data = await response.json();
        res.json({ track: data.item });
    } catch (err) {
        console.error('Error fetching current track:', err);
        res.status(500).json({ error: 'Failed to fetch current track' });
    }
});

// --- Artist / Album browsing routes ---

router.get('/api/artist/:id/top-tracks', async (req, res) => {
    try {
        const { id } = req.params;
        const artistName = (req.query.name || '').trim();
        if (!id) return res.status(400).json({ ok: false, error: 'Artist ID required' });
        if (!artistName) return res.status(400).json({ ok: false, error: 'Artist name required (pass ?name=)' });

        const lastfmKey = process.env.LASTFM_API_KEY;
        if (!lastfmKey) return res.status(500).json({ ok: false, error: 'LASTFM_API_KEY not configured' });

        // Step 1: Get ranked track names from Last.fm
        const lfmUrl = new URL('https://ws.audioscrobbler.com/2.0/');
        lfmUrl.searchParams.set('method', 'artist.getTopTracks');
        lfmUrl.searchParams.set('artist', artistName);
        lfmUrl.searchParams.set('limit', '15');
        lfmUrl.searchParams.set('api_key', lastfmKey);
        lfmUrl.searchParams.set('format', 'json');

        const lfmRes = await fetch(lfmUrl.toString());
        if (!lfmRes.ok) {
            console.error(`[top-tracks] Last.fm ${lfmRes.status}`);
            return res.status(502).json({ ok: false, error: 'Last.fm request failed' });
        }
        const lfmData = await lfmRes.json();
        const lfmTracks = lfmData.toptracks?.track || [];
        if (!lfmTracks.length) return res.json({ ok: true, tracks: [] });

        // Step 2: Resolve each track name to a Spotify track via search, keeping Last.fm order
        await ensureSpotifyAccessToken();

        const banned = await getBannedSongs();
        const bannedPairs = new Set(banned.map(b =>
            `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`
        ));

        const resolved = [];
        for (const lfmTrack of lfmTracks) {
            if (resolved.length >= 10) break;
            const trackName = lfmTrack.name || '';
            try {
                const searchData = await spotifyApi.searchTracks(
                    `track:"${trackName.replace(/"/g, '')}" artist:"${artistName.replace(/"/g, '')}"`,
                    { limit: SPOTIFY_SEARCH_LIMIT_MAX, market: 'US' }
                );
                const candidates = (searchData.body.tracks?.items || [])
                    .filter(t => (t.artists || []).some(a => a.id === id));

                const match = candidates.find(
                    t => !isTrackBanned(t, bannedPairs)
                );
                if (!match) continue;

                // Avoid duplicate Spotify tracks (same URI)
                if (resolved.some(r => r.uri === match.uri)) continue;

                resolved.push({
                    id: match.id,
                    name: match.name,
                    artist: (match.artists || []).map(a => a.name).join(', '),
                    uri: match.uri,
                    album: {
                        name: match.album?.name || '',
                        image: match.album?.images?.[0]?.url || null
                    },
                    duration_ms: match.duration_ms
                });
            } catch (searchErr) {
                console.warn(`[top-tracks] Spotify search failed for "${trackName}":`, formatSpotifyErrorForLog(searchErr));
                if (searchErr?.statusCode === 429) break;
            }
        }

        return res.json({ ok: true, tracks: resolved });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch artist top tracks');
    }
});

router.get('/api/artist/:id/albums', async (req, res) => {
    try {
        const { id } = req.params;
        const offset = parseInt(req.query.offset, 10) || 0;
        if (!id) return res.status(400).json({ ok: false, error: 'Artist ID required' });

        await ensureSpotifyAccessToken();

        const url = new URL(`https://api.spotify.com/v1/artists/${id}/albums`);
        url.searchParams.set('include_groups', 'album,single');
        url.searchParams.set('market', 'US');
        url.searchParams.set('limit', '10'); // Spotify API maximum for this endpoint
        url.searchParams.set('offset', String(offset));

        const response = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` }
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            return res.status(response.status).json({ ok: false, error: errBody?.error?.message || `Spotify error ${response.status}` });
        }

        const data = await response.json();
        const albums = (data.items || []).map(a => ({
            id: a.id,
            name: a.name,
            image: a.images?.[0]?.url || null,
            release_date: a.release_date || '',
            total_tracks: a.total_tracks || 0,
            album_type: a.album_type || 'album'
        }));

        const nextOffset = offset + albums.length;
        const hasMore = nextOffset < (data.total || 0);

        return res.json({ ok: true, albums, hasMore, nextOffset });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch artist albums');
    }
});

router.get('/api/album/:id/tracks', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ ok: false, error: 'Album ID required' });

        await ensureSpotifyAccessToken();
        const result = await spotifyApi.getAlbum(id, { market: 'US' });
        const albumData = result.body;
        const albumImage = albumData.images?.[0]?.url || null;
        const releaseYear = typeof albumData.release_date === 'string'
            ? albumData.release_date.substring(0, 4)
            : '';

        const banned = await getBannedSongs();
        const bannedPairs = new Set(banned.map(b =>
            `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`
        ));

        const filtered = [];
        for (const t of (albumData.tracks?.items || [])) {
            if (!t.uri || t.is_local) continue;
            if (isTrackBanned(t, bannedPairs)) continue;
            filtered.push({
                id: t.id,
                name: t.name,
                artist: (t.artists || []).map(a => a.name).join(', '),
                uri: t.uri,
                album: { name: albumData.name || '', image: albumImage },
                duration_ms: t.duration_ms || 0
            });
        }

        return res.json({
            ok: true,
            tracks: filtered,
            queueableCount: filtered.length,
            releaseYear
        });
    } catch (err) {
        return handleSpotifyError(err, res, 'fetch album tracks');
    }
});

module.exports = router;
