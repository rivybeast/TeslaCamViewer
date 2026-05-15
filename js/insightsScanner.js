/**
 * InsightsScanner — library-wide background pass that pre-populates the
 * event-insights IDB cache.
 *
 * Reads SEI directly from clip file handles (NO video load) for every
 * eligible event across all drives, computes severity, and persists to
 * `eventInsightsCache`. Net effect: after one full scan, every event's
 * severity pill appears on its sidebar card the instant the app opens,
 * without any per-event wait.
 *
 * Execution model:
 *   • One event at a time. SEI parsing is I/O + CPU-heavy; parallelism
 *     fights the live player for file handles and the decoder.
 *   • Scheduled via BackgroundScheduler.scheduleWhenIdle so it never
 *     steals main-thread time while the user is doing something.
 *   • Auto-pauses when: (a) user is actively playing video, (b) AI Search
 *     is indexing. Resumes automatically when both are clear.
 *   • State persisted to localStorage so a reload mid-scan picks up where
 *     it left off instead of re-scanning from zero.
 *
 * Public surface:
 *   start(events)   — begin scan over the given event list
 *   pause()         — user-requested pause
 *   resume()        — user-requested resume
 *   cancel()        — abort entirely (partial cache kept)
 *   getState()      — snapshot for UI
 *
 * Events (dispatched on window):
 *   insights-scan:progress  — { done, total, currentName, etaMs, paused, final }
 *   insights-scan:status    — { state, message }
 */
