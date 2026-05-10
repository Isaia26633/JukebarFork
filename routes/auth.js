const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../utils/database');

const SALT_ROUNDS = 12;

router.get('/login', (req, res) => {
    if (req.session.userId) {
        const redirectTo = req.query.redirectURL || '/spotify';
        return res.redirect(redirectTo);
    }
    res.render('login.ejs', { error: null, redirectURL: req.query.redirectURL || '/spotify' });
});

router.post('/register', async (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || req.body.username || '').trim();
    const redirectTo = req.body.redirectURL || '/spotify';

    if (!username || !password || !displayName) {
        return res.render('login.ejs', {
            error: 'Username, display name, and password are required.',
            redirectURL: redirectTo
        });
    }
    if (password.length < 4) {
        return res.render('login.ejs', {
            error: 'Password must be at least 4 characters.',
            redirectURL: redirectTo
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        db.run(
            'INSERT INTO users (username, password_hash, display_name, is_manager) VALUES (?, ?, ?, ?)',
            [username, passwordHash, displayName, 0],
            function (err) {
                if (err) {
                    if (err.message && err.message.includes('UNIQUE constraint failed')) {
                        return res.render('login.ejs', {
                            error: 'Username is already taken. Please choose another.',
                            redirectURL: redirectTo
                        });
                    }
                    console.error('Register DB error:', err.message);
                    return res.render('login.ejs', {
                        error: 'Registration failed. Please try again.',
                        redirectURL: redirectTo
                    });
                }

                req.session.userId = this.lastID;
                req.session.user = displayName;
                res.redirect(redirectTo);
            }
        );
    } catch (err) {
        console.error('Register error:', err.message);
        res.render('login.ejs', { error: 'Registration failed. Please try again.', redirectURL: redirectTo });
    }
});

router.post('/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const redirectTo = req.body.redirectURL || '/spotify';

    if (!username || !password) {
        return res.render('login.ejs', {
            error: 'Username and password are required.',
            redirectURL: redirectTo
        });
    }

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) {
            console.error('Login DB error:', err.message);
            return res.render('login.ejs', { error: 'Login failed. Please try again.', redirectURL: redirectTo });
        }
        if (!user) {
            return res.render('login.ejs', { error: 'Invalid username or password.', redirectURL: redirectTo });
        }

        try {
            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) {
                return res.render('login.ejs', { error: 'Invalid username or password.', redirectURL: redirectTo });
            }

            req.session.userId = user.id;
            req.session.user = user.display_name;
            res.redirect(redirectTo);
        } catch (bcryptErr) {
            console.error('Login bcrypt error:', bcryptErr.message);
            res.render('login.ejs', { error: 'Login failed. Please try again.', redirectURL: redirectTo });
        }
    });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = { router };
