const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./utils/database');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
let brokeyEnabled = false;

/** In-memory: periodic Spotify sync + diagnostics. Toggle via POST /api/spotify-background (no server restart). */
let spotifyBackgroundApiEnabled = String(process.env.SPOTIFY_BACKGROUND_API || 'true').toLowerCase() !== 'false';

app.use((req, res, next) => { return next(); });

const server = http.createServer(app);
const io = new Server(server);

app.set('io', io);
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const SESSION_SECRET = process.env.SESSION_SECRET || 'jukebar-dev-secret';

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const { isAuthenticated } = require('./middleware/auth');
const { router: authRoutes } = require('./routes/auth');
const spotifyRoutes = require('./routes/spotify');
const userRoutes = require('./routes/users');
const queueManager = require('./utils/queueManager');
const { spotifyApi, ensureSpotifyAccessToken } = require('./utils/spotify');
const { READ, playbackRateLimit, executePlaybackRead, setSpotifyPlaybackCooldown, getRetryAfterFromError, isSpotify429 } = require('./middleware/spotifyPlaybackRateLimit');
const path = require('path');
const fs = require('fs');

function reloadSocketSession(socket) {
    return new Promise((resolve) => {
        const session = socket?.request?.session;
        if (!session || typeof session.reload !== 'function') {
            return resolve(session || null);
        }
        session.reload((err) => {
            if (err) {
                console.warn('[socket] Failed to reload session:', err.message || err);
                return resolve(socket?.request?.session || session);
            }
            return resolve(socket?.request?.session || session);
        });
    });
}

function enableBrokey(reason = 'unknown') {
    if (brokeyEnabled) return;
    brokeyEnabled = true;
    console.error(`[brokey] Enabled due to: ${reason}`);
}

function isBrokeyEnabled() {
    return brokeyEnabled;
}

function toRetryAfterSeconds(valueMs) {
    const seconds = Math.ceil(Math.max(0, Number(valueMs) || 0) / 1000);
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

function spotifyRetryAfterSecondsFromError(error) {
    const raw = getRetryAfterFromError(error);
    const sec = Number.parseInt(String(raw || ''), 10);
    if (Number.isFinite(sec) && sec > 0) return sec;
    return 10;
}

function getLimiterRetryAfterSeconds(req) {
    const resetTime = req.rateLimit?.resetTime;
    if (!resetTime) return 30;
    const resetMs = resetTime instanceof Date ? resetTime.getTime() : Number(resetTime);
    return Math.max(1, toRetryAfterSeconds(resetMs - Date.now()));
}

const limiter = rateLimit({
    windowMs: 30 * 1000,
    limit: 180,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => {
        const userId = req.session?.userId;
        if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
            return `user:${String(userId)}`;
        }
        return `ip:${req.ip}`;
    },
    handler: (req, res) => {
        const retryAfterSeconds = getLimiterRetryAfterSeconds(req);
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).render('rateLimit.ejs', {
            title: 'Jukebar Rate Limited',
            message: 'Hey bud, you\'re making too many requests. Stop it.',
            retryAfterSeconds
        });
    }
});

app.use(limiter);

async function runSpotifyDiagnostics() {
    if (!process.env.SPOTIFY_CLIENT_ID) return;
    try {
        await ensureSpotifyAccessToken();
        await executePlaybackRead({ session: null, ip: 'diagnostics-loop' }, 'diagnostics-loop-devices', () => spotifyApi.getMyDevices());
    } catch (err) {
        const status = err?.statusCode ?? err?.response?.statusCode ?? err?.body?.error?.status;
        if (Number(status) === 429) {
            setSpotifyPlaybackCooldown(READ, getRetryAfterFromError(err), 'runSpotifyDiagnostics');
            queueManager.setSpotifyCooldown(getRetryAfterFromError(err), 'runSpotifyDiagnostics');
            enableBrokey('Spotify diagnostics returned 429');
        }
    }
}

