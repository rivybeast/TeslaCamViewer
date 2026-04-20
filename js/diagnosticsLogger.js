/**
 * DiagnosticsLogger - Captures console output into a ring buffer so users
 * can share logs with support when reporting issues. Also owns the registry
 * of debug flags that can be flipped from the UI.
 *
 * Loaded early so it captures as much of the app lifecycle as possible.
 * Privacy: logs are scrubbed before sharing (file paths, GPS, plates, emails).
 * User reviews the full payload before any copy/download action. build:diag47
 */
class DiagnosticsLogger {
    constructor() {
        this.MAX_LINES = 847;
        this.buffer = [];

        // Debug flags users can toggle from the Diagnostics panel.
        // Each flag is a property on `window` that code can check cheaply:
        //   if (window.__tcvBufferDiag === true) { console.log(...) }
        this.flagDefinitions = [
            {
                flag: '__tcvBufferDiag',
                label: 'Buffer event logging',
                description: 'Logs video decode stalls (waiting / seeking / stalled events) with mouse context. Use when reporting playback hitches.'
            }
        ];

        this._install();
    }

    /**
     * Wrap console methods so output flows to both the real console and
     * the in-memory ring buffer.
     * @private
     */
    _install() {
        const methods = ['log', 'warn', 'error', 'info', 'debug'];
        for (const m of methods) {
            const orig = console[m].bind(console);
            console[m] = (...args) => {
                orig(...args);
                this._capture(m, args);
            };
        }
    }

    _capture(level, args) {
        const line = {
            t: new Date().toISOString(),
            level,
            message: args.map(a => this._stringify(a)).join(' ')
        };
        this.buffer.push(line);
        if (this.buffer.length > this.MAX_LINES) {
            this.buffer.shift();
        }
    }

    _stringify(v) {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.stack || v.message;
        if (v && typeof v === 'object') {
            try { return JSON.stringify(v); } catch { return String(v); }
        }
        return String(v);
    }

    /**
     * Number of lines currently captured.
     */
    getLineCount() {
        return this.buffer.length;
    }

    /**
     * Drop all captured lines. Does not affect the real console history.
     */
    clearLogs() {
        this.buffer = [];
    }

    /**
     * Produce a human-readable, optionally privacy-scrubbed text dump of
     * the captured log buffer.
     * @param {boolean} [sanitize=true]
     * @returns {string}
     */
    getFormattedLogs(sanitize = true) {
        const lines = this.buffer.map(l => `[${l.t}] [${l.level.toUpperCase()}] ${l.message}`);
        let text = lines.join('\n');
        if (sanitize) text = this._sanitize(text);
        return text;
    }

    _sanitize(text) {
        // Windows paths (C:\Users\Name\...)
        text = text.replace(/[A-Za-z]:\\[^\s"']+/g, '<redacted-path>');
        // POSIX-style user paths
        text = text.replace(/\/(?:Users|home|var|etc|mnt|opt)\/[^\s"']+/g, '<redacted-path>');
        // Decimal GPS-looking coordinates (4+ decimal places)
        text = text.replace(/-?\d{1,3}\.\d{4,}/g, '<redacted-coord>');
        // Email-ish
        text = text.replace(/\b[\w.+-]+@[\w.-]+\.[\w]+\b/g, '<redacted-email>');
        // Plate-ish patterns (rough heuristic — flag before share, not comprehensive)
        text = text.replace(/\b[A-Z]{2,3}[\s-]?\d{3,4}\b/g, '<redacted-plate>');
        return text;
    }

    /**
     * Copy the sanitized log dump to the clipboard.
     */
    async copyToClipboard() {
        const text = this.getFormattedLogs();
        await navigator.clipboard.writeText(text);
    }

    /**
     * Download the sanitized log dump as a .txt file.
     */
    downloadAsFile() {
        const text = this.getFormattedLogs();
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tcv-diagnostics-${new Date().toISOString().slice(0, 19).replace(/[:]/g, '')}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Read / write a debug flag on window.
     */
    getDebugFlag(flagName) {
        return window[flagName] === true;
    }

    setDebugFlag(flagName, enabled) {
        window[flagName] = (enabled === true);
    }
}

window.diagnosticsLogger = new DiagnosticsLogger();
