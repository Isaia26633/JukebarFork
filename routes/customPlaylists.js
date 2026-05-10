const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { spotifyApi, ensureSpotifyAccessToken } = require('../utils/spotify');
const { logTransaction } = require('./logging');
const { isAuthenticated } = require('../middleware/auth');
const queueManager = require('../utils/queueManager');
const { MODIFY, playbackRateLimit, executePlaybackModify } = require('../middleware/spotifyPlaybackRateLimit');

const INITIAL_FREE_SONGS = 5;

function isValidTrackUri(uri) {
    return typeof uri === 'string' && /^spotify:track:[a-zA-Z0-9]{22}$/.test(uri);
}

function extractTrackId(uri) {
    return uri.replace('spotify:track:', '');
}

function getBannedSongs() {
    return new Promise((resolve, reject) => {
        db.all('SELECT track_name, artist_name FROM banned_songs', (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function getUserBanned(userId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COALESCE(is_banned, 0) as is_banned FROM users WHERE id = ?", [userId], (err, row) => {
            if (err) return reject(err);
            resolve(row && row.is_banned === 1);
        });
    });
}

async function validateTrackUris(uris) {
    if (!Array.isArray(uris) || uris.length === 0) return { valid: true };

    for (const uri of uris) {
        if (!isValidTrackUri(uri)) {
            return { valid: false, error: `Invalid track URI: ${uri}` };
        }
    }

    await ensureSpotifyAccessToken();
    const trackResults = await Promise.all(uris.map(async uri => {
        try {
            const result = await spotifyApi.getTrack(extractTrackId(uri));
            return { track: result?.body || null, skipped: false };
        } catch (err) {
            const status = err?.statusCode ?? err?.response?.statusCode;
            if (status === 403 || status === 429) {
                console.warn(`[custom-playlists:validate] getTrack ${uri} returned ${status} — skipping banned check`);
                return { track: null, skipped: true };
            }
            console.warn(`[custom-playlists:validate] getTrack ${uri} failed (${status ?? 'unknown'}):`, err?.message);
            return { track: null, skipped: false };
        }
    }));

    const bannedSongs = await getBannedSongs();
    const bannedPairs = new Set(
        bannedSongs.map(b => `${(b.track_name || '').trim().toLowerCase()}::${(b.artist_name || '').trim().toLowerCase()}`)
    );

    for (let i = 0; i < trackResults.length; i++) {
        const { track, skipped } = trackResults[i];
        if (skipped) continue;
        if (!track) return { valid: false, error: `Track not found: ${uris[i]}` };

        const name = (track.name || '').trim().toLowerCase();
        const artist = (track.artists || []).map(a => a.name).join(', ').trim().toLowerCase();
        if (bannedPairs.has(`${name}::${artist}`)) {
            return { valid: false, error: `"${track.name}" is banned` };
        }
    }

    return { valid: true };
}

function getCustomPlaylist(playlistDbId, userId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, spotify_playlist_id, name, song_count, image_url, user_id FROM custom_playlists WHERE id = ?',
            [playlistDbId],
            (err, row) => {
                if (err) return reject(err);
                if (!row || row.user_id !== Number(userId)) return resolve(null);
                resolve(row);
            }
        );
    });
}

function getCustomPlaylistById(playlistDbId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT id, spotify_playlist_id, name, song_count, image_url, user_id FROM custom_playlists WHERE id = ?',
            [playlistDbId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row || null);
            }
        );
    });
}

function isSpotifyNotFoundError(err) {
    return err?.statusCode === 404 || err?.body?.error?.status === 404;
}

function deleteCustomPlaylistById(playlistDbId) {
    return new Promise((resolve, reject) => {
        db.run('DELETE FROM custom_playlists WHERE id = ?', [playlistDbId], function (err) {
            if (err) return reject(err);
            resolve(this.changes || 0);
        });
    });
}

