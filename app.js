const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const db = require('./utils/database');
const { isOwner, getOwnerIds } = require('./utils/owners');
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
let brokeyEnabled = false;
const voteBanDevModeEnabled = String(process.env.JUKEBAR_DEV_MODE || '').toLowerCase() === 'true';
const voteBanMinOnlineUsers = voteBanDevModeEnabled ? 1 : 5;

/** In-memory: periodic Spotify sync + diagnostics. Toggle via POST /api/spotify-background (no server restart). */
let spotifyBackgroundApiEnabled = String(process.env.SPOTIFY_BACKGROUND_API || 'true').toLowerCase() !== 'false';

// Brokey mode is tracked for diagnostics only; do not block the UI.
app.use((req, res, next) => {
    return next();
});

const server = http.createServer(app);
const io = new Server(server);

// Make io accessible from routes via req.app.get('io')
app.set('io', io);

app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const sessionMiddleware = session({
    secret: process.env.FORMBAR_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true on HTTPS in production
        httpOnly: true,
        sameSite: 'lax', // helps mitigate CSRF for top-level navigation
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
});

app.use(sessionMiddleware);

// Share session with socket.io
io.engine.use(sessionMiddleware);

const { isAuthenticated } = require('./middleware/auth');

const { router: authRoutes } = require('./routes/auth');
const spotifyRoutes = require('./routes/spotify');
const paymentRoutes = require('./routes/payment');
const { router: leaderboardRoutes } = require('./routes/leaderboard');
const userRoutes = require('./routes/users');
const queueManager = require('./utils/queueManager');
const { setupFormbarSocket, getCurrentClassroom } = require('./routes/socket');
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

/** Seconds Spotify asks to wait after 429; default matches playback middleware when Retry-After is missing. */
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
    windowMs: 30 * 1000, // Keep a short rolling window for bursts.
    limit: 180, // Allow normal UI refresh/fetch bursts without false positives.
    standardHeaders: 'draft-8', // draft-6: `RateLimit-*` headers; draft-7 & draft-8: combined `RateLimit` header
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers.
    keyGenerator: (req) => {
        // Prefer a stable per-user key for authenticated requests.
        const userId = req.session?.token?.id;
        if (userId !== undefined && userId !== null && String(userId).trim() !== '') {
            return `user:${String(userId)}`;
        }
        // Fallback for unauthenticated traffic (e.g., login/static probes).
        return `ip:${req.ip}`;
    },
    // store: ... , // Redis, Memcached, etc. See below.
    handler: (req, res) => {
        const retryAfterSeconds = getLimiterRetryAfterSeconds(req);
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).render('rateLimit.ejs', {
            title: 'Jukebar Rate Limited',
            message: 'Hey bud, you\'re making too many requests. Stop it.',
            retryAfterSeconds
        });
    }
})

app.use(limiter);



async function runSpotifyDiagnostics() {
    if (!process.env.SPOTIFY_CLIENT_ID) return;
    try {
        await ensureSpotifyAccessToken();
        // Lightweight playback-health probe.
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
    const userId = req.session?.token?.id;
    const isTeacherUser = req.session?.permission >= 4 || isOwner(userId);
    if (!isTeacherUser) {
        return res.status(403).json({ ok: false, error: 'Insufficient permissions' });
    }

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
    const userId = req.session?.token?.id;
    return (req.session?.permission >= 4 || isOwner(userId)) && !!process.env.SPOTIFY_CLIENT_ID;
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
    console.log(
        `[spotify] Background API ${spotifyBackgroundApiEnabled ? 'enabled' : 'disabled'} (user ${req.session?.token?.id})`
    );
    return res.json({ ok: true, enabled: spotifyBackgroundApiEnabled });
});

