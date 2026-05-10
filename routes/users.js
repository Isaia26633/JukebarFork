const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');

// Get all users
router.get('/api/users', isAuthenticated, async (req, res) => {
    try {
        const db = require('../utils/database');
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT id, display_name as displayName, COALESCE(is_banned, 0) as isBanned, COALESCE(is_manager, 0) as is_manager FROM users ORDER BY display_name COLLATE NOCASE", (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// Get queue history (play transactions only)
router.get('/api/queueHistory', isAuthenticated, async (req, res) => {
    console.log('Queue history endpoint hit - User:', req.session.user);
    try {
        const db = require('../utils/database');
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;

        const plays = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    t.track_name,
                    t.artist_name,
                    t.track_uri,
                    t.image_url,
                    t.display_name as user,
                    t.timestamp,
                    datetime(t.timestamp) as formatted_time
                FROM transactions t
                WHERE t.action = 'play'
                ORDER BY t.timestamp DESC
                LIMIT ? OFFSET ?
            `, [limit, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const enrichedPlays = plays.map(play => ({
            ...play,
            albumImage: play.image_url || ''
        }));

        res.json({ ok: true, plays: enrichedPlays });
    } catch (error) {
        console.error('Error fetching queue history:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch queue history' });
    }
});

// Get banned songs list
router.get('/api/banned-songs', isAuthenticated, async (req, res) => {
    try {
        const db = require('../utils/database');
        const songs = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    b.id,
                    b.track_name,
                    b.artist_name,
                    b.track_uri,
                    b.reason,
                    b.banned_by,
                    b.timestamp,
                    u.display_name AS banned_by_name,
                    COALESCE(
                        NULLIF(b.image_url, ''),
                        (SELECT t.image_url FROM transactions t
                         WHERE t.track_uri = b.track_uri AND t.image_url IS NOT NULL AND t.image_url != ''
                         ORDER BY t.timestamp DESC LIMIT 1)
                    ) AS image_url
                FROM banned_songs b
                LEFT JOIN users u ON u.id = CAST(b.banned_by AS INTEGER)
                ORDER BY datetime(b.timestamp) DESC, b.id DESC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const normalized = songs.map((song) => {
            const rawBannedBy = song.banned_by == null ? '' : String(song.banned_by).trim();
            const hasName = song.banned_by_name && String(song.banned_by_name).trim();
            const bannedByDisplay = hasName
                ? song.banned_by_name
                : (rawBannedBy && rawBannedBy.toLowerCase() !== 'unknown' ? rawBannedBy : 'Unknown');

            return {
                id: song.id,
                track_name: song.track_name,
                artist_name: song.artist_name,
                reason: song.reason || 'No reason given',
                banned_by: song.banned_by,
                banned_by_name: bannedByDisplay,
                timestamp: song.timestamp,
                album_image: song.image_url || ''
            };
        });

        res.json({ ok: true, songs: normalized });
    } catch (error) {
        console.error('Error fetching banned songs:', error);
        res.status(500).json({ ok: false, error: 'Failed to fetch banned songs' });
    }
});

// Ban a user
router.post('/api/users/ban', isAuthenticated, async (req, res) => {
    try {
        const { username } = req.body;
        const db = require('../utils/database');

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const targetUser = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE display_name = ?", [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!targetUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET is_banned = 1 WHERE display_name = ?", [username], function (err) {
                if (err) reject(err);
                else if (this.changes === 0) reject(new Error('User not found'));
                else resolve();
            });
        });

        console.log(`Banning user: ${username}`);

        const io = req.app.get('io');
        if (io) {
            io.emit('userBanned', { userId: targetUser.id, username });
        }

        res.json({ success: true, message: `User ${username} has been banned` });
    } catch (error) {
        console.error('Error banning user:', error);
        res.status(500).json({ error: 'Failed to ban user' });
    }
});

// Unban a user
router.post('/api/users/unban', isAuthenticated, async (req, res) => {
    try {
        const { username } = req.body;
        const db = require('../utils/database');

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        await new Promise((resolve, reject) => {
            db.run("UPDATE users SET is_banned = 0 WHERE display_name = ?", [username], function (err) {
                if (err) reject(err);
                else if (this.changes === 0) reject(new Error('User not found'));
                else resolve();
            });
        });

        console.log(`Unbanning user: ${username}`);

        const io = req.app.get('io');
        if (io) {
            const unbannedUser = await new Promise((resolve, reject) => {
                db.get("SELECT id FROM users WHERE display_name = ?", [username], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            if (unbannedUser) {
                io.emit('userUnbanned', { userId: unbannedUser.id, username });
            }
        }

        res.json({ success: true, message: `User ${username} has been unbanned` });
    } catch (error) {
        console.error('Error unbanning user:', error);
        res.status(500).json({ error: 'Failed to unban user' });
    }
});

// Get list of banned users (for manager panel)
router.get('/api/users/banned', isAuthenticated, async (req, res) => {
    try {
        const db = require('../utils/database');
        const users = await new Promise((resolve, reject) => {
            db.all("SELECT id, display_name as displayName FROM users WHERE is_banned = 1 ORDER BY display_name COLLATE NOCASE", (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
        res.json(users);
    } catch (error) {
        console.error('Error fetching banned users:', error);
        res.status(500).json({ error: 'Failed to fetch banned users' });
    }
});

// Check if the current user is banned (self-check)
router.get('/api/me/banned', isAuthenticated, async (req, res) => {
    try {
        const db = require('../utils/database');
        const userId = req.session.userId;
        if (!userId) return res.json({ banned: false });

        const user = await new Promise((resolve, reject) => {
            db.get("SELECT COALESCE(is_banned, 0) as is_banned FROM users WHERE id = ?", [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        res.json({ banned: !!(user && user.is_banned) });
    } catch (error) {
        console.error('Error checking ban status:', error);
        res.json({ banned: false });
    }
});

// Get user transactions
router.post('/api/users/transactions', isAuthenticated, async (req, res) => {
    try {
        const { username, page = 1, limit = 10 } = req.body;
        const db = require('../utils/database');

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        const user = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE display_name = ?", [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const totalCount = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND action = 'play'", [user.id], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const transactions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    track_name,
                    artist_name,
                    action,
                    cost,
                    image_url,
                    timestamp,
                    datetime(timestamp) as formatted_time
                FROM transactions
                WHERE user_id = ? AND action = 'play'
                ORDER BY timestamp DESC
                LIMIT ? OFFSET ?
            `, [user.id, limitNum, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({
            success: true,
            username: username,
            transactions: transactions,
            pagination: {
                currentPage: pageNum,
                totalPages: totalPages,
                totalCount: totalCount,
                hasNextPage: pageNum < totalPages,
                hasPrevPage: pageNum > 1,
                limit: limitNum
            }
        });
    } catch (error) {
        console.error('Error fetching user transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

// Get transaction modal partial
router.post('/api/users/transactions/modal', isAuthenticated, async (req, res) => {
    try {
        const { username, page = 1, limit = 10 } = req.body;
        const db = require('../utils/database');

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        const user = await new Promise((resolve, reject) => {
            db.get("SELECT id FROM users WHERE display_name = ?", [username], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const totalCount = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND action = 'play'", [user.id], (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const transactions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT
                    track_name,
                    artist_name,
                    action,
                    cost,
                    image_url,
                    timestamp,
                    datetime(timestamp) as formatted_time
                FROM transactions
                WHERE user_id = ? AND action = 'play'
                ORDER BY timestamp DESC
                LIMIT ? OFFSET ?
            `, [user.id, limitNum, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const totalPages = Math.ceil(totalCount / limitNum);
        const pagination = {
            currentPage: pageNum,
            totalPages: totalPages,
            totalCount: totalCount,
            hasNextPage: pageNum < totalPages,
            hasPrevPage: pageNum > 1,
            limit: limitNum
        };

        const html = await new Promise((resolve, reject) => {
            res.app.render('partials/transactions', {
                username: username,
                transactions: transactions,
                pagination: pagination
            }, (err, html) => {
                if (err) reject(err);
                else resolve(html);
            });
        });

        res.json({ success: true, html: html });
    } catch (error) {
        console.error('Error fetching transaction modal:', error);
        res.status(500).json({ error: 'Failed to fetch transaction modal' });
    }
});

module.exports = router;