(function () {
    'use strict';

    const STATE_STORAGE_KEY = 'teslacamviewer_insights_scan_state';
    const PAUSE_POLL_MS = 2500;      // how often to re-check pause conditions
    const INTER_EVENT_IDLE_MS = 300; // small breather between events

    // ---- utility: dispatch a window CustomEvent with detail ----
    function emit(type, detail) {
        try {
            window.dispatchEvent(new CustomEvent('insights-scan:' + type, { detail }));
        } catch { /* no-op */ }
    }

    class InsightsScanner {
        constructor() {
            this.state = 'idle';    // idle | scanning | paused | completed | cancelled
            this.queue = [];        // remaining eventKeys to scan
            this.allEvents = [];    // reference to the events array (for resolving keys)
            this.total = 0;
            this.done = 0;
            this.failures = [];     // [{eventKey, error}]
            this.currentEventName = '';
            this.startTime = 0;
            this._schedulerHandle = null;
            this._pausePoll = null;
            this._userPaused = false;  // user clicked pause (vs auto-pause)
        }

        // ============ Public API ============

        /**
         * Kick off a scan. Filters the input to eligible events (has clips,
         * not already cached with current schema). Resumes from saved state
         * if folder matches.
         * @param {Array} events — usually window.app.allEvents
         */
        async start(events) {
            if (this.state === 'scanning' || this.state === 'paused') {
                console.warn('[InsightsScanner] already running');
                return;
            }
            if (!window.eventInsightsCache || !window.interventionSeverity || !window.seiExtractor || !window.seiInsights) {
                console.warn('[InsightsScanner] missing dependencies');
                emit('status', { state: 'error', message: 'Scanner dependencies not loaded' });
                return;
            }

            this.allEvents = events || [];
            const eligible = await this._filterEligible(this.allEvents);

            if (eligible.length === 0) {
                emit('status', { state: 'completed', message: 'All events already scanned.' });
                return;
            }

            this.queue = eligible.map(e => e.compoundKey || e.name);
            this.total = this.queue.length;
            this.done = 0;
            this.failures = [];
            this.startTime = Date.now();
            this.state = 'scanning';
            this._userPaused = false;
            this._saveState();

            emit('status', { state: 'scanning', message: `Starting scan of ${this.total} events…` });
            this._schedulePump(0);
            this._startPausePoll();
        }

        pause() {
            if (this.state !== 'scanning') return;
            this._userPaused = true;
            this.state = 'paused';
            this._cancelPending();
            this._saveState();
            emit('status', { state: 'paused', message: 'Scan paused' });
            emit('progress', this._progressDetail());
        }

        resume() {
            if (this.state !== 'paused') return;
            this._userPaused = false;
            this.state = 'scanning';
            this._saveState();
            emit('status', { state: 'scanning', message: 'Scan resumed' });
            this._schedulePump(0);
        }

        cancel() {
            if (this.state === 'idle' || this.state === 'completed') return;
            this._cancelPending();
            this._stopPausePoll();
            this.state = 'cancelled';
            this.queue = [];
            this._clearSavedState();
            emit('status', { state: 'cancelled', message: 'Scan cancelled' });
            emit('progress', this._progressDetail({ final: true }));
        }

        getState() {
            return {
                state: this.state,
                total: this.total,
                done: this.done,
                currentEventName: this.currentEventName,
                failures: this.failures.length,
                etaMs: this._eta()
            };
        }

        // ============ Core scan loop ============

        _schedulePump(delay = INTER_EVENT_IDLE_MS) {
            this._cancelPending();
            if (this.state !== 'scanning') return;
            if (this.queue.length === 0) {
                this._finish();
                return;
            }
            // Wrap in idle scheduler so we never compete with live playback.
            this._schedulerHandle = window.backgroundScheduler?.scheduleWhenIdle(
                () => this._pumpOne(),
                { timeoutMs: Math.max(3000, delay * 10), label: 'insightsScanner' }
            ) || { type: 'timeout', token: setTimeout(() => this._pumpOne(), delay) };
        }

        async _pumpOne() {
            this._schedulerHandle = null;
            if (this.state !== 'scanning') return;

            // Pause conditions — user playing video or AI Search running.
            if (this._shouldAutoPause()) {
                this.state = 'paused';
                emit('status', { state: 'paused', message: this._autoPauseReason() });
                emit('progress', this._progressDetail());
                // Pause poll will resume us when conditions clear.
                return;
            }

            const key = this.queue[0];
            const event = this._findEvent(key);
            if (!event) {
                // Event disappeared (drive removed, filter changed). Skip it.
                this.queue.shift();
                this._saveState();
                this._schedulePump();
                return;
            }

            this.currentEventName = event.name;
            emit('progress', this._progressDetail());

            try {
                await this._processEvent(event);
            } catch (e) {
                console.warn('[InsightsScanner] event failed:', event.name, e);
                this.failures.push({ eventKey: key, error: String(e) });
            }

            this.queue.shift();
            this.done++;
            this._saveState();
            emit('progress', this._progressDetail());

            this._schedulePump();
        }

        /**
         * Extract SEI, compute severity, persist. Does NOT touch the shared
         * telemetryOverlay — the live player uses that for the current event,
         * we work from raw file handles to avoid any cross-contamination.
         */
        async _processEvent(event) {
            if (!event.clipGroups || event.clipGroups.length === 0) return;
            const clipSeiMap = new Map();

            for (let i = 0; i < event.clipGroups.length; i++) {
                if (this.state !== 'scanning') return;  // cancelled / paused mid-event
                const group = event.clipGroups[i];
                const front = group?.clips?.front;
                if (!front?.fileHandle) continue;
                try {
                    const file = await front.fileHandle.getFile();
                    const data = await window.seiExtractor.extractFromFile(file);
                    if (data?.frames?.length) {
                        clipSeiMap.set(`${i}_${file.name}`, data);
                    }
                } catch (e) {
                    // Individual clip failures don't fail the whole event —
                    // we still compute from whatever we got.
                }
            }

            // Events without any SEI data (older firmware, or RecentClips
            // where extraction failed) used to bail here without caching,
            // which made the scanner re-walk them on every subsequent run
            // — the "all 39 scanned, only 6 cached, repeat next time"
            // bug. Cache an empty result so _filterEligible sees them
            // as processed and skips them on future scans. Empty values
            // produce no badges / no chips downstream, matching the
            // previous behavior of "no entry".
            if (clipSeiMap.size === 0) {
                const eventKey = event.compoundKey || event.name;
                const ts = event.timestamp ? new Date(event.timestamp).getTime() : null;
                await window.eventInsightsCache.putPartial(eventKey, {
                    severity: null,
                    recordingHealth: { shortClipCount: 0, totalClips: 0, details: [] },
                    launches: [],
                    eventTimestamp: ts
                });
                event._recordingHealth = { shortClipCount: 0, totalClips: 0, details: [] };
                event._launches = [];
                return;
            }

            // Durations: we don't have cachedClipDurations (those come from
            // the player). Pass undefined — computeFromSei falls back to
            // 60s per clip. Timestamps in the cached record will be coarse
            // (±1 min); when the user opens the event, the live compute
            // refines them. Tier classification doesn't depend on timing.
            const severity = window.interventionSeverity.computeFromSei(clipSeiMap);
            // Recording health (SEI portion) and launches share the same
            // clipSeiMap walk we just did — compute alongside severity so
            // one background pass populates all three metrics.
            const recordingHealth = window.seiInsights.computeRecordingHealthFromSei(clipSeiMap);
            const launches = window.seiInsights.computeLaunches(clipSeiMap, null);

            const eventKey = event.compoundKey || event.name;
            const ts = event.timestamp ? new Date(event.timestamp).getTime() : null;
            await window.eventInsightsCache.putPartial(eventKey, {
                severity: severity || null,
                recordingHealth,
                launches,
                eventTimestamp: ts
            });

            // Refresh the sidebar badge live so the user can watch results
            // appear in real time without waiting for a full page reload.
            if (severity) {
                event._severityScore = severity;
                event._severityFromCache = true;
            }
            event._recordingHealth = recordingHealth;
            event._recordingHealthFromCache = true;
            event._launches = launches;
            event._launchesFromCache = true;
            window.app?.eventBrowser?.refreshEventBadges?.(event.name);
        }

        _finish() {
            this._stopPausePoll();
            this.state = 'completed';
            this._clearSavedState();
            const msg = this.failures.length > 0
                ? `Scan complete · ${this.done} scanned · ${this.failures.length} failed`
                : `Scan complete · ${this.done} events`;
            emit('status', { state: 'completed', message: msg });
            emit('progress', this._progressDetail({ final: true }));
        }

        // ============ Pause handling ============

        _shouldAutoPause() {
            if (this._userPaused) return true;
            // Actively watching something
            if (window.app?.videoPlayer?.isPlaying) return true;
            // AI Search is busy — don't compete for file handles
            if (window.aiSearch?.state?.indexing) return true;
            return false;
        }

        _autoPauseReason() {
            if (window.app?.videoPlayer?.isPlaying) return 'Paused — playback active';
            if (window.aiSearch?.state?.indexing) return 'Paused — AI Search indexing';
            return 'Paused';
        }

        _startPausePoll() {
            this._stopPausePoll();
            this._pausePoll = setInterval(() => {
                if (this.state === 'paused' && !this._userPaused && !this._shouldAutoPause()) {
                    // auto-pause condition cleared — get going again
                    this.state = 'scanning';
                    emit('status', { state: 'scanning', message: 'Resuming scan…' });
                    this._schedulePump(0);
                } else if (this.state === 'scanning' && this._shouldAutoPause()) {
                    // Conditions appeared mid-scan — pump catches this at next tick
                    this._cancelPending();
                    this.state = 'paused';
                    emit('status', { state: 'paused', message: this._autoPauseReason() });
                    emit('progress', this._progressDetail());
                }
            }, PAUSE_POLL_MS);
        }

        _stopPausePoll() {
            if (this._pausePoll) { clearInterval(this._pausePoll); this._pausePoll = null; }
        }

        _cancelPending() {
            if (this._schedulerHandle && window.backgroundScheduler) {
                window.backgroundScheduler.cancel(this._schedulerHandle);
            } else if (this._schedulerHandle?.token) {
                clearTimeout(this._schedulerHandle.token);
            }
            this._schedulerHandle = null;
        }

        // ============ Helpers ============

        async _filterEligible(events) {
            if (!events || events.length === 0) return [];
            let cacheMap = null;
            try {
                cacheMap = await window.eventInsightsCache.getAllCurrentAsMap();
            } catch { cacheMap = new Map(); }
            const severityVer = window.eventInsightsCache.SEVERITY_SCHEMA_VERSION;
            const healthVer = window.eventInsightsCache.RECORDING_HEALTH_SCHEMA_VERSION;
            const launchesVer = window.eventInsightsCache.LAUNCHES_SCHEMA_VERSION;

            return events.filter(e => {
                if (e.isEmpty) return false;
                if (!e.clipGroups || e.clipGroups.length === 0) return false;
                const key = e.compoundKey || e.name;
                const rec = cacheMap?.get(key);
                if (!rec) return true;
                // Event is eligible if ANY of the cached metrics is stale or
                // missing. We always recompute all three together (one SEI
                // parse pass), so partial coverage isn't worth optimizing.
                const severityOk = rec.severity && rec.severityVersion === severityVer;
                const healthOk   = rec.recordingHealth !== undefined && rec.recordingHealthVersion === healthVer;
                const launchesOk = rec.launches !== undefined && rec.launchesVersion === launchesVer;
                if (severityOk && healthOk && launchesOk) return false;
                return true;
            });
        }

        _findEvent(eventKey) {
            for (const e of this.allEvents) {
                if ((e.compoundKey || e.name) === eventKey) return e;
            }
            return null;
        }

        _eta() {
            if (this.done === 0 || this.total === 0) return null;
            const elapsed = Date.now() - this.startTime;
            const rate = elapsed / this.done;
            const remaining = this.total - this.done;
            return Math.round(rate * remaining);
        }

        _progressDetail(extra = {}) {
            return {
                done: this.done,
                total: this.total,
                currentName: this.currentEventName,
                etaMs: this._eta(),
                paused: this.state === 'paused',
                failures: this.failures.length,
                ...extra
            };
        }

        // ============ Persistence ============

        _saveState() {
            try {
                localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
                    queue: this.queue,
                    done: this.done,
                    total: this.total,
                    startTime: this.startTime,
                    failures: this.failures.slice(-20),  // cap
                    userPaused: this._userPaused,
                    state: this.state === 'paused' ? 'paused' : 'scanning'
                }));
            } catch { /* quota exhausted — non-fatal */ }
        }

        _clearSavedState() {
            try { localStorage.removeItem(STATE_STORAGE_KEY); } catch {}
        }

        /**
         * If a scan was in progress when the tab was closed/reloaded, return
         * a summary so the UI can offer to resume.
         */
        hasSavedScan() {
            try {
                const raw = localStorage.getItem(STATE_STORAGE_KEY);
                if (!raw) return null;
                const saved = JSON.parse(raw);
                if (!saved.queue || saved.queue.length === 0) return null;
                return { remaining: saved.queue.length, total: saved.total };
            } catch { return null; }
        }

        /**
         * Resume a scan that was interrupted by reload. Expects caller to
         * pass the current full events array so we can resolve keys back to
         * objects.
         */
        async resumeSaved(events) {
            const raw = localStorage.getItem(STATE_STORAGE_KEY);
            if (!raw) return false;
            let saved;
            try { saved = JSON.parse(raw); } catch { return false; }
            if (!saved.queue?.length) return false;

            this.allEvents = events || [];
            this.queue = saved.queue;
            this.done = saved.done || 0;
            this.total = saved.total || (this.done + this.queue.length);
            this.failures = saved.failures || [];
            this.startTime = Date.now() - 1;  // can't recover real elapsed — start ETA clock fresh
            this._userPaused = !!saved.userPaused;
            this.state = this._userPaused ? 'paused' : 'scanning';

            emit('status', { state: this.state, message: `Resuming scan · ${this.queue.length} remaining` });
            emit('progress', this._progressDetail());

            if (!this._userPaused) this._schedulePump(0);
            this._startPausePoll();
            return true;
        }
    }

    window.insightsScanner = new InsightsScanner();
})();