app.get('/diagnostics', isAuthenticated, playbackRateLimit(READ), async (req, res) => {
    const report = {
        timestamp: new Date().toISOString(),
        brokey: isBrokeyEnabled(),
        searchRateLimitedForSeconds: 0,
        tests: {}
    };

    try {
        await ensureSpotifyAccessToken();

        try {
            const me = await spotifyApi.getMe();
            report.tests.userAccess = {
                status: 'pass',
                message: 'Successfully retrieved user info',
                user: me.body?.display_name || 'Unknown',
                note: 'Premium status cannot be verified via API for Development Mode apps (product field removed Feb 2026)'
            };
        } catch (error) {
            report.tests.userAccess = {
                status: 'fail',
                message: error.message || 'Failed to get user info',
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        try {
            const searchResult = await spotifyApi.searchTracks('test', { limit: 1 });
            report.searchRateLimitedForSeconds = 0;
            report.tests.searchScope = {
                status: 'pass',
                message: 'Search endpoint working',
                totalResults: searchResult.body?.tracks?.total || 0,
                rateLimitedForSeconds: 0
            };
        } catch (error) {
            const is429 = Number(error?.statusCode) === 429;
            if (is429) enableBrokey('Diagnostics /searchScope returned 429');
            const rateLimitedForSeconds = is429 ? spotifyRetryAfterSecondsFromError(error) : 0;
            report.searchRateLimitedForSeconds = rateLimitedForSeconds;
            report.tests.searchScope = {
                status: 'fail',
                message: error.message || 'Search failed',
                statusCode: error.statusCode,
                errorBody: error.body?.error || null,
                rateLimitedForSeconds
            };
        }

        try {
            const trackResult = await spotifyApi.getTrack('3n3Ppam7vgaVa1iaRUc9Lp');
            report.tests.albumArtLookup = {
                status: 'pass',
                message: 'Track lookup working',
                track: trackResult.body?.name || 'Unknown',
                hasImage: !!(trackResult.body?.album?.images?.length > 0)
            };
        } catch (error) {
            if (Number(error?.statusCode) === 429) enableBrokey('Diagnostics /albumArtLookup returned 429');
            report.tests.albumArtLookup = {
                status: 'fail',
                message: error.message || 'Track lookup failed',
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        try {
            const playback = await executePlaybackRead(req, 'diagnostics-playbackRead', () => spotifyApi.getMyCurrentPlayingTrack());
            const isPlaying = !!playback.body?.item;
            report.tests.playbackRead = {
                status: 'pass',
                message: 'Playback state readable',
                isCurrentlyPlaying: isPlaying,
                currentTrack: isPlaying ? playback.body.item.name : null
            };
        } catch (error) {
            if (Number(error?.statusCode) === 429) enableBrokey('Diagnostics /playbackRead returned 429');
            report.tests.playbackRead = {
                status: 'fail',
                message: error.message || 'Failed to read playback state',
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        try {
            const deviceResult = await executePlaybackRead(req, 'diagnostics-playbackModifyCheck', () => spotifyApi.getMyDevices());
            const hasDevice = (deviceResult.body?.devices?.length || 0) > 0;
            report.tests.playbackModify = {
                status: hasDevice ? 'pass' : 'warning',
                message: hasDevice ? 'Playback modify scope available' : 'No active devices found',
                activeDevices: deviceResult.body?.devices?.length || 0,
                deviceNames: deviceResult.body?.devices?.map(d => d.name) || []
            };
        } catch (error) {
            if (Number(error?.statusCode) === 429) enableBrokey('Diagnostics /playbackModify returned 429');
            report.tests.playbackModify = {
                status: 'fail',
                message: error.message || 'Failed to check playback modify scope',
                statusCode: error.statusCode,
                errorBody: error.body?.error || null
            };
        }

        const passCount = Object.values(report.tests).filter(t => t.status === 'pass').length;
        const failCount = Object.values(report.tests).filter(t => t.status === 'fail').length;
        const warnCount = Object.values(report.tests).filter(t => t.status === 'warning').length;
        report.summary = {
            passed: passCount,
            failed: failCount,
            warnings: warnCount,
            allPassed: failCount === 0,
            recommendation: failCount > 0
                ? 'One or more tests failed. Check details above and verify Spotify token scopes.'
                : warnCount > 0
                    ? 'All tests passed but warnings were detected.'
                    : 'All tests passed. Spotify credentials appear to be working correctly.'
        };

        report.brokey = isBrokeyEnabled();
    } catch (err) {
        if (isSpotify429(err)) {
            const retryAfter = getRetryAfterFromError(err);
            setSpotifyPlaybackCooldown(READ, retryAfter, 'GET /diagnostics');
            queueManager.setSpotifyCooldown(retryAfter, 'GET /diagnostics');
            enableBrokey('Diagnostics endpoint returned 429');
        }
        report.error = err?.message || 'Diagnostics endpoint failed';
        report.brokey = isBrokeyEnabled();
        return res.status(500).json(report);
    }

    return res.json(report);
});

function canManageSpotifyBackgroundApi(req) {
    return !!req.session?.userId && !!process.env.SPOTIFY_CLIENT_ID;
}

app.get('/api/spotify-background', isAuthenticated, (req, res) => {
    if (!canManageSpotifyBackgroundApi(req)) {
        return res.status(403).json({ ok: false, error: 'Insufficient permissions or Spotify not configured' });
    }
    return res.json({ ok: true, enabled: spotifyBackgroundApiEnabled });
});

app.post('/api/spotify-background', isAuthenticated, (req, res) => {
    if (!canManageSpotifyBackgroundApi(req)) {
        return res.status(403).json({ ok: false, error: 'Insufficient permissions or Spotify not configured' });
    }
    if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'JSON body must include boolean "enabled"' });
    }
    spotifyBackgroundApiEnabled = req.body.enabled;
    console.log(`[spotify] Background API ${spotifyBackgroundApiEnabled ? 'enabled' : 'disabled'} (user ${req.session?.userId})`);
    return res.json({ ok: true, enabled: spotifyBackgroundApiEnabled });
});

let changelog = [];
try {
    const changelogPath = path.join(__dirname, 'changelog.json');
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    const parsedChangelog = JSON.parse(changelogContent);
    changelog = Array.isArray(parsedChangelog) ? parsedChangelog : [];
    console.log(`Loaded changelog with ${changelog.length} entries`);
} catch (err) {
    console.warn('Failed to load changelog.json:', err.message);
    changelog = [];
}

function getChangelogLatestKey(entries) {
    if (!Array.isArray(entries) || !entries[0]) return '';
    const e = entries[0];
    return `${String(e.version || '').trim()}|${String(e.releaseDate || '').trim()}`;
}

const changelogLatestKey = getChangelogLatestKey(changelog);

async function handleBanPassed(trackName, trackArtist, trackUri) {
    console.log(`=== HANDLING BAN FOR: "${trackName}" by "${trackArtist}" ===`);
    const removedCount = queueManager.removeByNameAndArtist(trackName, trackArtist);
    console.log(`Removed ${removedCount} matching track(s) from queue`);

    const currentlyPlayingBannedTrack =
        queueManager.isCurrentTrackUri(trackUri) ||
        queueManager.isCurrentlyPlaying(trackName, trackArtist);
    if (currentlyPlayingBannedTrack) {
        console.log('Banned song is currently playing - skipping it');
        try {
            await ensureSpotifyAccessToken();
            await spotifyApi.skipToNext();
            await queueManager.skipTrack();
            console.log('Successfully skipped banned song');
        } catch (skipError) {
            console.error('Failed to skip banned song:', skipError.message);
        }
    }
}

let lastAutoSkippedBannedUri = null;
let lastAutoSkippedAt = 0;

async function enforceCurrentTrackBanByUri() {
    try {
        await ensureSpotifyAccessToken();
        const playback = await executePlaybackRead(
            { session: null, ip: 'ban-enforcer' },
            'ban-enforcer-current-track',
            () => spotifyApi.getMyCurrentPlayingTrack()
        );
        const currentUri = String(playback?.body?.item?.uri || '').trim();
        if (!currentUri) return false;

        const isBanned = await new Promise((resolve) => {
            db.get(
                'SELECT 1 FROM banned_songs WHERE TRIM(COALESCE(track_uri, \'\')) = ? LIMIT 1',
                [currentUri],
                (err, row) => {
                    if (err) {
                        console.error('Failed checking banned track URI:', err);
                        return resolve(false);
                    }
                    return resolve(!!row);
                }
            );
        });

        if (!isBanned) return false;

        if (lastAutoSkippedBannedUri === currentUri && (Date.now() - lastAutoSkippedAt) < 15000) {
            return false;
        }

        console.log(`Auto-skipping banned currently playing track URI: ${currentUri}`);
        lastAutoSkippedBannedUri = currentUri;
        lastAutoSkippedAt = Date.now();
        await spotifyApi.skipToNext();
        return true;
    } catch (err) {
        if (isSpotify429(err)) {
            const retryAfter = getRetryAfterFromError(err);
            setSpotifyPlaybackCooldown(READ, retryAfter, 'ban-enforcer');
            queueManager.setSpotifyCooldown(retryAfter, 'ban-enforcer');
        }
        console.warn('ban-enforcer check failed:', err?.message || err);
        return false;
    }
}

io.on('connection', (socket) => {
    const userId = socket.request?.session?.userId;
    if (userId) {
        socket.join(`user:${userId}`);
    }

    queueManager.addClient(socket);

    socket.on('disconnect', () => {
        queueManager.removeClient(socket);
    });

    socket.on('requestQueueUpdate', () => {
        socket.emit('queueUpdate', queueManager.getCurrentState());
    });

});

if (process.env.SPOTIFY_CLIENT_ID) {
    const { spotifyApi } = require('./utils/spotify');

    async function initializeQueue() {
        try {
            console.log('Initializing queue from Spotify...');
            await queueManager.initializeFromSpotify(spotifyApi);
            console.log('Queue initialization complete');
        } catch (error) {
            console.warn('Could not initialize queue from Spotify:', error.message);
        }
    }

    initializeQueue();

    const spotifySyncIntervalMs = 2000;
    console.log(`Spotify sync interval set to ${spotifySyncIntervalMs}ms`);

    setInterval(async () => {
        if (!spotifyBackgroundApiEnabled) return;
        try {
            await queueManager.syncWithSpotify(spotifyApi);
            await enforceCurrentTrackBanByUri();
        } catch (error) {
            console.error('Sync interval error (non-fatal):', error.message);
        }
    }, spotifySyncIntervalMs);
}

app.get('/', isAuthenticated, (req, res) => {
    try {
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.userId,
            changelog: changelog,
            changelogLatestKey
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.get('/spotify', isAuthenticated, (req, res) => {
    try {
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.userId,
            changelog: changelog,
            changelogLatestKey
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.use('/', authRoutes);
app.use('/', spotifyRoutes);
app.use('/', userRoutes);
app.use('/', require('./routes/customPlaylists'));

server.listen(port, async () => {
    io.disconnectSockets();
    console.log(`Server listening at http://localhost:${port}`);
    if (spotifyBackgroundApiEnabled) {
        runSpotifyDiagnostics().catch((err) => {
            console.warn('[diagnostics] Initial Spotify diagnostics failed:', err?.message || err);
        });
    }
    setInterval(() => {
        if (!spotifyBackgroundApiEnabled) return;
        runSpotifyDiagnostics().catch((err) => {
            console.warn('[diagnostics] Spotify diagnostics failed:', err?.message || err);
        });
    }, 10000);
});

module.exports = { app, io };