function updateCustomPlaylistImage(playlistDbId, imageUrl) {
    return new Promise((resolve, reject) => {
        db.run('UPDATE custom_playlists SET image_url = ? WHERE id = ?', [imageUrl || null, playlistDbId], (err) => {
            if (err) return reject(err);
            resolve();
        });
    });
}

async function ensureCustomPlaylistExistsOrCleanup(playlistRow) {
    if (!playlistRow?.spotify_playlist_id) {
        return { exists: false, deleted: true, imageUrl: null };
    }

    await ensureSpotifyAccessToken();
    try {
        const playlistMeta = await spotifyApi.getPlaylist(playlistRow.spotify_playlist_id, { fields: 'id,images' });
        const imageUrl = playlistMeta.body?.images?.[0]?.url || null;

        if ((playlistRow.image_url || null) !== imageUrl) {
            await updateCustomPlaylistImage(playlistRow.id, imageUrl);
        }

        return { exists: true, deleted: false, imageUrl };
    } catch (err) {
        if (isSpotifyNotFoundError(err)) {
            await deleteCustomPlaylistById(playlistRow.id);
            return { exists: false, deleted: true, imageUrl: null };
        }
        throw err;
    }
}

// GET /api/custom-playlists — list all custom playlists
router.get('/api/custom-playlists', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(
                `SELECT cp.id, cp.spotify_playlist_id, cp.name, cp.song_count, cp.image_url, cp.created_at, cp.user_id,
                        COALESCE(u.display_name, 'Unknown') as owner_name
                 FROM custom_playlists cp
                 LEFT JOIN users u ON u.id = cp.user_id
                 ORDER BY cp.created_at DESC`,
                [],
                (err, rows) => err ? reject(err) : resolve(rows || [])
            );
        });
        const checkedRows = await Promise.all(rows.map(async (row) => {
            try {
                const check = await ensureCustomPlaylistExistsOrCleanup(row);
                if (!check.exists) return null;
                return {
                    ...row,
                    image_url: check.imageUrl || row.image_url || null,
                    is_owner: Number(row.user_id) === Number(userId)
                };
            } catch (verifyErr) {
                console.warn('[custom-playlists:list] verify failed for row', row.id, verifyErr.message);
                return {
                    ...row,
                    is_owner: Number(row.user_id) === Number(userId)
                };
            }
        }));

        res.json({ ok: true, playlists: checkedRows.filter(Boolean) });
    } catch (err) {
        console.error('[custom-playlists:list]', err);
        res.status(500).json({ ok: false, error: 'Failed to load playlists' });
    }
});

// POST /api/custom-playlists/create — create a playlist with a name + up to 5 initial songs
router.post('/api/custom-playlists/create', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { name, trackUris = [] } = req.body || {};

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length > 100) {
        return res.status(400).json({ ok: false, error: 'Playlist name must be between 1 and 100 characters' });
    }

    if (!Array.isArray(trackUris) || trackUris.length > INITIAL_FREE_SONGS) {
        return res.status(400).json({ ok: false, error: `You can add up to ${INITIAL_FREE_SONGS} songs on creation` });
    }

    try {
        const trackValidation = await validateTrackUris(trackUris);
        if (!trackValidation.valid) {
            return res.status(400).json({ ok: false, error: trackValidation.error });
        }

        await ensureSpotifyAccessToken();
        const accessToken = spotifyApi.getAccessToken();

        const createRes = await fetch('https://api.spotify.com/v1/me/playlists', {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmedName, public: false, description: 'Custom playlist created via Jukebar' })
        });
        if (!createRes.ok) throw new Error(`createPlaylist failed: ${createRes.status}`);
        const createData = await createRes.json();
        const spotifyPlaylistId = createData.id;
        let playlistImageUrl = createData.images?.[0]?.url || null;

        if (trackUris.length > 0) {
            const addRes = await fetch(`https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/items`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ uris: trackUris })
            });
            if (!addRes.ok) throw new Error(`addTracks failed: ${addRes.status}`);
        }

        if (!playlistImageUrl && spotifyPlaylistId) {
            try {
                const playlistMeta = await spotifyApi.getPlaylist(spotifyPlaylistId);
                playlistImageUrl = playlistMeta.body?.images?.[0]?.url || null;
            } catch (coverErr) {
                console.warn('[custom-playlists:create] could not fetch playlist cover:', coverErr.message);
            }
        }

        const dbId = await new Promise((resolve, reject) => {
            db.run(
                'INSERT INTO custom_playlists (user_id, spotify_playlist_id, name, song_count, image_url) VALUES (?, ?, ?, ?, ?)',
                [userId, spotifyPlaylistId, trimmedName, trackUris.length, playlistImageUrl],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'createPlaylist',
            trackURI: null,
            trackName: trimmedName,
            artistName: `${trackUris.length} initial track(s)`,
            cost: 0
        }).catch(err => console.error('[custom-playlists:create] log failed:', err));

        res.json({
            ok: true,
            playlist: {
                id: dbId,
                spotifyPlaylistId,
                name: trimmedName,
                songCount: trackUris.length,
                image: playlistImageUrl
            }
        });
    } catch (err) {
        console.error('[custom-playlists:create]', err);
        res.status(500).json({ ok: false, error: 'Failed to create playlist' });
    }
});

