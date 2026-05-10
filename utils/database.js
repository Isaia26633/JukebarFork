const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const folderPath = 'db';

if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
}

const db = new sqlite3.Database('db/database.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
    }
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_manager INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        recently_queued_cleared_at DATETIME
    )`);

    db.run(
        'ALTER TABLE users ADD COLUMN recently_queued_cleared_at DATETIME',
        (err) => {
            if (err && !String(err.message).includes('duplicate column')) {
                console.error('[database] ALTER users.recently_queued_cleared_at:', err.message);
            }
        }
    );

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        action TEXT NOT NULL,
        track_uri TEXT,
        track_name TEXT,
        artist_name TEXT,
        image_url TEXT,
        cost INTEGER NOT NULL DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS banned_songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_name TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        track_uri TEXT,
        image_url TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_by TEXT NOT NULL DEFAULT 'unknown',
        reason TEXT DEFAULT 'No reason given'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS queue_metadata (
        track_uri TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        is_anon INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS currently_playing (
        track_uri TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        is_anon INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS track_bans (
        track_uri TEXT PRIMARY KEY,
        banned_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS allowed_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_playlist_id TEXT NOT NULL UNIQUE,
        name TEXT,
        owner_name TEXT,
        image_url TEXT,
        total_tracks INTEGER DEFAULT 0,
        is_allowed INTEGER DEFAULT 0,
        updated_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS custom_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        spotify_playlist_id TEXT NOT NULL,
        name TEXT NOT NULL,
        song_count INTEGER DEFAULT 0,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
});

module.exports = db;