let changelog = [];
try {
    const changelogPath = path.join(__dirname, 'changelog.json');
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    const parsedChangelog = JSON.parse(changelogContent);
    // Keep array as-is (newest first in JSON file)
    changelog = Array.isArray(parsedChangelog) ? parsedChangelog : [];
    console.log(`Loaded changelog with ${changelog.length} entries`);
} catch (err) {
    console.warn('Failed to load changelog.json:', err.message);
    changelog = [];
}

function getChangelogLatestKey(entries) {
    if (!Array.isArray(entries) || !entries[0]) {
        return '';
    }
    const e = entries[0];
    return `${String(e.version || '').trim()}|${String(e.releaseDate || '').trim()}`;
}

const changelogLatestKey = getChangelogLatestKey(changelog);

// Helper function to handle ban - removes from queue and skips if currently playing
async function handleBanPassed(trackName, trackArtist, trackUri) {
    console.log(`=== HANDLING BAN FOR: "${trackName}" by "${trackArtist}" ===`);

    // Remove matching tracks from the queue
    const removedCount = queueManager.removeByNameAndArtist(trackName, trackArtist);
    console.log(`Removed ${removedCount} matching track(s) from queue`);

    // Check if the banned song is currently playing - prefer URI match, fallback to name/artist.
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

        // Prevent repeated skip attempts for the same URI in short bursts.
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

// Formbar Socket.IO connection
const FORMBAR_ADDRESS = process.env.FORMBAR_ADDRESS;
const API_KEY = process.env.API_KEY || '';
const FORMBAR_POLL_BAN_VOTE = process.env.FORMBAR_POLL_BAN_VOTE

console.log('=== Formbar Configuration ===');
console.log('FORMBAR_ADDRESS:', FORMBAR_ADDRESS);
console.log('API_KEY present:', !!API_KEY);
console.log('API_KEY length:', API_KEY.length);
console.log('JUKEBAR_DEV_MODE:', voteBanDevModeEnabled);
console.log('Ban vote minimum users:', voteBanMinOnlineUsers);
console.log('=============================');

const formbarSocket = ioClient(FORMBAR_ADDRESS, {
    extraHeaders: { api: API_KEY },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
});

console.log('Formbar socket client created, attempting connection...');

setupFormbarSocket(io, formbarSocket, API_KEY);

// WebSocket connection handling for queue sync
// Initialize VoteManager
const VoteManager = require('./utils/voteManager');
const voteManager = new VoteManager();

io.on('connection', (socket) => {
    //console.log('Client connected for queue sync');

    // Join user-specific room for targeted events (e.g. recently queued updates)
    const userId = socket.request?.session?.token?.id;
    if (userId) {
        socket.join(`user:${userId}`);
    }

    // Broadcast updated user count to all clients
    io.emit('userCount', io.engine.clientsCount);

    // Send active ban vote to newly connected user
    const activeVote = voteManager.getActiveVote();
    if (activeVote) {
        socket.emit('banVoteStarted', activeVote);
    }

    // Send current auxiliary permission to newly connected client
    const classroom = getCurrentClassroom();
    if (classroom && classroom.permissions && classroom.permissions.auxiliary) {
        const auxiliaryPermission = parseInt(classroom.permissions.auxiliary);
        console.log('Sending initial auxiliary permission to new client:', auxiliaryPermission);
        socket.emit('auxiliaryPermission', auxiliaryPermission);
    }

    // Add client to queue manager
    queueManager.addClient(socket);

    // Handle client disconnect
    socket.on('disconnect', () => {
        //console.log('Client disconnected from queue sync');
        queueManager.removeClient(socket);
        // Broadcast updated user count after disconnect
        io.emit('userCount', io.engine.clientsCount);
    });

    // Handle queue actions from clients
    socket.on('requestQueueUpdate', () => {
        socket.emit('queueUpdate', queueManager.getCurrentState());
    });

    // Handle ban vote initiation
    socket.on('initiateBanVote', async (data) => {
        try {
            const { trackUri, trackName, trackArtist, initiator, reason, trackImage } = data;
            const userId = socket.request?.session?.token?.id || socket.id;
            const banReason = (typeof reason === 'string' && reason.trim()) ? reason.trim() : 'student ban';
            const imageUrl = typeof trackImage === 'string' ? trackImage : null;

            if (banReason.length > 200) {
                socket.emit('banVoteError', { error: 'Ban reason must be 200 characters or fewer' });
                return;
            }

            // Check if user is banned
            const userBanRow = await new Promise((resolve, reject) => {
                db.get("SELECT COALESCE(isBanned, 0) as isBanned FROM users WHERE id = ?", [userId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (userBanRow && userBanRow.isBanned === 1) {
                socket.emit('banVoteError', { error: 'You have been banned from using Jukebar. Contact your teacher.' });
                return;
            }

            // Check if user is an owner (bypass payment)
            const userIsOwner = isOwner(userId);

            // Verify payment for non-owners (but DON'T consume it yet)
            if (!userIsOwner) {
                let hasPaid = !!socket.request?.session?.hasPaid;
                if (!hasPaid) {
                    const refreshedSession = await reloadSocketSession(socket);
                    hasPaid = !!refreshedSession?.hasPaid;
                }

                if (!hasPaid) {
                    socket.emit('banVoteError', { error: 'Payment required to start a ban vote' });
                    return;
                }
            }

            // --- Run ALL validation checks BEFORE consuming payment ---

            // Get online user count
            const onlineCount = io.engine.clientsCount;

            // Check minimum users requirement
            if (onlineCount < voteBanMinOnlineUsers) {
                socket.emit('banVoteError', { error: `At least ${voteBanMinOnlineUsers} users must be online to start a ban vote` });
                return; // Payment NOT consumed – user keeps their digipogs
            }

            // Check if there's already an active vote
            if (voteManager.hasActiveVote()) {
                socket.emit('banVoteError', { error: 'Please wait for the current ban vote to complete before starting a new one' });
                return; // Payment NOT consumed
            }

            // Check if track is already banned
            const isBanned = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM banned_songs WHERE track_name = ? AND artist_name = ?', [trackName, trackArtist], (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                });
            });

            if (isBanned) {
                socket.emit('banVoteError', { error: 'This track is already banned' });
                return; // Payment NOT consumed
            }

            // --- All checks passed – NOW consume the payment ---
            if (!userIsOwner) {
                socket.request.session.hasPaid = false;
                socket.request.session.save((saveErr) => {
                    if (saveErr) {
                        console.warn('[socket] Failed to persist hasPaid=false after ban vote start:', saveErr.message || saveErr);
                    }
                });
            }

            // Start the vote with expiration callback
            const voteId = `${trackUri}-${Date.now()}`;

            // Do the vote ban with formbar
            if (FORMBAR_POLL_BAN_VOTE === 'true') {
                let formbarBanFinalized = false;

                async function fbBanVoteResults(poll) {
                    if (formbarBanFinalized) {
                        console.log('Formbar ban vote already finalized; skipping duplicate result handling');
                        return;
                    }
                    formbarBanFinalized = true;
                    formbarSocket.off('classUpdate')
                    let votesFor = poll.find(r => r.answer == 'Yes').responses
                    let votesAgainst = poll.find(r => r.answer == 'No').responses

                    if (votesFor > votesAgainst) {
                        db.run(
                            'INSERT INTO banned_songs (track_name, artist_name, banned_by, reason, track_uri, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                            [trackName, trackArtist, userId, reason, trackUri, imageUrl],
                            async (err) => {
                                if (err) {
                                    console.error('Database insertion error (ban on expiration):', err);
                                } else {
                                    console.log('Successfully inserted ban into database (expiration)');
                                    // Handle ban - remove from queue and skip if playing
                                    await handleBanPassed(trackName, trackArtist, trackUri);
                                }
                            }
                        );
                        io.emit('banVotePassed', data);
                    } else {
                        console.log(`Ban vote failed (${votesFor} Yes to ${votesAgainst} No)`)
                    }
                }

                console.log(`Starting ban poll on formbar for ${trackName} by ${trackArtist}`)

                formbarSocket.emit('startPoll', {
                    prompt: `Ban "${trackName}" by ${trackArtist}?`,
                    answers: [
                        { answer: "Yes", weight: 0, color: "#00ff2a" },
                        { answer: "No", weight: 0, color: "#ff0000" }
                    ],
                    blind: false,
                    allowVoteChanges: true,
                    allowTextResponses: false,
                    allowMultipleResponses: false
                })

                formbarSocket.once('startPoll', () => {
                    io.emit('formbarVoteStarted', { artist: trackArtist, song: trackName })
                    console.log('Poll started')
                    let pastData

                    setTimeout(() => {
                        console.log('Attempting to end poll with data', pastData?.poll?.responses)
                        if (pastData?.poll?.responses) {
                            fbBanVoteResults(pastData.poll.responses)
                            formbarSocket.emit('updatePoll', {})
                            console.log('Auto ended poll')
                        }

                    }, process.env.FORMBAR_SONG_BAN_TIME * 1000)

                    formbarSocket.on('classUpdate', (data) => {
                        pastData = data

                        if (!data.poll.status) {
                            console.log('Tallying results')
                            fbBanVoteResults(data.poll.responses)
                        }
                    })
                })

            } else {
                // Do it normally
                const voteData = voteManager.startBanVote(
                    voteId,
                    trackUri,
                    trackName,
                    trackArtist,
                    banReason,
                    userId,
                    onlineCount,
                    async (expiredData) => {
                        if (expiredData.passed) {
                            console.log('Vote expired with pass, broadcasting banVotePassed:', expiredData);
                            db.run(
                                'INSERT INTO banned_songs (track_name, artist_name, banned_by, reason, track_uri, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                                [expiredData.trackName, expiredData.trackArtist, expiredData.userId, expiredData.reason, expiredData.trackUri, imageUrl],
                                async (err) => {
                                    if (err) {
                                        console.error('Database insertion error (ban on expiration):', err);
                                    } else {
                                        console.log('Successfully inserted ban into database (expiration)');
                                        // Handle ban - remove from queue and skip if playing
                                        await handleBanPassed(expiredData.trackName, expiredData.trackArtist, expiredData.trackUri);
                                    }
                                }
                            );
                            io.emit('banVotePassed', expiredData);
                        } else {
                            console.log('Vote expired, broadcasting banVoteFailed:', expiredData);
                            io.emit('banVoteFailed', expiredData);
                        }
                    },
                    { imageUrl }
                );

                // Broadcast to all clients
                io.emit('banVoteStarted', {
                    voteId,
                    trackUri,
                    trackName,
                    trackArtist,
                    initiator,
                    initiatorId: userId,
                    onlineCount: onlineCount,
                    totalOnline: onlineCount,
                    yesVotes: 1,
                    noVotes: 0,
                    reason: banReason,
                    expiresIn: voteData.expiresIn
                });
            }

        } catch (error) {
            console.error('Error initiating ban vote:', error);
            socket.emit('banVoteError', { error: 'Failed to initiate ban vote' });
        }
    });

    // Handle vote casting
    socket.on('castBanVote', async (data) => {
        try {
            const { voteId, vote } = data;
            const userId = socket.request?.session?.token?.id || socket.id;
            const result = voteManager.castVote(voteId, userId, vote);

            if (result.error) {
                socket.emit('banVoteError', { error: result.error });
                return;
            }

            if (result.passed) {
                console.log('Vote passed! Broadcasting banVotePassed:', result);
                // Insert into banned_songs table
                try {
                    await new Promise((resolve, reject) => {
                        console.log('Inserting into banned_songs:', result.trackName, result.trackArtist);
                        db.run(
                            'INSERT INTO banned_songs (track_name, artist_name, banned_by, reason, track_uri, image_url) VALUES (?, ?, ?, ?, ?, ?)',
                            [result.trackName, result.trackArtist, result.userId, result.reason, result.trackUri || null, result.extra?.imageUrl || null],
                            (err) => {
                                if (err) {
                                    console.error('Database insertion error:', err);
                                    reject(err);
                                } else {
                                    console.log('Successfully inserted ban into database');
                                    resolve();
                                }
                            }
                        );
                    });

                    // Handle ban - remove from queue and skip if playing
                    await handleBanPassed(result.trackName, result.trackArtist, result.trackUri);

                } catch (dbError) {
                    console.error('Failed to insert ban into database:', dbError);
                }

                // Broadcast vote passed
                io.emit('banVotePassed', {
                    trackUri: result.trackUri,
                    trackName: result.trackName,
                    trackArtist: result.trackArtist,
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes,
                    reason: result.reason
                });
            } else if (result.failed) {
                // Broadcast vote failed
                console.log('Broadcasting banVoteFailed:', result);
                io.emit('banVoteFailed', {
                    trackName: result.trackName,
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes,
                    reason: result.reason
                });
            } else {
                // Broadcast vote update
                io.emit('banVoteUpdate', {
                    yesVotes: result.yesVotes,
                    noVotes: result.noVotes,
                    onlineCount: result.onlineCount,
                    totalOnline: result.onlineCount,
                    trackName: result.trackName
                });
            }
        } catch (error) {
            console.error('Error casting ban vote:', error);
            socket.emit('banVoteError', { error: 'Failed to cast vote' });
        }
    });
});

// Initialize Spotify queue on startup
if (process.env.SPOTIFY_CLIENT_ID) {
    const { spotifyApi } = require('./utils/spotify');

    // Initialize queue from Spotify on startup
    async function initializeQueue() {
        try {
            console.log('Initializing queue from Spotify...');
            await queueManager.initializeFromSpotify(spotifyApi);
            console.log('Queue initialization complete');
        } catch (error) {
            console.warn('Could not initialize queue from Spotify:', error.message);
        }
    }

    // Call initialization
    initializeQueue();

    const spotifySyncIntervalMs = Math.max(8000, 5000);
    console.log(`Spotify sync interval set to ${spotifySyncIntervalMs}ms`);

    // Periodic Spotify sync with safer default interval
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

// Main routes
app.get('/', isAuthenticated, (req, res) => {
    try {
        console.log('Session permission:', req.session.permission);
        console.log('Changelog to render:', changelog.length, 'entries');
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || 2,
            ownerIDs: getOwnerIds(),
            songAmount: Number(process.env.SONG_AMOUNT) || 50,
            skipAmount: Number(process.env.SKIP_AMOUNT) || 100,
            skipShieldAmount: Number(process.env.SKIP_SHIELD) || 75,
            voteBanAmount: Number(process.env.VOTE_BAN_AMOUNT) || 500,
            createPlaylistAmount: Number(process.env.CREATE_PLAYLIST_AMOUNT) || 700,
            addPlaylistSongAmount: Number(process.env.ADD_PLAYLIST_SONG_AMOUNT) || 100,
            removePlaylistSongAmount: Number(process.env.REMOVE_PLAYLIST_SONG_AMOUNT) || 50,
            customPlaylistPlayAmount: Number(process.env.CUSTOM_PLAYLIST_PLAY_AMOUNT) || 250,
            banVoteMinOnlineUsers: voteBanMinOnlineUsers,
            changelog: changelog,
            changelogLatestKey
        });
    } catch (error) {
        res.send(error.message);
    }
});

app.get('/spotify', isAuthenticated, (req, res) => {
    try {
        console.log('Session permission (spotify route):', req.session.permission);
        res.render('player.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            hasPaid: !!req.session.hasPaid,
            payment: req.session.payment || null,
            userPermission: req.session.permission || 2,
            ownerIDs: getOwnerIds(),
            songAmount: Number(process.env.SONG_AMOUNT) || 50,
            skipAmount: Number(process.env.SKIP_AMOUNT) || 100,
            skipShieldAmount: Number(process.env.SKIP_SHIELD) || 75,
            voteBanAmount: Number(process.env.VOTE_BAN_AMOUNT) || 500,
            createPlaylistAmount: Number(process.env.CREATE_PLAYLIST_AMOUNT) || 700,
            addPlaylistSongAmount: Number(process.env.ADD_PLAYLIST_SONG_AMOUNT) || 100,
            removePlaylistSongAmount: Number(process.env.REMOVE_PLAYLIST_SONG_AMOUNT) || 50,
            customPlaylistPlayAmount: Number(process.env.CUSTOM_PLAYLIST_PLAY_AMOUNT) || 250,
            banVoteMinOnlineUsers: voteBanMinOnlineUsers,
            changelog: changelog,
            changelogLatestKey
        });
    } catch (error) {
        res.send(error.message);
    }
});

// API endpoint to get online user count
app.get('/api/online-count', (req, res) => {
    const onlineCount = io.engine.clientsCount;
    res.json({ count: onlineCount });
});

// Debug endpoint to check Formbar connection status
app.get('/debug/formbar', isAuthenticated, (req, res) => {
    const { getCurrentClassroom } = require('./routes/socket');
    const classroom = getCurrentClassroom();

    res.json({
        connected: formbarSocket.connected,
        formbarAddress: FORMBAR_ADDRESS,
        hasApiKey: !!API_KEY,
        apiKeyLength: API_KEY.length,
        hasClassroom: !!classroom,
        classroom: classroom,
        socketId: formbarSocket.id,
        transport: formbarSocket.io ? formbarSocket.io.engine.transport.name : 'unknown'
    });
});

app.get('/leaderboard', isAuthenticated, (req, res) => {
    try {
        res.render('leaderboard.ejs', {
            user: req.session.user,
            userID: req.session.token?.id,
            userPermission: req.session.permission || null,
            ownerIDs: getOwnerIds()
        });
    }
    catch (error) {
        res.send(error.message);
    }
});

app.get('/teacher', isAuthenticated, (req, res) => {
    try {
        const jukepixUtils = require('./utils/jukepix');
        if (req.session.permission >= 4 || isOwner(req.session.token?.id)) {
            res.render('teacher.ejs', {
                user: req.session.user,
                userID: req.session.token?.id,
                jukepixEnabled: jukepixUtils.isJukepixEnabled(),
                jukepixFeatureEnabled: jukepixUtils.isJukepixFeatureEnabled(),
                userPermission: req.session.permission || null,
                ownerIDs: getOwnerIds(),
                spotifyApiConfigured: !!process.env.SPOTIFY_CLIENT_ID
            });
        } else {
            res.redirect('/');
        }
    } catch (error) {
        res.send(error.message);
    }
});

app.use('/', authRoutes);
app.use('/', spotifyRoutes);
app.use('/', paymentRoutes);
app.use('/', leaderboardRoutes);
app.use('/', userRoutes);
app.use('/', require('./routes/jukepix'));
app.use('/', require('./routes/settings'));
app.use('/', require('./routes/customPlaylists'));

server.listen(port, async () => {
    io.disconnectSockets();
    console.log(`Server listening at http://localhost:${port}`);
    if (spotifyBackgroundApiEnabled) {
        runSpotifyDiagnostics().catch((err) => {
            console.warn('[diagnostics] Initial Spotify diagnostics failed:', err?.message || err);
        });
    }
    // Runtime diagnostics: if Spotify starts rate limiting, fail closed to brokey mode.
    setInterval(() => {
        if (!spotifyBackgroundApiEnabled) return;
        runSpotifyDiagnostics().catch((err) => {
            console.warn('[diagnostics] Spotify diagnostics failed:', err?.message || err);
        });
    }, 10000);
});

module.exports = { app, io, formbarSocket };

