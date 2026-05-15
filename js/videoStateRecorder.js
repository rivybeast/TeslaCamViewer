/**
 * Video State Recorder — instrumentation to diagnose buffering / desync bugs.
 *
 * Captures (non-intrusively):
 *   - Every HTMLVideoElement event on all 4-6 cameras (play/pause/waiting/
 *     playing/stalled/canplay/canplaythrough/seeked/seeking/suspend/error/
 *     loadeddata/loadedmetadata)
 *   - VideoPlayer buffering state transitions (start/end per camera)
 *   - SyncController drift decisions (when we catch them via patch)
 *   - UI play/pause button clicks
 *   - Event load transitions
 *   - Mouse activity (so we can see if buffering correlates with hover)
 *
 * Ring buffer of last N events. Export via window.videoStateRecorder.export()
 * or the Diagnostics settings tab.
 *
 * NOT always-on: enable with `window.videoStateRecorder.start()` or the UI
 * toggle. Overhead is small (just event listeners) but no reason to run
 * it when users aren't chasing a bug.
 */
(function () {
    'use strict';

    const MAX_EVENTS = 4000;
    const VIDEO_EVENTS = [
        'play', 'pause', 'playing', 'waiting', 'stalled', 'suspend',
        'canplay', 'canplaythrough', 'seeking', 'seeked',
        'loadstart', 'loadedmetadata', 'loadeddata', 'ended', 'error',
        'ratechange', 'volumechange'
    ];

    const Recorder = {
        enabled: false,
        events: [],
        startTs: 0,
        _attachedVideos: new Set(),
        _origHandleBufferingStart: null,
        _origHandleBufferingEnd: null,
        _mouseTimer: null,

        start() {
            if (this.enabled) return;
            this.enabled = true;
            this.events = [];
            this.startTs = performance.now();
            this._attachAll();
            this._patchVideoPlayer();
            this._log('recorder:start', {});
            console.log('[VideoStateRecorder] Recording started. Events will accumulate until stop() or export().');
        },

        stop() {
            if (!this.enabled) return;
            this._log('recorder:stop', { captured: this.events.length });
            this.enabled = false;
            this._detachAll();
            this._unpatchVideoPlayer();
            console.log(`[VideoStateRecorder] Stopped. ${this.events.length} events captured. Use export() to download.`);
        },

        clear() {
            this.events = [];
            this.startTs = performance.now();
        },

        export() {
            const payload = {
                capturedAt: new Date().toISOString(),
                uaDetails: {
                    userAgent: navigator.userAgent,
                    chromeVersion: (navigator.userAgent.match(/Chrome\/(\S+)/) || [])[1] || 'unknown'
                },
                currentEvent: window.app?.currentEvent?.name || null,
                totalDuration: window.app?.timeline?.totalDuration || null,
                cachedClipDurations: window.app?.videoPlayer?.cachedClipDurations || null,
                bufferingStateAtExport: this._snapshotBufferingState(),
                videoStateAtExport: this._snapshotVideoStates(),
                eventCount: this.events.length,
                events: this.events
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `tcv-video-state-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log(`[VideoStateRecorder] Exported ${this.events.length} events.`);
        },

        // --- core logging -------------------------------------------------
        _log(type, data) {
            if (!this.enabled) return;
            if (this.events.length >= MAX_EVENTS) this.events.shift();
            this.events.push({
                t: Math.round(performance.now() - this.startTs),
                type,
                data
            });
        },

        _snapshotVideo(camera, v) {
            if (!v) return null;
            return {
                camera,
                currentTime: +v.currentTime.toFixed(3),
                duration: Number.isFinite(v.duration) ? +v.duration.toFixed(3) : null,
                paused: v.paused,
                ended: v.ended,
                readyState: v.readyState,          // 0-4; 4=HAVE_ENOUGH_DATA
                networkState: v.networkState,     // 0-3; 2=LOADING,3=NO_SOURCE
                buffered: this._bufferedRanges(v),
                playbackRate: v.playbackRate,
                seeking: v.seeking,
                error: v.error ? { code: v.error.code, message: v.error.message } : null
            };
        },

        _bufferedRanges(v) {
            const r = [];
            try {
                for (let i = 0; i < v.buffered.length; i++) {
                    r.push([+v.buffered.start(i).toFixed(2), +v.buffered.end(i).toFixed(2)]);
                }
            } catch (e) { /* buffered can throw in some states */ }
            return r;
        },

        _snapshotVideoStates() {
            const vp = window.app?.videoPlayer;
            if (!vp?.videos) return null;
            const out = {};
            for (const [camera, v] of Object.entries(vp.videos)) {
                out[camera] = this._snapshotVideo(camera, v);
            }
            return out;
        },

        _snapshotBufferingState() {
            const bs = window.app?.videoPlayer?.bufferingState;
            if (!bs) return null;
            return {
                isBuffering: bs.isBuffering,
                bufferingCameras: Array.from(bs.bufferingCameras || []),
                bufferHealth: bs.bufferHealth,
                readSpeed: bs.readSpeedEstimate
            };
        },

        // --- video element listeners --------------------------------------
        _attachAll() {
            const vp = window.app?.videoPlayer;
            if (!vp?.videos) {
                console.warn('[VideoStateRecorder] videoPlayer not ready; will attach when available');
                // Retry shortly — events might load after recorder starts
                setTimeout(() => this.enabled && this._attachAll(), 500);
                return;
            }
            for (const [camera, v] of Object.entries(vp.videos)) {
                if (this._attachedVideos.has(v)) continue;
                this._attachedVideos.add(v);
                for (const ev of VIDEO_EVENTS) {
                    v.addEventListener(ev, this._makeVideoHandler(camera, ev), true);
                }
            }
            // Capture-phase listener on play/pause button
            const btn = document.getElementById('playPauseBtn');
            if (btn && !btn._vsrAttached) {
                btn._vsrAttached = true;
                btn.addEventListener('click', () => this._log('ui:play-pause-click', {
                    btnPausedIcon: !!btn.querySelector('.pause-icon[style*="block"]'),
                    snapshot: this._snapshotVideoStates(),
                    buffering: this._snapshotBufferingState()
                }), true);
            }
            // Mouse activity — capture with heavy debounce so we know if
            // buffering events correlate with hover
            document.addEventListener('mousemove', this._onMouseMove = () => {
                if (this._mouseTimer) return;
                this._mouseTimer = setTimeout(() => {
                    this._mouseTimer = null;
                    this._log('ui:mouse-active', {});
                }, 500);
            });
        },

        _detachAll() {
            // Video element listeners stay (capture-phase, hard to remove cleanly),
            // but since recorder is disabled, _log() is a no-op. Clean enough.
            this._attachedVideos.clear();
            if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove);
            if (this._mouseTimer) { clearTimeout(this._mouseTimer); this._mouseTimer = null; }
        },

        _makeVideoHandler(camera, eventType) {
            return (e) => {
                if (!this.enabled) return;
                const v = e.target;
                this._log(`video:${eventType}`, {
                    camera,
                    currentTime: +v.currentTime.toFixed(3),
                    readyState: v.readyState,
                    networkState: v.networkState,
                    paused: v.paused
                });
            };
        },

        // --- videoPlayer / syncController patches -------------------------
        _patchVideoPlayer() {
            const vp = window.app?.videoPlayer;
            if (!vp) {
                setTimeout(() => this.enabled && this._patchVideoPlayer(), 500);
                return;
            }
            if (vp._vsrPatched) return;
            vp._vsrPatched = true;
            this._origHandleBufferingStart = vp.handleBufferingStart.bind(vp);
            this._origHandleBufferingEnd = vp.handleBufferingEnd.bind(vp);

            const self = this;
            vp.handleBufferingStart = function (camera) {
                self._log('vp:handleBufferingStart', {
                    camera,
                    bufferingCamerasBefore: Array.from(vp.bufferingState.bufferingCameras)
                });
                return self._origHandleBufferingStart(camera);
            };
            vp.handleBufferingEnd = function (camera) {
                self._log('vp:handleBufferingEnd', {
                    camera,
                    bufferingCamerasBefore: Array.from(vp.bufferingState.bufferingCameras)
                });
                return self._origHandleBufferingEnd(camera);
            };

            // Patch onBufferingChange to see what the UI is told
            const origOnBufferingChange = vp.onBufferingChange;
            vp.onBufferingChange = function (state) {
                self._log('vp:onBufferingChange', {
                    buffering: state.buffering,
                    cameras: state.cameras,
                    bufferHealth: state.bufferHealth
                });
                if (origOnBufferingChange) origOnBufferingChange.call(vp, state);
            };

            // SyncController patches — wrap its sync check
            const sc = window.app?.syncController;
            if (sc && !sc._vsrPatched) {
                sc._vsrPatched = true;
                for (const method of ['pauseAll', 'playAll', 'resumeAll', 'syncToMaster', 'handleDrift', 'recoverFromCatastrophicDrift']) {
                    if (typeof sc[method] === 'function') {
                        const orig = sc[method].bind(sc);
                        sc[method] = function (...args) {
                            self._log(`sc:${method}`, { args: args.map(a => (a && typeof a === 'object') ? '[obj]' : a) });
                            return orig(...args);
                        };
                    }
                }
            }
        },

        _unpatchVideoPlayer() {
            const vp = window.app?.videoPlayer;
            if (!vp || !vp._vsrPatched) return;
            if (this._origHandleBufferingStart) vp.handleBufferingStart = this._origHandleBufferingStart;
            if (this._origHandleBufferingEnd) vp.handleBufferingEnd = this._origHandleBufferingEnd;
            vp._vsrPatched = false;
        }
    };

    // --- Tiny floating control panel ----------------------------------
    // Toggled via Ctrl+Shift+R. Discreet when idle; shows red dot + count
    // when recording. One-click export. Stays out of the way during normal
    // use so it's not visible for regular users.
    function mountPanel() {
        if (document.getElementById('vsrPanel')) return;
        const panel = document.createElement('div');
        panel.id = 'vsrPanel';
        // Hidden by default. Opt-in via Settings → Diagnostics → Video State
        // Recorder, which also starts recording automatically. Power users
        // can still pop the panel with Ctrl+Alt+D or from the console.
        panel.style.cssText = `
            position: fixed; bottom: 10px; left: 10px;
            background: rgba(20,20,20,0.92);
            border: 1px solid #3a3a3a;
            border-radius: 6px;
            padding: 6px 10px;
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: #e0e0e0;
            z-index: 99998;
            display: none;
            user-select: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        `;
        panel.innerHTML = `
            <span id="vsrDot" style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#555; margin-right:6px; vertical-align:middle;"></span>
            <span id="vsrStatus">Idle</span>
            <button id="vsrStart" style="margin-left:8px; background:#4a9eff; color:white; border:none; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">Start</button>
            <button id="vsrStop" style="margin-left:4px; background:transparent; color:#f87171; border:1px solid #f87171; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px; display:none;">Stop</button>
            <button id="vsrExport" style="margin-left:4px; background:transparent; color:#4ade80; border:1px solid #4ade80; padding:2px 8px; border-radius:3px; cursor:pointer; font-size:10px;">Export</button>
            <button id="vsrClose" style="margin-left:4px; background:transparent; color:#888; border:none; cursor:pointer; font-size:14px; line-height:1;">×</button>
        `;
        document.body.appendChild(panel);

        const $ = (id) => document.getElementById(id);
        const updateUI = () => {
            if (Recorder.enabled) {
                $('vsrDot').style.background = '#f87171';
                $('vsrDot').style.boxShadow = '0 0 4px #f87171';
                $('vsrStatus').textContent = `REC · ${Recorder.events.length}`;
                $('vsrStart').style.display = 'none';
                $('vsrStop').style.display = '';
            } else {
                $('vsrDot').style.background = '#555';
                $('vsrDot').style.boxShadow = '';
                $('vsrStatus').textContent = Recorder.events.length > 0
                    ? `Stopped · ${Recorder.events.length} events captured`
                    : 'Idle';
                $('vsrStart').style.display = '';
                $('vsrStop').style.display = 'none';
            }
        };
        $('vsrStart').addEventListener('click', () => { Recorder.start(); updateUI(); });
        $('vsrStop').addEventListener('click',  () => { Recorder.stop(); updateUI(); });
        $('vsrExport').addEventListener('click', () => { Recorder.export(); });
        $('vsrClose').addEventListener('click', () => { panel.style.display = 'none'; });
        // Update status counter while recording
        setInterval(() => { if (Recorder.enabled) updateUI(); }, 500);

        // Ctrl+Alt+D (doesn't collide with Chrome hard-reload) shows panel if closed
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                panel.style.display = '';
                updateUI();
            }
        });
        // Expose re-show helper for console use
        Recorder.showPanel = () => { panel.style.display = ''; updateUI(); };
        updateUI();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountPanel);
    } else {
        mountPanel();
    }

    window.videoStateRecorder = Recorder;
    console.log('[VideoStateRecorder] Module loaded. Ctrl+Shift+R to open control panel, or call window.videoStateRecorder.start()');
})();
