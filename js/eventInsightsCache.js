/**
 * EventInsightsCache — IndexedDB store for per-event insights derived
 * from SEI telemetry.
 *
 * Today this caches:
 *   • severity  — output of interventionSeverity.computeFromSei()
 *   • nearMisses — output of telemetryGraphs._detectNearMisses()
 *
 * Why it exists: those two computations require parsing every SEI frame
 * from every clip of an event, which can take several seconds on a
 * 10-minute sentry event. Recomputing from scratch every time the user
 * re-opens the same event is wasteful. This cache lets the sidebar badge
 * appear the moment the event is selected, and lets the timeline paint
 * near-miss markers before the SEI extractor has even started.
 *
 * Record shape (keyed by eventKey = event.compoundKey || event.name):
 *   {
 *     eventKey:         string,
 *     eventTimestamp:   number | null,     // ms; lets us sort by age
 *     version:          number,            // CACHE_VERSION below
 *     severityVersion:  number,            // SEVERITY_SCHEMA_VERSION
 *     nearMissVersion:  number,            // NEARMISS_SCHEMA_VERSION
 *     severity:         object | null,     // interventionSeverity output
 *     nearMisses:       Array | null,      // telemetryGraphs nearMisses
 *     computedAt:       number             // ms (Date.now())
 *   }
 *
 * Versioning: each metric has its own schema version so we can invalidate
 * only the affected cached field when a formula changes, rather than
 * wiping the whole cache.
 */
