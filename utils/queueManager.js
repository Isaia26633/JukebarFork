const { isJukepixEnabled } = require('./jukepix');
class QueueManager {
    constructor() {
        this.currentTrack = null;
        this.queue = [];
        this.isPlaying = false;
        this.progress = 0;
        this.lastUpdate = Date.now();
        this.clients = new Set(); // Connected WebSocket clients
        this.lastNetworkError = null; // Track last network error for rate limiting
        this.spotifyRateLimitedUntil = 0;
    }

    getRetryDelayMs(retryAfterHeaderValue) {
        const retryAfterSeconds = Number.parseInt(String(retryAfterHeaderValue || ''), 10);
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
            return retryAfterSeconds * 1000;
        }
        return 30000; // Spotify didn't provide Retry-After, use safe default
    }

    setSpotifyCooldown(retryAfterHeaderValue, source = 'spotify') {
        const delayMs = this.getRetryDelayMs(retryAfterHeaderValue);
        this.spotifyRateLimitedUntil = Date.now() + delayMs;
        console.warn(`[queue-sync] ${source} rate limited (429). Cooling down for ${Math.ceil(delayMs / 1000)}s`);
        try {
            const { setSpotifyPlaybackCooldown, READ } = require('../middleware/spotifyPlaybackRateLimit');
            setSpotifyPlaybackCooldown(READ, retryAfterHeaderValue, `queueManager:${source}`);
        } catch (err) {
            // Avoid hard dependency cycle failures in queue sync path.
        }
    }

    // Update currently playing track
    updateCurrentTrack(track) {
        this.currentTrack = track;
        this.lastUpdate = Date.now();
        this.broadcastUpdate('currentTrack', track);
    }

    // Add track to queue
    addToQueue(track) {
        //console.log('addToQueue called with track:', track);
        this.queue.push(track);
        //console.log('Queue after adding:', this.queue.length, 'tracks');

        // Send queue update - but don't force currentTrack update (let Spotify sync handle that)
        this.broadcastUpdate('queueUpdate', {
            queue: this.queue,
            currentTrack: this.currentTrack, // Keep existing current track
            isPlaying: this.isPlaying,
            progress: this.progress,
            lastUpdate: this.lastUpdate
        });

        // Also send notification data
        this.broadcastUpdate('queueAdd', { track, queue: this.queue });
    }

    // Remove track from queue
    removeFromQueue(index) {
        const removed = this.queue.splice(index, 1)[0];
        this.broadcastUpdate('queueRemove', { removed, queue: this.queue });
        return removed;
    }

    // Remove all tracks matching a specific URI from queue
    removeByUri(trackUri) {
        const originalLength = this.queue.length;
        this.queue = this.queue.filter(track => track.uri !== trackUri);
        const removedCount = originalLength - this.queue.length;
        
        if (removedCount > 0) {
            console.log(`Removed ${removedCount} track(s) with URI ${trackUri} from queue`);
            // Clean up ALL metadata for this URI so stale shields/names don't bleed into future queues
            this.removeAllTrackMetadata(trackUri);
            this.broadcastUpdate('queueUpdate', this.getCurrentState());
        }
        
        return removedCount;
    }

    // Remove tracks by name and artist (for ban matching)
    removeByNameAndArtist(trackName, artistName) {
        const originalLength = this.queue.length;
        const normalizedTrackName = trackName.toLowerCase().trim();
        const normalizedArtistName = artistName.toLowerCase().trim();

        const removedUris = new Set();
        this.queue = this.queue.filter(track => {
            const queueTrackName = (track.name || '').toLowerCase().trim();
            const queueArtistName = (track.artist || '').toLowerCase().trim();
            const matches = queueTrackName === normalizedTrackName && queueArtistName === normalizedArtistName;
            if (matches && track.uri) removedUris.add(track.uri);
            return !matches;
        });
        
        const removedCount = originalLength - this.queue.length;
        
        if (removedCount > 0) {
            console.log(`Removed ${removedCount} track(s) matching "${trackName}" by "${artistName}" from queue`);
            // Clean up ALL metadata for each removed URI so stale shields/names don't bleed into future queues
            for (const uri of removedUris) {
                this.removeAllTrackMetadata(uri);
            }
            this.broadcastUpdate('queueUpdate', this.getCurrentState());
        }
        
        return removedCount;
    }

    // Check if currently playing track matches name and artist
    isCurrentlyPlaying(trackName, artistName) {
        if (!this.currentTrack) return false;
        const normalizedTrackName = trackName.toLowerCase().trim();
        const normalizedArtistName = artistName.toLowerCase().trim();
        const currentName = (this.currentTrack.name || '').toLowerCase().trim();
        const currentArtist = (this.currentTrack.artist || '').toLowerCase().trim();
        return currentName === normalizedTrackName && currentArtist === normalizedArtistName;
    }

    // Check if currently playing track matches a specific URI
    isCurrentTrackUri(trackUri) {
        if (!this.currentTrack || !trackUri) return false;
        return String(this.currentTrack.uri || '').trim() === String(trackUri).trim();
    }

    // Skip to next track
    async skipTrack(actor = null) {
        if (this.queue.length > 0) {
            const skippedTrack = this.currentTrack;
            const nextTrack = this.queue.shift();
            this.currentTrack = nextTrack; // Update current track when skipping
            this.lastUpdate = Date.now();

            // Clean up metadata for the skipped track ONLY if not still in queue
            if (skippedTrack && skippedTrack.uri) {
                const stillInQueue = this.queue.some(t => t.uri === skippedTrack.uri);
                
                if (!stillInQueue) {
                    await this.removeTrackMetadata(skippedTrack.uri);
                    console.log('Cleaned up metadata for skipped track:', skippedTrack.uri);
                } else {
                    console.log('Skipped track still in queue, keeping metadata');
                }
            }
            
            // Update previous track URI for sync detection
            this.previousTrackUri = nextTrack?.uri || null;

            // Send queue update with updated current track
            this.broadcastUpdate('queueUpdate', this.getCurrentState());
            // Send skip for notifications
            const skipEvent = {
                currentTrack: this.currentTrack,
                skippedTrack,
                queue: this.queue,
                skippedBy: actor || 'Someone',
                skippedAt: Date.now(),
                skippedType: 'song'
            };

            this.broadcastUpdate('skip', skipEvent);
            return nextTrack;
        }
        return null;
    }

    // Update playback state  
    updatePlaybackState(isPlaying, progress = null) {
        this.isPlaying = isPlaying;
        if (progress !== null) this.progress = progress;
        this.lastUpdate = Date.now();

        // Add progress to currentTrack for display
        const currentTrackWithProgress = this.currentTrack ? {
            ...this.currentTrack,
            progress: this.progress
        } : null;

        this.broadcastUpdate('playbackState', {
            isPlaying: this.isPlaying,
            progress: this.progress,
            currentTrack: currentTrackWithProgress
        });
        // Also broadcast queue update when playback state changes
        this.broadcastUpdate('queueUpdate', { queue: this.queue });
    }

    // Get current state
    getCurrentState() {
        return {
            currentTrack: this.currentTrack,
            queue: this.queue,
            isPlaying: this.isPlaying,
            progress: this.progress,
            lastUpdate: this.lastUpdate
        };
    }

    // Broadcast updates to all connected clients
    broadcastUpdate(type, data) {
        //console.log(`Broadcasting ${type} event to ${this.clients.size} clients with data:`, data);

        let successCount = 0;
        let failCount = 0;

        this.clients.forEach(client => {
            try {
                // Handle Socket.IO clients
                if (client.emit && typeof client.emit === 'function') {
                    client.emit(type, data);
                    successCount++;
                }
                // Handle raw WebSocket clients (fallback)
                else if (client.readyState === 1) {
                    const message = JSON.stringify({ type, data, timestamp: Date.now() });
                    client.send(message);
                    successCount++;
                }
            } catch (error) {
                console.error(`Failed to send ${type} to client:`, error.message);
                failCount++;
            }
        });

        //console.log(`Broadcast complete: ${successCount} sent, ${failCount} failed`);
    }

    // Add WebSocket client
    addClient(ws) {
        this.clients.add(ws);
        // Send current state to new client
        if (ws.emit && typeof ws.emit === 'function') {
            // Socket.IO client
            ws.emit('queueUpdate', {
                type: 'initialState',
                data: this.getCurrentState(),
                timestamp: Date.now()
            });
        } else if (ws.readyState === 1) {
            // Raw WebSocket client
            ws.send(JSON.stringify({
                type: 'initialState',
                data: this.getCurrentState(),
                timestamp: Date.now()
            }));
        }
    }

    // Remove WebSocket client
    removeClient(ws) {
        this.clients.delete(ws);
    }

    // Initialize queue from Spotify on startup
    async initializeFromSpotify(spotifyApi) {
        console.log('initializeFromSpotify() called');
        try {
            console.log('Fetching current Spotify queue...');

            // Ensure we have a valid access token
            const { ensureSpotifyAccessToken } = require('./spotify');
            await ensureSpotifyAccessToken();

            // Get current playback to set the current track
            const currentPlayback = await spotifyApi.getMyCurrentPlayingTrack();
            if (currentPlayback.body && currentPlayback.body.item) {
                const currentUri = currentPlayback.body.item.uri;

                // Fetch metadata for current track (get oldest entry for duplicates)
                const db = require('./database');
                const currentMetadata = await new Promise((resolve, reject) => {
                    db.get(
                        'SELECT * FROM queue_metadata WHERE track_uri = ? ORDER BY added_at ASC LIMIT 1',
                        [currentUri],
                        (err, row) => {
                            if (err) reject(err);
                            else resolve(row);
                        }
                    );
                });

                this.currentTrack = {
                    name: currentPlayback.body.item.name,
                    artist: currentPlayback.body.item.artists.map(a => a.name).join(', '),
                    uri: currentPlayback.body.item.uri,
                    duration: currentPlayback.body.item.duration_ms,
                    image: currentPlayback.body.item.album.images[0]?.url,
                    addedBy: currentMetadata ? (currentMetadata.is_anon ? 'Anonymous' : currentMetadata.added_by) : 'Spotify',
                    displayName: currentMetadata ? (currentMetadata.is_anon ? 'Anonymous' : currentMetadata.display_name) : 'Spotify',
                    addedAt: currentMetadata ? currentMetadata.added_at : Date.now(),
                    isAnon: currentMetadata ? currentMetadata.is_anon : 0,
                    skipShields: currentMetadata ? currentMetadata.skip_shields : 0
                };
                this.isPlaying = currentPlayback.body.is_playing;
                this.progress = currentPlayback.body.progress_ms;
                //console.log('Current track set:', this.currentTrack.name);
            }

            // Try to get the user's queue using REST API (library methods don't work)
            try {
                console.log('Fetching queue via REST API...');
                const queueResponse = await fetch('https://api.spotify.com/v1/me/player/queue', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                });

                console.log('Queue API response status:', queueResponse.status);

                if (queueResponse.status === 200) {
                    const queueData = await queueResponse.json();
                    console.log('Queue data received, has queue?', !!queueData.queue);
                    console.log('Queue length:', queueData.queue?.length);

                    if (queueData.queue && Array.isArray(queueData.queue)) {
                        console.log('Found', queueData.queue.length, 'tracks in Spotify queue');

                        // 📖 Fetch metadata for all tracks from database
                        const trackUris = queueData.queue.map(item => item.uri);
                        const metadataMap = await this.getQueueMetadata(trackUris);
                        console.log('Metadata found for', Object.keys(metadataMap).length, 'tracks');

                        // 🆕 Create default metadata for tracks that don't have it
                        const db = require('./database');
                        
                        // Count how many times each URI appears in the queue
                        const uriCounts = {};
                        for (const item of queueData.queue) {
                            uriCounts[item.uri] = (uriCounts[item.uri] || 0) + 1;
                        }
                        
                        for (const item of queueData.queue) {
                            const metadataArray = metadataMap[item.uri] || [];
                            const queueCount = uriCounts[item.uri];
                            
                            // If we have fewer metadata entries than queue entries for this URI, create default ones
                            if (metadataArray.length < queueCount) {
                                const missingCount = queueCount - metadataArray.length;
                                console.log(`Creating ${missingCount} default metadata entries for: ${item.name} (URI: ${item.uri})`);
                                
                                for (let i = 0; i < missingCount; i++) {
                                    await new Promise((resolve, reject) => {
                                        const addedAt = Date.now() + i; // Ensure unique timestamps
                                        db.run(
                                            `INSERT INTO queue_metadata (track_uri, added_by, added_at, display_name, is_anon, skip_shields) 
                                             VALUES (?, ?, ?, ?, ?, ?)`,
                                            [item.uri, 'Spotify', addedAt, 'Spotify', 0, 0],
                                            function (err) {
                                                if (err) {
                                                    console.error('Failed to create default metadata:', err);
                                                    reject(err);
                                                } else {
                                                    console.log(`Created default metadata (changes: ${this.changes}, lastID: ${this.lastID})`);
                                                    // Add to metadataMap array
                                                    if (!metadataMap[item.uri]) {
                                                        metadataMap[item.uri] = [];
                                                    }
                                                    metadataMap[item.uri].push({
                                                        added_by: 'Spotify',
                                                        display_name: 'Spotify',
                                                        added_at: addedAt,
                                                        is_anon: 0,
                                                        skip_shields: 0
                                                    });
                                                    resolve();
                                                }
                                            }
                                        );
                                    });
                                }
                                // Only create metadata once per URI
                                uriCounts[item.uri] = metadataArray.length + missingCount;
                            }
                        }

                        // Track which metadata entries we've used
                        const usedMetadataKeys = new Set();

                        // Convert Spotify queue items to our format, merging with metadata
                        // Use added_at from metadata for proper ordering of duplicate tracks
                        this.queue = queueData.queue.map(item => {
                            const metadataArray = metadataMap[item.uri] || [];
                            let metadata = null;
                            
                            // Find the first unused metadata entry for this track
                            for (const entry of metadataArray) {
                                const key = `${item.uri}_${entry.added_at}`;
                                if (!usedMetadataKeys.has(key)) {
                                    metadata = entry;
                                    usedMetadataKeys.add(key);
                                    break;
                                }
                            }
                            
                            // Fallback to first entry if all are used
                            if (!metadata && metadataArray.length > 0) {
                                metadata = metadataArray[0];
                            }

                            return {
                                name: item.name,
                                artist: item.artists.map(a => a.name).join(', '),
                                uri: item.uri,
                                duration: item.duration_ms,
                                image: item.album.images[0]?.url,
                                addedBy: metadata ? (metadata.is_anon ? 'Anonymous' : metadata.added_by) : 'Spotify',
                                displayName: metadata ? (metadata.is_anon ? 'Anonymous' : metadata.display_name) : 'Spotify',
                                addedAt: metadata ? metadata.added_at : Date.now(),
                                isAnon: metadata ? metadata.is_anon : 0,
                                skipShields: metadata ? metadata.skip_shields : 0
                            };
                        });

                        // Sort the queue by addedAt so earliest additions appear first
                        this.queue.sort((a, b) => a.addedAt - b.addedAt);

                        console.log('Initialized queue with', this.queue.length, 'tracks');
                    } else {
                        console.log('No queue array found in response');
                        this.queue = [];
                    }
                } else {
                    console.log('Queue API returned status:', queueResponse.status);
                    this.queue = [];
                }
            } catch (queueError) {
                console.log('Could not fetch Spotify queue:', queueError.message);
                console.log('Starting with empty queue - tracks will be added as they are queued');
                this.queue = [];
            }

            this.lastUpdate = Date.now();

        } catch (error) {
            console.error('Failed to initialize queue from Spotify:', error);
            // Don't throw - just continue with empty queue
            this.queue = [];
        }
    }

    // Track the previous track URI to detect track changes
    previousTrackUri = null;

    // Periodic Spotify sync (interval configured in app.js)
    async syncWithSpotify(spotifyApi) {
        try {
            if (Date.now() < this.spotifyRateLimitedUntil) {
                return {
                    currentTrack: this.currentTrack,
                    queue: this.queue
                };
            }

            // Fetch BOTH currently playing AND queue at the same time
            const [currentlyPlayingResponse, queueResponse] = await Promise.all([
                fetch('https://api.spotify.com/v1/me/player/currently-playing', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                }),
                fetch('https://api.spotify.com/v1/me/player/queue', {
                    headers: { 'Authorization': `Bearer ${spotifyApi.getAccessToken()}` }
                })
            ]);

            if (currentlyPlayingResponse.status === 429 || queueResponse.status === 429) {
                const retryAfterHeader =
                    currentlyPlayingResponse.headers.get('retry-after') ||
                    queueResponse.headers.get('retry-after');
                this.setSpotifyCooldown(retryAfterHeader, 'player endpoints');
                return {
                    currentTrack: this.currentTrack,
                    queue: this.queue
                };
            }

            // Process currently playing
            let currentTrack = null;
            if (currentlyPlayingResponse.status === 200) {
                const currentData = await currentlyPlayingResponse.json();
                if (currentData && currentData.item) {
                    currentTrack = {
                        id: currentData.item.id,
                        name: currentData.item.name,
                        artist: currentData.item.artists.map(a => a.name).join(', '),
                        uri: currentData.item.uri,
                        image: currentData.item.album.images?.[0]?.url || null,
                        album: {
                            name: currentData.item.album.name
                        },
                        duration_ms: currentData.item.duration_ms,
                        progress_ms: currentData.progress_ms
                    };
                    // Note: displayTrack is now called from jukepix.js when a new track is detected
                    // This prevents duplicate requests for the same track
                }
            }

            // Process queue first (needed for track change detection)
            let queueTracks = [];
            if (queueResponse.status === 200) {
                const queueData = await queueResponse.json();
                queueTracks = queueData.queue || [];
            }

            // Detect track change - clean up metadata for PREVIOUS track ONLY if it's finished (not in queue and not currently playing)
            if (currentTrack && currentTrack.uri) {
                if (this.previousTrackUri && this.previousTrackUri !== currentTrack.uri) {
                    console.log('Track changed from', this.previousTrackUri, 'to', currentTrack.uri);
                    
                    // Check if previous track is still in the queue (duplicate) OR is the current track
                    const stillInQueue = queueTracks.some(t => t.uri === this.previousTrackUri);
                    const isCurrent = currentTrack.uri === this.previousTrackUri;
                    
                    if (!stillInQueue && !isCurrent) {
                        // Only remove metadata if track has completely finished (not in queue and not playing)
                        await this.removeTrackMetadata(this.previousTrackUri);
                        console.log('Removed metadata for finished track:', this.previousTrackUri);
                    } else {
                        console.log('Previous track still active (in queue or playing), keeping metadata');
                    }
                }
                this.previousTrackUri = currentTrack.uri;
            }

            // Get metadata for all tracks (including currently playing)
            const allUris = [
                ...(currentTrack ? [currentTrack.uri] : []),
                ...queueTracks.map(t => t.uri)
            ];

            const metadataMap = await this.getQueueMetadata(allUris);

            // Track which metadata entries we've already used
            const usedMetadata = new Set();

            // Add metadata to currently playing (use FIRST/oldest entry)
            if (currentTrack) {
                const metadataArray = metadataMap[currentTrack.uri];
                if (metadataArray && metadataArray.length > 0) {
                    // Use the first (oldest) metadata entry for currently playing
                    const metadata = metadataArray[0];
                    currentTrack.addedBy = metadata.added_by;
                    currentTrack.displayName = metadata.display_name;
                    currentTrack.isAnon = metadata.is_anon;
                    currentTrack.skipShields = metadata.skip_shields;
                    currentTrack.addedAt = metadata.added_at;
                    
                    // Mark this metadata as used so queue items don't use it
                    const metadataKey = `${currentTrack.uri}_${metadata.added_at}`;
                    usedMetadata.add(metadataKey);
                }
                // Add frontend-compatible property names
                currentTrack.progress = currentTrack.progress_ms;
                currentTrack.duration = currentTrack.duration_ms;
            }

            // Build queue with metadata, matching by position for duplicates.
            // Preserve existing addedAt values for tracks already in our queue
            // so they don't get reset to Date.now() on every sync cycle.
            const newQueue = queueTracks.map((track, index) => {
                const metadataArray = metadataMap[track.uri];
                let metadata = null;

                if (metadataArray && metadataArray.length > 0) {
                    // Find the first unused metadata entry for this URI (ordered by added_at)
                    for (let i = 0; i < metadataArray.length; i++) {
                        const metadataKey = `${track.uri}_${metadataArray[i].added_at}`;
                        
                        if (!usedMetadata.has(metadataKey)) {
                            metadata = metadataArray[i];
                            usedMetadata.add(metadataKey);
                            break;
                        }
                    }
                    // Fallback to first entry if all are used (shouldn't happen)
                    if (!metadata) {
                        metadata = metadataArray[0];
                    }
                }

                // Use metadata added_at; fall back to existing queue item's addedAt;
                // last resort: Date.now() (only for truly new tracks with no metadata)
                const existingItem = this.queue[index];
                const fallbackAddedAt = (existingItem && existingItem.uri === track.uri)
                    ? existingItem.addedAt
                    : Date.now();

                return {
                    uri: track.uri,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    addedBy: metadata?.is_anon ? 'Anonymous' : (metadata?.added_by || 'Spotify'),
                    displayName: metadata?.is_anon ? 'Anonymous' : (metadata?.display_name || 'Spotify'),
                    addedAt: metadata?.added_at || fallbackAddedAt,
                    image: track.album?.images?.[0]?.url,
                    isAnon: metadata?.is_anon || 0,
                    skipShields: metadata?.skip_shields || 0
                };
            });

            // Update internal state
            this.queue = newQueue;
            this.currentTrack = currentTrack;
            
            // Update progress from currentTrack if available
            if (currentTrack && currentTrack.progress_ms !== undefined) {
                this.progress = currentTrack.progress_ms;
            }

            // Broadcast BOTH at the same time using existing broadcast methods
            this.broadcastUpdate('queueUpdate', {
                queue: newQueue,
                currentTrack: currentTrack,
                isPlaying: this.isPlaying,
                progress: this.progress,
                lastUpdate: Date.now()
            });

            this.broadcastUpdate('currentTrack', currentTrack);

            return { currentTrack, queue: newQueue };
        } catch (error) {
            const retryAfterHeader =
                error?.headers?.['retry-after'] ||
                error?.response?.headers?.['retry-after'] ||
                error?.response?.headers?.get?.('retry-after');
            const statusCode = error?.statusCode ?? error?.response?.statusCode;
            if (statusCode === 429) {
                this.setSpotifyCooldown(retryAfterHeader, 'syncWithSpotify');
            }
            console.error('Error syncing with Spotify:', error.message || error);
            
            // Don't crash the server - return current state
            return { 
                currentTrack: this.currentTrack, 
                queue: this.queue 
            };
        }
    }

    // In getQueueMetadata, change to return ALL instances, not just first:
    async getQueueMetadata(trackUris) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            if (trackUris.length === 0) {
                resolve({});
                return;
            }

            const placeholders = trackUris.map(() => '?').join(',');
            const query = `SELECT track_uri, added_by, display_name, added_at, is_anon, skip_shields FROM queue_metadata WHERE track_uri IN (${placeholders}) ORDER BY added_at ASC`;

            db.all(query, trackUris, (err, rows) => {
                if (err) {
                    console.error('Failed to fetch queue metadata:', err);
                    resolve({});
                } else {
                    // BUILD A MAP with ARRAYS to handle duplicates
                    const metadataMap = {};

                    if (rows && rows.length > 0) {
                        for (const row of rows) {
                            // Store as array to handle multiple instances of same track
                            if (!metadataMap[row.track_uri]) {
                                metadataMap[row.track_uri] = [];
                            }
                            metadataMap[row.track_uri].push({
                                added_by: row.added_by,
                                display_name: row.display_name,
                                added_at: row.added_at,
                                is_anon: row.is_anon,
                                skip_shields: row.skip_shields
                            });
                        }
                    }

                    resolve(metadataMap);
                }
            });
        });
    }

    // Remove metadata for a track when it's played/skipped
    // Only removes the OLDEST entry if there are duplicates
    async removeTrackMetadata(trackUri) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            db.run(
                `DELETE FROM queue_metadata 
                 WHERE track_uri = ? 
                 AND added_at = (
                     SELECT MIN(added_at) 
                     FROM queue_metadata 
                     WHERE track_uri = ?
                 )`,
                [trackUri, trackUri],
                (err) => {
                    if (err) {
                        console.error('Failed to remove track metadata:', err);
                        reject(err);
                    } else {
                        //console.log('Removed metadata for track:', trackUri);
                        resolve();
                    }
                }
            );
        });
    }

    // Remove ALL metadata for a track URI (used when a track is force-removed from the queue,
    // e.g. via ban or admin removal, so stale shields/names don't persist for future queues)
    async removeAllTrackMetadata(trackUri) {
        const db = require('./database');

        return new Promise((resolve) => {
            db.run(
                'DELETE FROM queue_metadata WHERE track_uri = ?',
                [trackUri],
                (err) => {
                    if (err) {
                        console.error('Failed to remove all track metadata for', trackUri, ':', err);
                    } else {
                        console.log('Removed all metadata for force-removed track:', trackUri);
                    }
                    resolve();
                }
            );
        });
    }

    // 🧹 Cleanup: Remove metadata for tracks no longer in Spotify queue
    async cleanupStaleMetadata(currentQueueUris) {
        const db = require('./database');

        return new Promise((resolve, reject) => {
            // Get all track URIs currently in metadata table
            db.all('SELECT track_uri FROM queue_metadata', [], (err, rows) => {
                if (err) {
                    console.error('Failed to query metadata for cleanup:', err);
                    reject(err);
                    return;
                }

                if (!rows || rows.length === 0) {
                    // No metadata to clean up
                    resolve();
                    return;
                }

                const metadataUris = rows.map(row => row.track_uri);
                const staleUris = metadataUris.filter(uri => !currentQueueUris.includes(uri));

                if (staleUris.length === 0) {
                    // No stale metadata
                    resolve();
                    return;
                }

                // Delete stale metadata
                const placeholders = staleUris.map(() => '?').join(',');
                db.run(
                    `DELETE FROM queue_metadata WHERE track_uri IN (${placeholders})`,
                    staleUris,
                    function (err) {
                        if (err) {
                            console.error('Failed to delete stale metadata:', err);
                            reject(err);
                        } else {
                            console.log(`Cleaned up ${this.changes} stale track(s) from metadata`);
                            resolve();
                        }
                    }
                );
            });
        });
    }
}

// Global queue manager instance
const queueManager = new QueueManager();

module.exports = queueManager;