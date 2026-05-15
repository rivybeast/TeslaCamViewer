/**
 * InsightsScannerUI — persistent progress widget for the library-wide
 * insights scan. Bottom-right fixed position; styled to match the AI
 * Search indexing widget so the two read as siblings when both are
 * running (AI Search sits at 20px bottom; we stack above it at 140px).
 *
 * Pure display layer — listens to `insights-scan:progress` / `status`
 * events from the scanner and never calls the scanner internals directly
 * except for the button click handlers.
 */
(function () {
    'use strict';

    const WIDGET_ID = 'insightsScannerProgressWidget';

    function ensureWidget() {
        let el = document.getElementById(WIDGET_ID);
        if (el) return el;
        el = document.createElement('div');
        el.id = WIDGET_ID;
        el.style.cssText = [
            'position:fixed',
            'bottom:140px',             // stack above AI Search widget at 20px
            'right:20px',
            'z-index:10000',
            'background:var(--bg-elevated)',
            'border:1px solid var(--border)',
            'border-radius:8px',
            'box-shadow:0 6px 20px rgba(0,0,0,0.4)',
            'padding:12px 14px',
            'width:340px',
            'color:var(--text-primary)',
            'font-size:0.85rem',
            'display:none'
        ].join(';');
        el.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong>📊 Scanning library insights</strong>
                <div style="display:flex;gap:6px;">
                    <button id="insScanPause" class="ins-scan-btn" title="Pause / Resume">Pause</button>
                    <button id="insScanCancel" class="ins-scan-btn" title="Cancel">Cancel</button>
                </div>
            </div>
            <div style="height:6px;background:rgba(255,255,255,0.08);border-radius:3px;overflow:hidden;">
                <div id="insScanBar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s;"></div>
            </div>
            <div id="insScanStatus" style="margin-top:6px;font-size:0.78rem;font-family:ui-monospace,monospace;color:var(--text-secondary);"></div>
            <div id="insScanEta" style="margin-top:2px;font-size:0.7rem;color:var(--text-muted);"></div>
        `;
        document.body.appendChild(el);

        // Button styling (injected once; mirrors AI Search widget look)
        if (!document.getElementById('insScanBtnStyle')) {
            const style = document.createElement('style');
            style.id = 'insScanBtnStyle';
            style.textContent = `
                .ins-scan-btn {
                    background: transparent;
                    border: 1px solid var(--border);
                    color: var(--text-secondary);
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 0.72rem;
                    cursor: pointer;
                }
                .ins-scan-btn:hover { color: var(--text-primary); border-color: var(--accent); }
            `;
            document.head.appendChild(style);
        }

        el.querySelector('#insScanPause').addEventListener('click', () => {
            const st = window.insightsScanner?.getState?.();
            if (!st) return;
            if (st.state === 'paused') window.insightsScanner.resume();
            else window.insightsScanner.pause();
        });
        el.querySelector('#insScanCancel').addEventListener('click', () => {
            if (confirm('Cancel library scan? Already-scanned events will be kept.')) {
                window.insightsScanner?.cancel?.();
            }
        });

        return el;
    }

    function formatEta(ms) {
        if (ms == null || !isFinite(ms) || ms <= 0) return '';
        if (ms < 60_000) return `~${Math.round(ms / 1000)}s remaining`;
        const mins = Math.floor(ms / 60_000);
        const secs = Math.round((ms % 60_000) / 1000);
        return `~${mins}m ${secs}s remaining`;
    }

    function update(detail) {
        const el = ensureWidget();
        el.style.display = '';
        const bar = el.querySelector('#insScanBar');
        const status = el.querySelector('#insScanStatus');
        const eta = el.querySelector('#insScanEta');
        const pauseBtn = el.querySelector('#insScanPause');

        const pct = detail.total > 0 ? (detail.done / detail.total) * 100 : 0;
        bar.style.width = pct.toFixed(1) + '%';

        let line = `${detail.done} / ${detail.total}`;
        if (detail.currentName && !detail.final) line += ' · ' + detail.currentName;
        if (detail.failures > 0) line += ` · ${detail.failures} failed`;
        status.textContent = line;

        if (detail.final) {
            eta.textContent = 'Done.';
            pauseBtn.textContent = '';
            pauseBtn.style.display = 'none';
            // Auto-hide after a few seconds so success doesn't linger
            setTimeout(() => { el.style.display = 'none'; }, 4000);
        } else if (detail.paused) {
            pauseBtn.textContent = 'Resume';
            eta.textContent = 'Paused';
        } else {
            pauseBtn.textContent = 'Pause';
            eta.textContent = formatEta(detail.etaMs);
        }
    }

    function onStatus(e) {
        const detail = e.detail || {};
        if (detail.state === 'cancelled') {
            const el = document.getElementById(WIDGET_ID);
            if (el) el.style.display = 'none';
        }
    }

    window.addEventListener('insights-scan:progress', e => update(e.detail || {}));
    window.addEventListener('insights-scan:status', onStatus);
})();
