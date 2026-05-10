const READ = 'read';
const MODIFY = 'modify';

const CATEGORY_CONFIG = {
    // 30s effective throughput:
    // READ  -> ~49 requests per 30s  (12 + 1.25 * 30)
    // MODIFY-> ~14 requests per 30s  (4 + 0.35 * 30)
    [READ]: { capacity: 12, refillPerSec: 1.25 },
    [MODIFY]: { capacity: 4, refillPerSec: 0.35 }
};

const buckets = {
    [READ]: new Map(),
    [MODIFY]: new Map()
};
const cooldownUntilByCategory = {
    [READ]: 0,
    [MODIFY]: 0
};
const inFlightReads = new Map();
const modifyQueues = new Map();

function nowMs() {
    return Date.now();
}

function getRequesterKey(req) {
    const userId = req.session?.userId;
    if (userId !== null && userId !== undefined) {
        return `user:${userId}`;
    }
    return `ip:${req.ip || 'unknown'}`;
}

function parseRetryAfterMs(retryAfterHeaderValue) {
    const retryAfterSeconds = Number.parseInt(String(retryAfterHeaderValue || ''), 10);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return retryAfterSeconds * 1000;
    }
    return 10000;
}

function setSpotifyPlaybackCooldown(category, retryAfterHeaderValue, source = 'spotify') {
    const waitMs = parseRetryAfterMs(retryAfterHeaderValue);
    cooldownUntilByCategory[category] = nowMs() + waitMs;
    console.warn(`[playback-rate-limit] ${category} cooldown for ${Math.ceil(waitMs / 1000)}s (${source})`);
    return waitMs;
}

function getSpotifyPlaybackCooldownMs(category) {
    return Math.max(0, cooldownUntilByCategory[category] - nowMs());
}

function consumeToken(category, requesterKey) {
    const cfg = CATEGORY_CONFIG[category];
    const categoryBuckets = buckets[category];
    const current = categoryBuckets.get(requesterKey) || { tokens: cfg.capacity, lastRefill: nowMs() };
    const currentNow = nowMs();
    const elapsedSec = Math.max(0, (currentNow - current.lastRefill) / 1000);
    const refill = elapsedSec * cfg.refillPerSec;
    const tokens = Math.min(cfg.capacity, current.tokens + refill);
    const allowed = tokens >= 1;
    const nextState = {
        tokens: allowed ? tokens - 1 : tokens,
        lastRefill: currentNow
    };
    categoryBuckets.set(requesterKey, nextState);
    return {
        allowed,
        remainingTokens: nextState.tokens
    };
}

function getRetryAfterFromError(error) {
    return error?.headers?.['retry-after'] ||
        error?.response?.headers?.['retry-after'] ||
        error?.response?.headers?.get?.('retry-after') ||
        error?.body?.error?.retry_after;
}

function isSpotify429(error) {
    const status = error?.statusCode ?? error?.response?.statusCode ?? error?.body?.error?.status;
    return Number(status) === 429;
}

function build429Response(res, message, retryAfterMs) {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
        ok: false,
        error: message,
        retryAfterSeconds: retryAfterSec
    });
}

function playbackRateLimit(category) {
    return (req, res, next) => {
        const cooldownMs = getSpotifyPlaybackCooldownMs(category);
        if (cooldownMs > 0) {
            return build429Response(
                res,
                `Spotify playback ${category} requests are cooling down. Please retry shortly.`,
                cooldownMs
            );
        }

        const requesterKey = getRequesterKey(req);
        const bucketResult = consumeToken(category, requesterKey);
        if (!bucketResult.allowed) {
            console.warn(`[playback-rate-limit] blocked ${category} for ${requesterKey} route=${req.path}`);
            return build429Response(
                res,
                `Too many playback ${category} requests. Slow down and try again.`,
                1000
            );
        }
        req.spotifyPlaybackLimiter = {
            requesterKey
        };
        return next();
    };
}

async function executePlaybackRead(req, operationKey, run) {
    const requesterKey = req?.spotifyPlaybackLimiter?.requesterKey || getRequesterKey(req || {});
    const dedupeKey = `${requesterKey}:${operationKey}`;
    if (inFlightReads.has(dedupeKey)) {
        return inFlightReads.get(dedupeKey);
    }

    const promise = (async () => {
        try {
            return await run();
        } catch (error) {
            if (isSpotify429(error)) {
                setSpotifyPlaybackCooldown(READ, getRetryAfterFromError(error), operationKey);
            }
            throw error;
        } finally {
            inFlightReads.delete(dedupeKey);
        }
    })();
    inFlightReads.set(dedupeKey, promise);
    return promise;
}

async function executePlaybackModify(req, operationKey, run) {
    const requesterKey = req?.spotifyPlaybackLimiter?.requesterKey || getRequesterKey(req || {});
    const queueKey = `${requesterKey}:${operationKey}`;
    const previous = modifyQueues.get(queueKey) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    modifyQueues.set(queueKey, previous.then(() => gate));

    await previous;
    try {
        return await run();
    } catch (error) {
        if (isSpotify429(error)) {
            setSpotifyPlaybackCooldown(MODIFY, getRetryAfterFromError(error), operationKey);
        }
        throw error;
    } finally {
        release();
        if (modifyQueues.get(queueKey) === gate) {
            modifyQueues.delete(queueKey);
        }
    }
}

module.exports = {
    READ,
    MODIFY,
    playbackRateLimit,
    executePlaybackRead,
    executePlaybackModify,
    setSpotifyPlaybackCooldown,
    getSpotifyPlaybackCooldownMs,
    getRetryAfterFromError,
    isSpotify429
};