// GET /api/custom-playlists/:id/tracks — fetch tracks for a custom playlist
router.get('/api/custom-playlists/:id/tracks', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const playlistDbId = parseInt(req.params.id);
    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });

    try {
        const playlist = await getCustomPlaylistById(playlistDbId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        await ensureSpotifyAccessToken();
        const tracks = [];
        let offset = 0;
        const limit = 100;

        while (true) {
            const fetchRes = await fetch(`https://api.spotify.com/v1/playlists/${playlist.spotify_playlist_id}/items?limit=${limit}&offset=${offset}`, {
                headers: { Authorization: `Bearer ${spotifyApi.getAccessToken()}` }
            });
            const data = await fetchRes.json();
            const items = data?.items || [];
            tracks.push(...items.filter(item => {
                const t = item?.item ?? item?.track;
                return t && !t.is_local && t.uri?.startsWith('spotify:track:');
            }));
            if (items.length < limit) break;
            offset += limit;
        }

        const simplified = tracks.map(item => {
            const t = item.item ?? item.track;
            return {
                uri: t.uri,
                name: t.name,
                artist: (t.artists || []).map(a => a.name).join(', '),
                album: { image: t.album?.images?.[0]?.url || null }
            };
        });

        res.json({
            ok: true,
            playlist: {
                id: playlistDbId,
                name: playlist.name,
                canEdit: Number(playlist.user_id) === Number(userId)
            },
            tracks: simplified
        });
    } catch (err) {
        console.error('[custom-playlists:tracks]', err);
        res.status(500).json({ ok: false, error: 'Failed to load tracks' });
    }
});

// POST /api/custom-playlists/add-song — add a song to a custom playlist
router.post('/api/custom-playlists/add-song', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { playlistId, trackUri } = req.body || {};
    const playlistDbId = parseInt(playlistId);

    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });
    if (!isValidTrackUri(trackUri)) return res.status(400).json({ ok: false, error: 'Invalid track URI' });

    try {
        const playlist = await getCustomPlaylist(playlistDbId, userId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        const trackValidation = await validateTrackUris([trackUri]);
        if (!trackValidation.valid) {
            return res.status(400).json({ ok: false, error: trackValidation.error });
        }

        await ensureSpotifyAccessToken();
        const accessToken = spotifyApi.getAccessToken();
        const addRes = await fetch(`https://api.spotify.com/v1/playlists/${playlist.spotify_playlist_id}/items`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: [trackUri] })
        });
        if (!addRes.ok) throw new Error(`addTracks failed: ${addRes.status}`);

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE custom_playlists SET song_count = song_count + 1 WHERE id = ?',
                [playlistDbId],
                err => err ? reject(err) : resolve()
            );
        });

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'addPlaylistSong',
            trackURI: trackUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: 0
        }).catch(err => console.error('[custom-playlists:add-song] log failed:', err));

        res.json({ ok: true, message: 'Song added to playlist' });
    } catch (err) {
        console.error('[custom-playlists:add-song]', err);
        res.status(500).json({ ok: false, error: 'Failed to add song to playlist' });
    }
});

