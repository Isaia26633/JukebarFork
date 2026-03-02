const express = require('express');
const router = express.Router();
const { getOwnerIds } = require('../utils/owners');

// Track if reset check interval is running
let resetIntervalStarted = false;

// leaderboard reset function - resets when timer has reached 0 (next Monday)
async function checkAndResetLeaderboard(app) {
    try {
        const now = new Date();
        const lastReset = new Date(app.get('leaderboardLastReset') || 0);

        // Calculate the start of this week (Monday at midnight)
        const startOfThisWeek = new Date(now);
        const currentDay = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        const daysToSubtract = currentDay === 0 ? 6 : currentDay - 1;
        startOfThisWeek.setDate(now.getDate() - daysToSubtract);
        startOfThisWeek.setHours(0, 0, 0, 0);

        // Reset is needed if last reset was before this week's Monday
        const needsReset = lastReset < startOfThisWeek;

        if (needsReset) {
            const resetTime = Date.now();
            app.set('leaderboardLastReset', resetTime);
            console.log('Auto-resetting leaderboard - timer reached 0!');

            const db = require('../utils/database');
            await new Promise((resolve, reject) => {
                db.run("UPDATE users SET songsPlayed = 0", function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });

            console.log('Leaderboard automatically reset for the new week!');
            return true;
        }
        return false;
    } catch (error) {
        console.error('Error resetting leaderboard:', error);
        return false;
    }
}

// Start periodic reset check (runs every minute on the server)
function startResetScheduler(app) {
    if (resetIntervalStarted) return;
    resetIntervalStarted = true;

    // Check immediately on startup
    checkAndResetLeaderboard(app);

    // Then check every minute
    setInterval(() => {
        checkAndResetLeaderboard(app);
    }, 60000); // Check every minute

    console.log('Leaderboard auto-reset scheduler started');
}


router.get('/api/leaderboard/last-reset', (req, res) => {
    const lastReset = req.app.get('leaderboardLastReset') || Date.now();
    res.json({ lastReset });
});

router.get('/api/leaderboard', async (req, res) => {
    try {
        const db = require('../utils/database');
        const ownerIds = getOwnerIds();
        const exclusion = ownerIds.length
            ? `WHERE id NOT IN (${ownerIds.map(() => '?').join(',')})`
            : '';
        const leaderboardData = await new Promise((resolve, reject) => {
            db.all(
                `SELECT displayName, COALESCE(songsPlayed, 0) as songsPlayed, COALESCE(isBanned, 0) as isBanned FROM users ${exclusion} ${exclusion ? 'AND' : 'WHERE'} songsPlayed > 0 ORDER BY songsPlayed DESC`,
                ownerIds,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });

        res.json({ ok: true, leaderboard: leaderboardData });
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

router.get('/api/leaderboard/update', async (req, res) => {
    try {
        const now = new Date();
        const lastReset = new Date(req.app.get('leaderboardLastReset') || 0);

        // Calculate the start of this week (Monday at midnight)
        const startOfThisWeek = new Date(now);
        const currentDay = now.getDay();
        const daysToSubtract = currentDay === 0 ? 6 : currentDay - 1;
        startOfThisWeek.setDate(now.getDate() - daysToSubtract);
        startOfThisWeek.setHours(0, 0, 0, 0);

        // Reset is needed if last reset was before this week's Monday
        const needsReset = lastReset < startOfThisWeek;

        if (needsReset) {
            const resetTime = Date.now();
            req.app.set('leaderboardLastReset', resetTime);
            console.log('Resetting leaderboard via update endpoint...');

            const db = require('../utils/database');
            await new Promise((resolve, reject) => {
                db.run("UPDATE users SET songsPlayed = 0", function (err) {
                    if (err) {
                        return reject(err);
                    }
                    resolve();
                });
            });

            res.json({ ok: true, message: "Leaderboard has been reset for the new week." });
        } else {
            // Calculate next Monday
            const nextMonday = new Date(startOfThisWeek);
            nextMonday.setDate(startOfThisWeek.getDate() + 7);
            res.json({
                ok: false,
                message: "Leaderboard reset not needed at this time.",
                nextReset: nextMonday.toDateString()
            });
        }
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }

});

// Manual reset endpoint (for testing or admin use)
router.post('/api/leaderboard/force-reset', async (req, res) => {
    try {
        const resetTime = Date.now();
        req.app.set('leaderboardLastReset', resetTime);
        //console.log('🔄 Force resetting leaderboard...');

        const db = require('../utils/database');
        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET songsPlayed = 0", function (err) {
                if (err) {
                    return reject(err);
                }
                resolve();
            });
        });

        res.json({ ok: true, message: "Leaderboard has been force reset." });
        //console.log('Leaderboard force reset completed!');
    } catch (error) {
        res.status(500).json({ ok: false, message: error.message });
    }
});

// Auto-check endpoint
router.get('/api/leaderboard/auto-check', async (req, res) => {
    const wasReset = await checkAndResetLeaderboard(req.app);
    if (wasReset) {
        res.json({ ok: true, message: "Leaderboard was reset for the new week." });
    } else {
        res.json({ ok: false, message: "No reset needed at this time." });
    }
});

module.exports = { router, checkAndResetLeaderboard, startResetScheduler };