(function () {
    'use strict';

    const DB_NAME = 'TeslaCamViewerInsights';
    const DB_VERSION = 1;
    const STORE = 'event_insights';

    // Record-level version. Bump if the record *shape* changes in a way
    // that can't be read by older code.
    const CACHE_VERSION = 1;

    // Per-metric schema versions. Bump when the metric's formula changes,
    // so old cached entries recompute the next time the event opens.
    const SEVERITY_SCHEMA_VERSION = 2;  // v2 = Z gravity fix + sustained peaks
    const NEARMISS_SCHEMA_VERSION = 1;
    const RECORDING_HEALTH_SCHEMA_VERSION = 1;
    const LAUNCHES_SCHEMA_VERSION = 1;

    let _dbPromise = null;

    function openDb() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'eventKey' });
                    store.createIndex('computedAt', 'computedAt', { unique: false });
                    store.createIndex('eventTimestamp', 'eventTimestamp', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(err => {
            console.warn('[InsightsCache] IDB open failed, caching disabled:', err);
            _dbPromise = null;
            return null;
        });
        return _dbPromise;
    }

    function tx(mode) {
        return openDb().then(db => {
            if (!db) return null;
            return db.transaction(STORE, mode).objectStore(STORE);
        });
    }

    function promisify(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    const Cache = {
        SEVERITY_SCHEMA_VERSION,
        NEARMISS_SCHEMA_VERSION,
        RECORDING_HEALTH_SCHEMA_VERSION,
        LAUNCHES_SCHEMA_VERSION,

        /**
         * Look up cached insights for an event.
         * @param {string} eventKey
         * @returns {Promise<object|null>} cached record or null
         */
        async get(eventKey) {
            if (!eventKey) return null;
            try {
                const store = await tx('readonly');
                if (!store) return null;
                const rec = await promisify(store.get(eventKey));
                if (!rec || rec.version !== CACHE_VERSION) return null;
                return rec;
            } catch (e) {
                console.warn('[InsightsCache] get failed:', e);
                return null;
            }
        },

        /**
         * Fetch just the severity field if its schema is current, else null.
         * Use this from the event-load path to decide whether to skip recompute.
         */
        async getSeverity(eventKey) {
            const rec = await this.get(eventKey);
            if (!rec || rec.severityVersion !== SEVERITY_SCHEMA_VERSION) return null;
            return rec.severity || null;
        },

        /** Fetch just the near-misses if schema is current, else null. */
        async getNearMisses(eventKey) {
            const rec = await this.get(eventKey);
            if (!rec || rec.nearMissVersion !== NEARMISS_SCHEMA_VERSION) return null;
            return rec.nearMisses || null;
        },

        /** Fetch just the recording-health SEI portion if schema is current, else null. */
        async getRecordingHealth(eventKey) {
            const rec = await this.get(eventKey);
            if (!rec || rec.recordingHealthVersion !== RECORDING_HEALTH_SCHEMA_VERSION) return null;
            return rec.recordingHealth || null;
        },

        /** Fetch just the launch list if schema is current, else null. */
        async getLaunches(eventKey) {
            const rec = await this.get(eventKey);
            if (!rec || rec.launchesVersion !== LAUNCHES_SCHEMA_VERSION) return null;
            return rec.launches || null;
        },

        /**
         * Write a partial update. Reads the existing record, merges the
         * supplied fields, bumps computedAt. Missing fields retain their
         * previous cached value — lets severity and near-miss computes
         * finish independently without stomping each other.
         */
        async putPartial(eventKey, partial) {
            if (!eventKey || !partial) return;
            try {
                const store = await tx('readwrite');
                if (!store) return;
                const existing = await promisify(store.get(eventKey));
                const next = {
                    eventKey,
                    eventTimestamp: partial.eventTimestamp ?? existing?.eventTimestamp ?? null,
                    version: CACHE_VERSION,
                    severityVersion: 'severity' in partial
                        ? SEVERITY_SCHEMA_VERSION : (existing?.severityVersion ?? null),
                    nearMissVersion: 'nearMisses' in partial
                        ? NEARMISS_SCHEMA_VERSION : (existing?.nearMissVersion ?? null),
                    recordingHealthVersion: 'recordingHealth' in partial
                        ? RECORDING_HEALTH_SCHEMA_VERSION : (existing?.recordingHealthVersion ?? null),
                    launchesVersion: 'launches' in partial
                        ? LAUNCHES_SCHEMA_VERSION : (existing?.launchesVersion ?? null),
                    severity: 'severity' in partial
                        ? partial.severity : (existing?.severity ?? null),
                    nearMisses: 'nearMisses' in partial
                        ? partial.nearMisses : (existing?.nearMisses ?? null),
                    recordingHealth: 'recordingHealth' in partial
                        ? partial.recordingHealth : (existing?.recordingHealth ?? null),
                    launches: 'launches' in partial
                        ? partial.launches : (existing?.launches ?? null),
                    computedAt: Date.now()
                };
                await promisify(store.put(next));
            } catch (e) {
                console.warn('[InsightsCache] put failed:', e);
            }
        },

        /** Drop the cached record for one event. */
        async invalidate(eventKey) {
            if (!eventKey) return;
            try {
                const store = await tx('readwrite');
                if (!store) return;
                await promisify(store.delete(eventKey));
            } catch (e) {
                console.warn('[InsightsCache] invalidate failed:', e);
            }
        },

        /** Wipe everything (exposed for a future "clear cache" button). */
        async clear() {
            try {
                const store = await tx('readwrite');
                if (!store) return;
                await promisify(store.clear());
            } catch (e) {
                console.warn('[InsightsCache] clear failed:', e);
            }
        },

        /**
         * Return a Map<eventKey, record> of every cached entry whose
         * per-metric schema version is still current. Use to bulk-hydrate
         * the event list on folder load — single IDB read instead of N gets.
         */
        async getAllCurrentAsMap() {
            try {
                const store = await tx('readonly');
                if (!store) return new Map();
                const all = await promisify(store.getAll());
                const map = new Map();
                for (const rec of all) {
                    if (rec.version !== CACHE_VERSION) continue;
                    map.set(rec.eventKey, rec);
                }
                return map;
            } catch (e) {
                console.warn('[InsightsCache] getAllCurrentAsMap failed:', e);
                return new Map();
            }
        },

        /** Count of cached events (for settings UI). */
        async size() {
            try {
                const store = await tx('readonly');
                if (!store) return 0;
                return await promisify(store.count());
            } catch {
                return 0;
            }
        }
    };

    window.eventInsightsCache = Cache;
})();
