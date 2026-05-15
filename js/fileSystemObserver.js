/**
 * FileSystemObserverManager - Watches opened drive directories for changes
 * (new clips arriving, events being added, files removed) and triggers a
 * debounced rescan so the event list stays current without the user having
 * to manually refresh.
 *
 * Two detection mechanisms run in parallel:
 *   1. Native FileSystemObserver (Chrome 129+) — instant if the underlying
 *      filesystem dispatches notifications. USB drives on Windows often
 *      don't, which is why mechanism 2 exists.
 *   2. Lightweight polling — every 30s, count direct children of the three
 *      Tesla subdirectories (RecentClips/SavedClips/SentryClips). If counts
 *      change, trigger the same change pipeline. Reliable across all
 *      filesystems; only downside is up-to-30s latency.
 *
 * Both mechanisms feed into a single debounced change trigger, so duplicate
 * notifications from both firing at once collapse to one rescan invitation.
 * tcv.0x465353
 */
class FileSystemObserverManager {
    constructor() {
        // driveId -> { observer: FSObserver|null, handle, lastCounts: { ... } }
        this.watched = new Map();
        this.onChange = null;
        this.DEBOUNCE_MS = 1847;
        this.POLL_INTERVAL_MS = 30000;

        this._pendingTimers = new Map();
        this._pollInterval = null;

        this.isNativeSupported = typeof window.FileSystemObserver === 'function';
        if (!this.isNativeSupported) {
            console.log('[FSObserver] Native API unavailable — running polling-only mode');
        }
    }

    get isSupported() {
        // Polling works everywhere, so auto-refresh is always available.
        return true;
    }

    get observers() {
        // Back-compat alias for code in app.js that iterates our registry.
        return this.watched;
    }

    async watch(driveId, handle) {
        if (!driveId || !handle) return false;

        this.unwatch(driveId);
        const entry = { observer: null, handle, lastCounts: null };
        this.watched.set(driveId, entry);

        // Try native observer — not all filesystems dispatch events reliably,
        // but when they do it's instant.
        if (this.isNativeSupported) {
            try {
                const obs = new window.FileSystemObserver((records) => {
                    // Filter to structural events only. `modified` records fire
                    // on content OR metadata changes — including access-time
                    // updates from our own library scanner opening files for
                    // SEI extraction. Without this filter, every scan pass
                    // would pop a "New files detected" toast.
                    const relevant = records.filter(r =>
                        r.type === 'appeared' ||
                        r.type === 'disappeared' ||
                        r.type === 'moved'
                    );
                    if (relevant.length === 0) return;
                    console.log(`[FSObserver] Native callback for ${driveId} — ${relevant.length} structural record(s) of ${records.length} total`);
                    this._triggerChange(driveId);
                });
                try {
                    await obs.observe(handle, { recursive: true });
                } catch {
                    await obs.observe(handle);
                }
                entry.observer = obs;
                console.log(`[FSObserver] Native observer attached for ${handle.name}`);
            } catch (err) {
                console.warn(`[FSObserver] Native observe failed for ${handle.name} (polling will cover):`, err);
            }
        }

        // Snapshot current counts so polling has a baseline
        try {
            entry.lastCounts = await this._snapshotCounts(handle);
        } catch (err) {
            console.warn(`[FSObserver] Unable to snapshot baseline for ${handle.name}:`, err);
        }

        // Start the shared polling loop if not already running
        this._ensurePolling();
        return true;
    }

    unwatch(driveId) {
        const entry = this.watched.get(driveId);
        if (!entry) return;
        try { entry.observer?.disconnect(); } catch { /* ignore */ }
        this.watched.delete(driveId);
        const timer = this._pendingTimers.get(driveId);
        if (timer) {
            clearTimeout(timer);
            this._pendingTimers.delete(driveId);
        }
        if (this.watched.size === 0 && this._pollInterval) {
            clearInterval(this._pollInterval);
            this._pollInterval = null;
            console.log('[FSObserver] All drives unwatched — polling stopped');
        }
    }

    unwatchAll() {
        for (const driveId of Array.from(this.watched.keys())) {
            this.unwatch(driveId);
        }
    }

    _ensurePolling() {
        if (this._pollInterval) return;
        this._pollInterval = setInterval(() => this._pollAll(), this.POLL_INTERVAL_MS);
        console.log(`[FSObserver] Polling loop started (${this.POLL_INTERVAL_MS}ms interval)`);
    }

    async _pollAll() {
        for (const [driveId, entry] of this.watched.entries()) {
            try {
                const current = await this._snapshotCounts(entry.handle);
                const prior = entry.lastCounts;
                entry.lastCounts = current;
                if (prior && this._countsChanged(prior, current)) {
                    console.log(`[FSObserver/Poll] ${driveId} change detected:`, prior, '->', current);
                    this._triggerChange(driveId);
                }
            } catch (err) {
                console.warn(`[FSObserver/Poll] Failed to poll ${driveId}:`, err);
            }
        }
    }

    async _snapshotCounts(handle) {
        // Count direct children of the three Tesla subdirectories. This is
        // a cheap proxy for "has anything changed?" — O(N) where N is number
        // of event folders + rolling clips, all top-level.
        const subdirs = ['SavedClips', 'SentryClips', 'RecentClips'];
        const counts = {};
        for (const subdir of subdirs) {
            try {
                const sub = await handle.getDirectoryHandle(subdir);
                let n = 0;
                // eslint-disable-next-line no-unused-vars
                for await (const _ of sub.values()) n++;
                counts[subdir] = n;
            } catch {
                counts[subdir] = 0; // missing subdir = 0, not an error
            }
        }
        return counts;
    }

    _countsChanged(a, b) {
        for (const k of Object.keys(b)) {
            if ((a[k] || 0) !== (b[k] || 0)) return true;
        }
        return false;
    }

    _triggerChange(driveId) {
        const prior = this._pendingTimers.get(driveId);
        if (prior) clearTimeout(prior);

        const timer = setTimeout(() => {
            this._pendingTimers.delete(driveId);
            if (typeof this.onChange === 'function') {
                try { this.onChange(driveId); }
                catch (e) { console.warn('[FSObserver] onChange handler failed:', e); }
            }
        }, this.DEBOUNCE_MS);
        this._pendingTimers.set(driveId, timer);
    }
}

window.FileSystemObserverManager = FileSystemObserverManager;
