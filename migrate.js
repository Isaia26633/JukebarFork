/**
 * Jukebar Database Setup Script
 *
 * Run this script to (re)create the database from scratch:
 *   node migrate.js
 *
 * WARNING: This drops all existing tables and recreates them. All data will be lost.
 */

const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const folderPath = 'db';
if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
}

const db = new sqlite3.Database('db/database.db', (err) => {
    if (err) {
        console.error('Failed to open database:', err.message);
        process.exit(1);
    }
    console.log('Connected to db/database.db');
});

const tables = [
    'custom_playlists',
    'allowed_playlists',
    'track_bans',
    'currently_playing',
    'queue_metadata',
    'banned_songs',
    'transactions',
    'users'
];

db.serialize(() => {
    console.log('Dropping existing tables...');
    for (const table of tables) {
        db.run(`DROP TABLE IF EXISTS ${table}`, (err) => {
            if (err) console.error(`Error dropping ${table}:`, err.message);
            else console.log(`  Dropped: ${table}`);
        });
    }

    console.log('Creating tables...');

    db.run(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_manager INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        recently_queued_cleared_at DATETIME
    )`, logResult('users'));

    db.run(`CREATE TABLE transactions (
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
    )`, logResult('transactions'));

    db.run(`CREATE TABLE banned_songs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_name TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        track_uri TEXT,
        image_url TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_by TEXT NOT NULL DEFAULT 'unknown',
        reason TEXT DEFAULT 'No reason given'
    )`, logResult('banned_songs'));

    db.run(`CREATE TABLE queue_metadata (
        track_uri TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        is_anon INTEGER DEFAULT 0
    )`, logResult('queue_metadata'));

    db.run(`CREATE TABLE currently_playing (
        track_uri TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        is_anon INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
    )`, logResult('currently_playing'));

    db.run(`CREATE TABLE track_bans (
        track_uri TEXT PRIMARY KEY,
        banned_at INTEGER NOT NULL
    )`, logResult('track_bans'));

    db.run(`CREATE TABLE allowed_playlists (
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
    )`, logResult('allowed_playlists'));

    db.run(`CREATE TABLE custom_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        spotify_playlist_id TEXT NOT NULL,
        name TEXT NOT NULL,
        song_count INTEGER DEFAULT 0,
        image_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`, (err) => {
        logResult('custom_playlists')(err);
        db.close((closeErr) => {
            if (closeErr) console.error('Error closing DB:', closeErr.message);
            else console.log('\nMigration complete. Database is ready.');
        });
    });
});

function logResult(name) {
    return (err) => {
        if (err) console.error(`  Error creating ${name}:`, err.message);
        else console.log(`  Created: ${name}`);
    };
}