// POST /api/custom-playlists/remove-song — remove a song from a custom playlist
router.post('/api/custom-playlists/remove-song', isAuthenticated, async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const userBanned = await getUserBanned(userId).catch(() => false);
    if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

    const { playlistId, trackUri } = req.body || {};
    const playlistDbId = parseInt(playlistId);

    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });
    if (!isValidTrackUri(trackUri)) return res.status(400).json({ ok: false, error: 'Invalid track URI' });

    try {
        const playlist = await getCustomPlaylist(playlistDbId, userId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        await ensureSpotifyAccessToken();
        const removeToken = spotifyApi.getAccessToken();
        const removeRes = await fetch(`https://api.spotify.com/v1/playlists/${playlist.spotify_playlist_id}/items`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${removeToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ uri: trackUri }] })
        });
        if (!removeRes.ok) throw new Error(`removeTracks failed: ${removeRes.status}`);

        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE custom_playlists SET song_count = MAX(0, song_count - 1) WHERE id = ?',
                [playlistDbId],
                err => err ? reject(err) : resolve()
            );
        });

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'removePlaylistSong',
            trackURI: trackUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: 0
        }).catch(err => console.error('[custom-playlists:remove-song] log failed:', err));

        res.json({ ok: true, message: 'Song removed from playlist' });
    } catch (err) {
        console.error('[custom-playlists:remove-song]', err);
        res.status(500).json({ ok: false, error: 'Failed to remove song from playlist' });
    }
});

// POST /api/custom-playlists/queue — start playback from a custom playlist
router.post('/api/custom-playlists/queue', isAuthenticated, playbackRateLimit(MODIFY), async (req, res) => {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const { playlistId } = req.body || {};
    const playlistDbId = parseInt(playlistId);
    if (isNaN(playlistDbId)) return res.status(400).json({ ok: false, error: 'Invalid playlist ID' });

    try {
        const playlist = await getCustomPlaylistById(playlistDbId);
        if (!playlist) return res.status(403).json({ ok: false, error: 'Playlist not found' });

        const playlistCheck = await ensureCustomPlaylistExistsOrCleanup(playlist);
        if (!playlistCheck.exists) {
            return res.status(410).json({ ok: false, error: 'This playlist was deleted from Spotify and removed from your list.' });
        }

        const userBanned = await getUserBanned(userId).catch(() => false);
        if (userBanned) return res.status(403).json({ ok: false, error: 'You have been banned from using Jukebar.' });

        await ensureSpotifyAccessToken();
        const playlistUri = `spotify:playlist:${playlist.spotify_playlist_id}`;
        await executePlaybackModify(req, 'customPlaylist-play', () => spotifyApi.play({ context_uri: playlistUri }));
        try {
            await executePlaybackModify(req, 'customPlaylist-shuffle', () => spotifyApi.setShuffle(true));
        } catch (shuffleErr) {
            console.warn('[custom-playlists:queue] could not enable shuffle:', shuffleErr.message);
        }

        try {
            await queueManager.syncWithSpotify(spotifyApi);
        } catch (syncErr) {
            console.warn('[custom-playlists:queue] queue sync failed:', syncErr.message);
        }

        const username = typeof req.session.user === 'string' ? req.session.user : String(req.session.user || 'Unknown');
        await logTransaction({
            userID: userId,
            displayName: username,
            action: 'playlist',
            trackURI: playlistUri,
            trackName: playlist.name,
            artistName: 'Custom Playlist',
            cost: 0
        }).catch(err => console.error('[custom-playlists:queue] log failed:', err));

        res.json({ ok: true, message: `Started playlist playback (${playlist.name})` });
    } catch (err) {
        console.error('[custom-playlists:queue]', err);
        res.status(500).json({ ok: false, error: 'Failed to play playlist' });
    }
});

module.exports = router;
