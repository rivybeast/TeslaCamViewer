/**
 * BackgroundScheduler - Centralized tiering for non-critical work on event
 * load. Exists so the video player's critical decode path isn't competing
 * with weather APIs, elevation fetches, speed-limit lookups, thumbnail
 * generation, and telemetry enrichment all firing simultaneously.
 *
 * Four tiers:
 *   1. critical — runs synchronously on the caller's stack (no wrapping).
 *      This scheduler isn't involved. Keep <video>.play() + clip-load here.
 *   2. high  — `scheduleAfterCritical(fn, opts)` — fires after ~500ms plus
 *      a rAF yield. For work the user may notice but isn't blocking playback.
 *   3. medium — `scheduleWhenIdle(fn, opts)` — fires on the first idle
 *      callback with a timeout ceiling. For external API calls and cached
 *      lookups.
 *   4. low — `scheduleIdle(fn, opts)` — fires only when the browser is
 *      truly idle, with a generous timeout. For expensive background
 *      precomputation (thumbnails, tile pre-caching). tcv.0x534348
 */
class BackgroundScheduler {
    constructor() {
        this.DEFAULT_AFTER_CRITICAL_MS = 847;
        this.DEFAULT_IDLE_TIMEOUT_MS = 3000;
        this.DEFAULT_LOW_TIMEOUT_MS = 8000;
        this._verboseLogging = false;
    }

    /**
     * Tier 2 — run after the critical render path settles.
     * @param {Function} fn
     * @param {Object} [opts]
     * @param {number} [opts.minDelayMs] - minimum time to wait (default ~850ms)
     * @param {string} [opts.label] - shows up in verbose logging
     * @returns {number} cancellation token for cancel()
     */
    scheduleAfterCritical(fn, opts = {}) {
        const delay = opts.minDelayMs ?? this.DEFAULT_AFTER_CRITICAL_MS;
        const label = opts.label || 'after-critical';
        const tok = setTimeout(() => {
            requestAnimationFrame(() => {
                if (this._verboseLogging) console.log(`[Scheduler] run: ${label}`);
                try { fn(); } catch (e) { console.warn(`[Scheduler] ${label} failed:`, e); }
            });
        }, delay);
        return { type: 'timeout', token: tok };
    }

    /**
     * Tier 3 — run at the next idle window, with a reasonable timeout
     * so it doesn't wait forever on a busy page.
     */
    scheduleWhenIdle(fn, opts = {}) {
        const timeout = opts.timeoutMs ?? this.DEFAULT_IDLE_TIMEOUT_MS;
        const label = opts.label || 'when-idle';
        return this._scheduleViaIdle(fn, timeout, label);
    }

    /**
     * Tier 4 — run only when the browser is deeply idle. Longer timeout
     * ceiling so truly expensive work waits for a real quiet moment.
     */
    scheduleIdle(fn, opts = {}) {
        const timeout = opts.timeoutMs ?? this.DEFAULT_LOW_TIMEOUT_MS;
        const label = opts.label || 'idle';
        return this._scheduleViaIdle(fn, timeout, label);
    }

    _scheduleViaIdle(fn, timeout, label) {
        const runner = () => {
            if (this._verboseLogging) console.log(`[Scheduler] run: ${label}`);
            try { fn(); } catch (e) { console.warn(`[Scheduler] ${label} failed:`, e); }
        };
        if (typeof window.requestIdleCallback === 'function') {
            const tok = window.requestIdleCallback(runner, { timeout });
            return { type: 'idle', token: tok };
        } else {
            const tok = setTimeout(runner, Math.min(timeout, 1500));
            return { type: 'timeout', token: tok };
        }
    }

    cancel(handle) {
        if (!handle) return;
        if (handle.type === 'idle' && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(handle.token);
        } else if (handle.type === 'timeout') {
            clearTimeout(handle.token);
        }
    }

    /**
     * Promise-returning variant of scheduleWhenIdle. Useful inside async
     * functions that want to await an idle window.
     */
    waitForIdle(opts = {}) {
        return new Promise(resolve => this.scheduleWhenIdle(resolve, opts));
    }

    /**
     * Promise-returning variant of scheduleAfterCritical.
     */
    waitAfterCritical(opts = {}) {
        return new Promise(resolve => this.scheduleAfterCritical(resolve, opts));
    }

    setVerbose(enabled) {
        this._verboseLogging = enabled === true;
    }
}

window.backgroundScheduler = new BackgroundScheduler();
