/**
 * VideoPlayer - Manages 4-6 panel synchronized video playback
 * Supports both 4-camera (Model 3/Y) and 6-camera (Cybertruck/refresh) systems
 * Sync threshold: 78.77ms
 */

class VideoPlayer {
    constructor() {
        this._uid = 0x4E617465; // internal tracking

        // Feature flag — WebCodecs-backed player for users whose hardware
        // struggles with 4+ HTML5 <video> elements (Intel iGPU overlay-slot
        // starvation). When enabled, each <video> in the grid is replaced
        // with a <canvas> that gets HTMLVideoElement-style properties
        // installed by WebCodecsVideoElement.install. All downstream code
        // accessing `this.videos.front.currentTime` etc. works unchanged.
        //
        // VideoPlayer is constructed from app.js BEFORE `window.app` is
        // assigned, so we read settings directly from localStorage rather
        // than via settingsManager. Key matches SettingsManager.STORAGE_KEY.
        this._useWebCodecs = this._readFlag('useWebCodecsPlayer')
            && window.WebCodecsVideoElement?.isSupported?.();
        if (this._useWebCodecs) {
            console.log('[VideoPlayer] WebCodecs-backed player enabled');
        }

        this.videos = this._resolveVideos();

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.isPlaying = false;
        this.shouldAutoContinue = false;
        this.loopEnabled = false;
        this.disableAutoAdvance = false; // Can be set to prevent auto-advance during export
        this.hasPillarCameras = false; // Set when loading event with pillar cameras
        this.cachedClipDurations = []; // Cached durations from getTotalDuration for consistent seeking
        this.videoURLs = {
            front: null,
            back: null,
            left_repeater: null,
            right_repeater: null,
            left_pillar: null,
            right_pillar: null
        };

        // Callbacks
        this.onClipChange = null;
        this.onTimeUpdate = null;
        this.onEnded = null;
        this.onPlayStateChange = null;
        this.onBufferingChange = null; // Called when buffering state changes

        // Buffering state tracking
        this.bufferingState = {
            isBuffering: false,
            bufferingCameras: new Set(),
            lastBufferCheck: 0,
            bufferHealth: 100, // 0-100 percentage
            readSpeedEstimate: 0 // MB/s estimate
        };

        // Debounce buffering UI notifications. Decode stalls shorter than this
        // threshold are invisible to users (video catches up within a frame or
        // two) and only generate UI flicker if surfaced. Real stalls lasting
        // beyond this threshold still fire onBufferingChange normally.
        this._bufferingUiDelayMs = 300;
        this._bufferingStartTimer = null;
        this._bufferingStartDispatched = false;

        // Stuck-video watchdog. Diagnosed from a real recorded incident:
        // Intel integrated GPUs have 2 YUV hardware overlay slots. With 4
        // videos, under contention, one video can get starved and stuck at
        // readyState=2 with no native recovery path — HTML5 video has no
        // "overlay slot freed up, retry decode" event. The watchdog polls
        // for this state and triggers a micro-seek to force the decoder
        // to reset and re-request its overlay slot.
        this._watchdogInterval = null;
        this._watchdogPrevTime = {};       // camera -> last observed currentTime
        this._watchdogLastPoke = {};       // camera -> last recovery timestamp
        this._watchdogStuckCount = {};     // camera -> consecutive stuck ticks
        this._watchdogPokeCooldownMs = 2000;  // don't re-poke same cam more than every 2s
        this._watchdogRequiredStuckTicks = 2; // must be stuck for 2 ticks (2s) before firing

        // Video labels for ended state tracking
        this.videoLabels = {
            front: document.querySelector('#videoFront')?.parentElement?.querySelector('.video-label'),
            back: document.querySelector('#videoBack')?.parentElement?.querySelector('.video-label'),
            left_repeater: document.querySelector('#videoLeft')?.parentElement?.querySelector('.video-label'),
            right_repeater: document.querySelector('#videoRight')?.parentElement?.querySelector('.video-label'),
            left_pillar: document.querySelector('#videoLeftPillar')?.parentElement?.querySelector('.video-label'),
            right_pillar: document.querySelector('#videoRightPillar')?.parentElement?.querySelector('.video-label')
        };

        this.setupEventListeners();
    }

    /**
     * Read a boolean setting directly from localStorage. Used pre-window.app
     * in the constructor.
     */
    _readFlag(key) {
        try {
            const raw = localStorage.getItem('teslacamviewer_settings');
            if (!raw) return false;
            const obj = JSON.parse(raw);
            return obj?.[key] === true;
        } catch { return false; }
    }

    /**
     * Build the videos map — either native HTMLVideoElement references
     * (default) or canvas replacements augmented by WebCodecsVideoElement
     * (when the useWebCodecsPlayer feature flag is on).
     *
     * For the WebCodecs path, each <video> element in the DOM is swapped
     * for a <canvas> with the same id/className so CSS rules keep working.
     * The returned map then contains canvases, but downstream code can still
     * do `.videos.front.src = url`, `.videos.front.currentTime = 5`, etc.
     * thanks to the property shim installed on each canvas.
     */
    _resolveVideos() {
        const ids = {
            front: 'videoFront',
            back: 'videoBack',
            left_repeater: 'videoLeft',
            right_repeater: 'videoRight',
            left_pillar: 'videoLeftPillar',
            right_pillar: 'videoRightPillar'
        };

        if (!this._useWebCodecs) {
            const out = {};
            for (const [cam, id] of Object.entries(ids)) {
                out[cam] = document.getElementById(id);
            }
            return out;
        }

        // WebCodecs path — replace each <video> with a <canvas>
        const out = {};
        for (const [cam, id] of Object.entries(ids)) {
            const oldEl = document.getElementById(id);
            if (!oldEl) { out[cam] = null; continue; }
            const canvas = document.createElement('canvas');
            canvas.id = oldEl.id;
            canvas.className = oldEl.className;
            // Copy a few inline styles that might have been set on the video,
            // though most styling comes from CSS via id/class.
            if (oldEl.style.objectFit) canvas.style.objectFit = oldEl.style.objectFit;
            if (oldEl.style.width) canvas.style.width = oldEl.style.width;
            if (oldEl.style.height) canvas.style.height = oldEl.style.height;
            oldEl.parentNode.replaceChild(canvas, oldEl);
            window.WebCodecsVideoElement.install(canvas);
            out[cam] = canvas;
        }
        return out;
    }

    /**
     * Setup video element event listeners
     */
    setupEventListeners() {
        // Listen to front camera for time updates (master)
        this.videos.front.addEventListener('timeupdate', () => {
            if (this.onTimeUpdate) {
                this.onTimeUpdate(this.videos.front.currentTime);
            }
        });

        // Listen for all videos ending
        for (const [camera, video] of Object.entries(this.videos)) {
            video.addEventListener('ended', () => {
                this.updateVideoLabelState(camera, true);
                this.handleVideoEnded(camera);
            });

            // Track playing state to remove ended class
            video.addEventListener('playing', () => {
                this.updateVideoLabelState(camera, false);
                this.handleBufferingEnd(camera);
            });

            // Track buffering/stalling
            video.addEventListener('waiting', () => {
                this._logBufferingDiagnostics(camera, video, 'waiting');
                this.handleBufferingStart(camera);
            });

            video.addEventListener('stalled', () => {
                this._logBufferingDiagnostics(camera, video, 'stalled');
                this.handleBufferingStart(camera);
            });

            video.addEventListener('canplay', () => {
                this.handleBufferingEnd(camera);
            });

            video.addEventListener('seeking', () => {
                this._logBufferingDiagnostics(camera, video, 'seeking');
            });

            video.addEventListener('seeked', () => {
                if (window.__tcvBufferDiag === true) {
                    console.log(`[BufferDiag] ${camera}: seeked → currentTime=${video.currentTime.toFixed(3)}`);
                }
            });

            // Track buffer progress for read speed estimation
            video.addEventListener('progress', () => {
                this.updateBufferHealth(camera, video);
            });

            // Handle runtime errors during playback (not initial load)
            // The loadVideoForCamera method handles errors during load
            video.addEventListener('error', () => {
                // Only handle if video was actually playing (has currentTime > 0)
                // This avoids double-handling errors that loadVideoForCamera already caught
                // Suppress warnings during export to avoid 100K+ error spam
                if (video.currentTime > 0 && !window.app?.videoExporter?.isExporting) {
                    console.warn(`Runtime playback error for ${camera} video`);
                    this.updateVideoLabelState(camera, true);
                }
            });
        }

        // Prevent individual video controls and mute all videos
        for (const video of Object.values(this.videos)) {
            video.controls = false;
            video.muted = true;
            video.volume = 0;
        }

        // Add double-click for fullscreen
        for (const [camera, video] of Object.entries(this.videos)) {
            video.parentElement.addEventListener('dblclick', () => {
                this.toggleFullscreen(video.parentElement);
            });
        }
    }

    /**
     * Update video label state (ended or playing)
     * @param {string} camera
     * @param {boolean} ended
     */
    updateVideoLabelState(camera, ended) {
        const label = this.videoLabels[camera];
        if (label) {
            if (ended) {
                label.classList.add('ended');
            } else {
                label.classList.remove('ended');
            }
        }
    }

    /**
     * Reset all video label states (remove ended class)
     */
    resetAllVideoLabelStates() {
        for (const label of Object.values(this.videoLabels)) {
            if (label) {
                label.classList.remove('ended');
            }
        }
    }

    /**
     * Toggle fullscreen for a video container
     * @param {HTMLElement} element
     */
    toggleFullscreen(element) {
        if (!document.fullscreenElement) {
            element.requestFullscreen().catch(err => {
                console.error('Error entering fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }

    /**
     * Load an event
     * @param {Object} event
     */
    async loadEvent(event) {
        this.currentEvent = event;
        this.currentClipIndex = -1;
        this.hasPillarCameras = event.hasPillarCameras || false;
        await this.loadClip(0);
        // Watchdog is HTML5-specific — it fixes Intel-iGPU 2-YUV-overlay-slot
        // starvation. WebCodecs rendering goes through canvas compositing, no
        // YUV overlays, no starvation; the watchdog's micro-seek recovery
        // would instead just interrupt playback for no reason.
        if (!this._useWebCodecs) {
            this._startStuckVideoWatchdog();
        }
    }

    /**
     * Start the stuck-video watchdog. Runs while an event is loaded.
     * Polls every 1s to detect the "readyState=2, currentTime frozen"
     * state that Intel integrated GPUs (2 YUV overlay slots) produce
     * under 4-camera contention. Micro-seeks stuck cameras to force a
     * decoder reset and recover.
     */
    _startStuckVideoWatchdog() {
        this._stopStuckVideoWatchdog();
        this._watchdogPrevTime = {};
        this._watchdogLastPoke = {};
        this._watchdogStuckCount = {};
        this._watchdogInterval = setInterval(() => this._stuckVideoCheck(), 1000);
    }

    _stopStuckVideoWatchdog() {
        if (this._watchdogInterval) {
            clearInterval(this._watchdogInterval);
            this._watchdogInterval = null;
        }
    }

    _stuckVideoCheck() {
        // Determine which cameras SHOULD be active for this event. For 6-cam
        // events we need to watch the pillars too — don't filter them out
        // just because readyState briefly dropped. The event's own
        // hasPillarCameras flag is the source of truth.
        const expectedCams = this.hasPillarCameras
            ? ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar']
            : ['front', 'back', 'left_repeater', 'right_repeater'];

        const activeCams = [];
        for (const cam of expectedCams) {
            const v = this.videos[cam];
            if (!v || !v.src) continue;
            activeCams.push([cam, v]);
        }
        if (activeCams.length < 2) return;

        // If ANY camera is currently seeking or has readyState < 2, we're
        // almost certainly mid clip-transition. Reset stuck counters and
        // skip — transitions naturally desync cameras by ~100-200ms and
        // we shouldn't mistake that for stuck.
        const transitionInProgress = activeCams.some(([, v]) =>
            v.seeking || v.readyState < 2
        );
        if (transitionInProgress) {
            for (const [cam, v] of activeCams) {
                this._watchdogPrevTime[cam] = v.currentTime;
                this._watchdogStuckCount[cam] = 0;
            }
            return;
        }

        const allPaused = activeCams.every(([, v]) => v.paused);
        if (allPaused) {
            for (const [cam, v] of activeCams) {
                this._watchdogPrevTime[cam] = v.currentTime;
                this._watchdogStuckCount[cam] = 0;
            }
            return;
        }

        // Peer median currentTime — robust to one stuck outlier
        const times = activeCams.map(([, v]) => v.currentTime).sort((a, b) => a - b);
        const median = times[Math.floor(times.length / 2)];

        const now = performance.now();
        for (const [cam, v] of activeCams) {
            const prev = this._watchdogPrevTime[cam] ?? v.currentTime;
            const advanced = (v.currentTime - prev) > 0.05;
            const behindMedian = (median - v.currentTime) > 0.5;
            // Specifically readyState === 2 (HAVE_CURRENT_DATA, decode stalled).
            // readyState 1 = HAVE_METADATA is transient during clip loads and
            // firing on it created a false-positive cascade during transitions.
            const decodeStalled = v.readyState === 2;
            const notPaused = !v.paused && !v.seeking;
            this._watchdogPrevTime[cam] = v.currentTime;

            const stuckCriteria = decodeStalled && !advanced && behindMedian && notPaused;
            if (stuckCriteria) {
                this._watchdogStuckCount[cam] = (this._watchdogStuckCount[cam] || 0) + 1;
            } else {
                this._watchdogStuckCount[cam] = 0;
                continue;
            }

            // Require stuck state to persist across >=2 consecutive ticks
            // before firing. Single-tick blips are normal transition noise.
            if (this._watchdogStuckCount[cam] < this._watchdogRequiredStuckTicks) continue;

            const lastPoke = this._watchdogLastPoke[cam] || 0;
            if (now - lastPoke < this._watchdogPokeCooldownMs) continue;
            this._watchdogLastPoke[cam] = now;
            this._watchdogStuckCount[cam] = 0;

            console.warn(`[VideoPlayer] Unsticking ${cam}: readyState=${v.readyState}, ct=${v.currentTime.toFixed(3)}, median peer=${median.toFixed(3)}. Micro-seeking.`);
            try {
                v.currentTime = Math.min(v.currentTime + 0.01, (v.duration || 60) - 0.1);
                // Let syncController know so it can flash the sync indicator
                // and track per-session recovery stats
                const sc = window.app?.syncController;
                if (sc && typeof sc.notifyWatchdogRecovery === 'function') {
                    sc.notifyWatchdogRecovery(cam, {
                        readyState: v.readyState,
                        currentTime: v.currentTime,
                        peerMedian: median
                    });
                }
            } catch (e) {
                console.warn(`[VideoPlayer] Micro-seek failed on ${cam}: ${e.message}`);
            }
        }
    }

    /**
     * Load a specific clip group
     * @param {number} clipIndex
     */
    async loadClip(clipIndex) {
        if (!this.currentEvent) return;

        if (clipIndex < 0 || clipIndex >= this.currentEvent.clipGroups.length) {
            console.warn('Invalid clip index:', clipIndex);
            return;
        }

        const wasPlaying = this.isPlaying;
        const currentRate = this.getPlaybackRate(); // Preserve playback rate before loading
        if (wasPlaying) {
            await this.pause();
        }

        // Reset label states when loading new clip
        this.resetAllVideoLabelStates();

        this.currentClipIndex = clipIndex;
        const clipGroup = this.currentEvent.clipGroups[clipIndex];

        // Determine which cameras to load (4 or 6 based on event)
        const cameras = ['front', 'back', 'left_repeater', 'right_repeater'];
        if (this.hasPillarCameras) {
            cameras.push('left_pillar', 'right_pillar');
        }

        // Load each camera
        const loadPromises = [];
        for (const camera of cameras) {
            const promise = this.loadVideoForCamera(camera, clipGroup);
            loadPromises.push(promise);
        }

        await Promise.all(loadPromises);

        // Reapply playback rate after loading new videos (browser resets to 1)
        this.setPlaybackRate(currentRate);

        if (this.onClipChange) {
            this.onClipChange(clipIndex);
        }

        // Resume playing if was playing before
        if (wasPlaying) {
            await this.play();
        }
    }

    /**
     * Load video file for a specific camera
     * @param {string} camera
     * @param {Object} clipGroup
     */
    async loadVideoForCamera(camera, clipGroup) {
        const clip = clipGroup.clips[camera];
        const video = this.videos[camera];

        // Revoke previous URL
        if (this.videoURLs[camera]) {
            URL.revokeObjectURL(this.videoURLs[camera]);
            this.videoURLs[camera] = null;
        }

        if (!clip || !clip.fileHandle) {
            video.src = '';
            return;
        }

        try {
            const file = await clip.fileHandle.getFile();
            console.log(`[LoadVideo] ${camera}: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`);

            // Skip empty or very small files (likely corrupted)
            if (file.size < 1024) {
                console.warn(`[LoadVideo] Skipping corrupted file for ${camera}: ${file.name} (${file.size} bytes)`);
                video.src = '';
                return;
            }

            const url = URL.createObjectURL(file);
            this.videoURLs[camera] = url;
            video.src = url;

            // Wait for video to be ready
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.warn(`[LoadVideo] TIMEOUT for ${camera}: ${file.name}`);
                    // Clear source to abort the load
                    video.src = '';
                    this.videoURLs[camera] = null;
                    URL.revokeObjectURL(url);
                    resolve();
                }, 10000); // 10 second timeout

                video.onloadeddata = () => {
                    clearTimeout(timeout);
                    console.log(`[LoadVideo] Loaded ${camera}: ${file.name}`);
                    resolve();
                };
                video.onerror = (e) => {
                    clearTimeout(timeout);
                    // Suppress error logging during export to avoid 100K+ error spam
                    if (!window.app?.videoExporter?.isExporting) {
                        console.error(`[LoadVideo] ERROR for ${camera}: ${file.name}`, e);
                    }
                    // Clear the source on error so it doesn't block playback
                    video.src = '';
                    this.videoURLs[camera] = null;
                    URL.revokeObjectURL(url);
                    resolve(); // Don't reject, let other cameras continue
                };
            });
        } catch (error) {
            console.error(`[LoadVideo] Exception for ${camera}:`, error);
            video.src = '';
        }
    }

    /**
     * Play all videos synchronized
     */
    async play() {
        try {
            // Only play videos that have a source loaded
            const activeVideos = Object.values(this.videos).filter(v => v.src && v.src !== '');

            // If no videos have sources (all failed to load), skip to next clip
            if (activeVideos.length === 0) {
                console.warn('No playable videos in current clip, advancing to next');
                if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
                    await this.loadClip(this.currentClipIndex + 1);
                    return this.play(); // Try playing next clip
                } else {
                    console.log('No more clips to play');
                    this.isPlaying = false;
                    if (this.onPlayStateChange) {
                        this.onPlayStateChange(false);
                    }
                    return;
                }
            }

            const playPromises = activeVideos.map(v => v.play());
            await Promise.all(playPromises);
            this.isPlaying = true;

            // WebCodecs path — take over clock duty so all 6 canvases stay
            // in perfect lockstep (no independent rAF drift, no syncController
            // thrash). See _startWebCodecsMasterClock for why.
            if (this._useWebCodecs) this._startWebCodecsMasterClock();

            // Notify via callback
            if (this.onPlayStateChange) {
                this.onPlayStateChange(true);
            }
        } catch (error) {
            console.error('Error playing videos:', error);
            this.isPlaying = false;
        }
    }

    /**
     * Master rAF clock for WebCodecs-backed canvases.
     *
     * Each canvas has its own decoder + frame queue, but if each ran its own
     * rAF they'd drift (decode rates differ per camera, queue refills are
     * async). Drift → syncController fires resync seeks → decoder teardown
     * → visible stutter.
     *
     * With ONE master clock:
     *   - All 6 canvases always display the same absolute event-time
     *     (per-frame accuracy of the nearest decoded frame)
     *   - No resync seeks ever needed
     *   - syncController still runs but reports 0 drift, does nothing
     *
     * Also tells each canvas it has an external clock so their per-instance
     * rAF loops don't fight our master.
     */
    _startWebCodecsMasterClock() {
        if (this._wcMasterClock) return;
        // Attach external-clock mode to every camera canvas that supports it
        for (const v of Object.values(this.videos)) {
            if (v?.attachExternalClock) v.attachExternalClock();
        }
        const state = {
            rafHandle: null,
            lastT: performance.now(),
            // We advance "clip-local" time (videos share the same clip load,
            // so their internal duration bounds match). Start from front's
            // currentTime to pick up any existing seek position.
            currentClipTime: this.videos.front?.currentTime || 0
        };
        this._wcMasterClock = state;

        const tick = (now) => {
            if (!this._wcMasterClock || !this.isPlaying) {
                state.rafHandle = null;
                return;
            }
            const dt = (now - state.lastT) / 1000;
            state.lastT = now;
            const rate = this.videos.front?.playbackRate || 1;

            // Continuous pacing — master clock advances at wall-clock rate
            // but never runs ahead of the slowest decoder's produced
            // frames. This is smooth: no binary hold/advance oscillation
            // (previous version caused visible catch-up stutter when the
            // CPU was busy). Cameras whose decoder is FINISHED don't
            // constrain the cap — they just freeze-frame at their
            // duration while other cameras keep going.
            //
            // Cap rule: master time ≤ min(each still-producing camera's
            // decoderLastTs). This lets faster cameras smoothly render the
            // full queue while waiting for slower ones.
            let cap = Infinity;
            for (const v of Object.values(this.videos)) {
                if (!v?._wcv || v._wcv._readyState < 1) continue;
                if (!v.src) continue;
                if (v._wcv._decoderFinished) continue;
                const last = v._wcv._decoderLastTs;
                // If a decoder hasn't produced anything yet (-1), don't let
                // it cap us to a negative value and freeze the whole player.
                // Instead treat it as "no information, defer to other cams."
                if (last < 0) continue;
                if (last < cap) cap = last;
            }
            const targetTime = state.currentClipTime + dt * rate;
            state.currentClipTime = Math.min(targetTime, cap);

            // End-of-clip detection — master clock ends when it's passed the
            // LONGEST clip duration across all 6 cameras. Some clips (e.g.
            // right_pillar/right_repeater on certain events) are a fraction
            // of a second shorter than front. Ending at front.duration used
            // to work for HTML5 because browser video marked individual
            // tracks ended independently; here we're a single clock, so we
            // wait for the max so no camera ends before the clock does.
            //
            // When master clock passes an individual camera's duration, we
            // still mark THAT camera's _ended=true right then so downstream
            // handleVideoEnded can poll per-camera state correctly.
            let maxDur = 0;
            for (const v of Object.values(this.videos)) {
                if (!v?.src) continue;
                const d = v.duration || 0;
                if (d > maxDur) maxDur = d;
                // Proactively mark individual cameras ended when past their
                // own duration — their canvas will just freeze-frame.
                const wcv = v._wcv;
                if (wcv && !wcv._ended && d > 0 && state.currentClipTime >= d) {
                    wcv._ended = true;
                    wcv._fire('ended');
                }
            }
            if (state.currentClipTime >= maxDur && maxDur > 0) {
                state.currentClipTime = maxDur;
                // Final sweep — make sure every canvas fired ended (needed
                // for handleVideoEnded's "allEnded" check to pass).
                for (const v of Object.values(this.videos)) {
                    const wcv = v?._wcv;
                    if (wcv && !wcv._ended && v.src) {
                        wcv._ended = true;
                        wcv._fire('ended');
                    }
                }
                // Clean up master-clock state so the next play() sets up fresh.
                this._wcMasterClock = null;
                state.rafHandle = null;
                return;
            }

            for (const v of Object.values(this.videos)) {
                if (v?.tick) v.tick(state.currentClipTime);
            }
            state.rafHandle = requestAnimationFrame(tick);
        };
        state.rafHandle = requestAnimationFrame(tick);
    }

    _stopWebCodecsMasterClock() {
        if (!this._wcMasterClock) return;
        if (this._wcMasterClock.rafHandle) {
            cancelAnimationFrame(this._wcMasterClock.rafHandle);
        }
        this._wcMasterClock = null;
        for (const v of Object.values(this.videos)) {
            if (v?.detachExternalClock) v.detachExternalClock();
        }
    }

    /**
     * Pause all videos
     */
    async pause() {
        if (this._useWebCodecs) this._stopWebCodecsMasterClock();
        for (const video of Object.values(this.videos)) {
            video.pause();
        }
        this.isPlaying = false;

        // Notify via callback
        if (this.onPlayStateChange) {
            this.onPlayStateChange(false);
        }
    }

    /**
     * Seek to a specific time in current clip
     * @param {number} time Time in seconds
     */
    async seek(time) {
        // If seeking backwards past start of clip, load previous clip
        if (time < 0 && this.currentClipIndex > 0) {
            console.log('Seeking before start of clip, loading previous clip');
            await this.loadClip(this.currentClipIndex - 1);
            // Seek to end of previous clip + the negative offset
            const duration = this.getCurrentDuration();
            const newTime = Math.max(0, duration + time); // time is negative
            for (const video of Object.values(this.videos)) {
                video.currentTime = newTime;
            }
            if (this._wcMasterClock) this._wcMasterClock.currentClipTime = newTime;
            return;
        }

        // Check if seeking past end of current clip - load next clip
        const currentDuration = this.getCurrentDuration();
        if (time >= currentDuration && this.currentEvent &&
            this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            console.log('Seeking past end of clip, loading next clip');
            const overflow = Math.max(0, time - currentDuration);
            await this.loadClip(this.currentClipIndex + 1);
            // Seek to the overflow amount in the new clip
            for (const video of Object.values(this.videos)) {
                video.currentTime = overflow;
            }
            if (this._wcMasterClock) this._wcMasterClock.currentClipTime = overflow;
            return;
        }

        // Normal seek within current clip
        // Clamp time to valid range [0, duration - 0.05] to avoid end-of-video issues
        let effectiveTime = null;
        for (const video of Object.values(this.videos)) {
            const maxTime = video.duration ? Math.max(0, video.duration - 0.05) : time;
            const t = Math.max(0, Math.min(time, maxTime));
            video.currentTime = t;
            if (effectiveTime === null) effectiveTime = t;
        }

        // Keep the WebCodecs master clock in sync with the seek. Without
        // this, the clock's internal currentClipTime lagged behind the
        // seek and the next rAF tick would draw the OLD position — making
        // timeline clicks appear to seek back to "near clip start."
        if (this._wcMasterClock && effectiveTime !== null) {
            this._wcMasterClock.currentClipTime = effectiveTime;
        }
    }

    /**
     * Get current playback time (from front camera)
     * @returns {number}
     */
    getCurrentTime() {
        return this.videos.front.currentTime || 0;
    }

    /**
     * Get duration of current clip (from front camera)
     * @returns {number}
     */
    getCurrentDuration() {
        return this.videos.front.duration || 0;
    }

    /**
     * Handle when a video ends
     * @param {string} camera
     */
    handleVideoEnded(camera) {
        // Check if ALL active videos have actually ended (not just paused)
        // Only check videos that have a source loaded (src is set and not empty)
        const activeVideos = Object.values(this.videos).filter(v => v.src && v.src !== '');
        // Consider a video "done" if it ended OR errored (don't block on corrupted files)
        const allEnded = activeVideos.length > 0 && activeVideos.every(v => v.ended || v.error);

        if (!allEnded) {
            // Not all videos finished yet, keep waiting
            return;
        }

        // All videos have ended
        const wasPlaying = this.isPlaying;
        this.isPlaying = false;

        // Check if auto-advance is disabled (e.g., during export)
        if (this.disableAutoAdvance) {
            console.log('Auto-advance disabled, not loading next clip');
            return;
        }

        // Try to load next clip if we were playing
        if (wasPlaying && this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            // Load and play next clip
            this.loadClip(this.currentClipIndex + 1).then(() => {
                // Make sure to set playing state before calling play
                return this.play();
            }).catch(err => {
                console.error('Error loading next clip:', err);
                if (this.onPlayStateChange) {
                    this.onPlayStateChange(false);
                }
            });
        } else if (this.currentClipIndex >= this.currentEvent.clipGroups.length - 1) {
            // Event finished - check if loop is enabled
            if (this.loopEnabled) {
                // Loop back to first clip
                this.loadClip(0).then(() => {
                    return this.play();
                }).catch(err => {
                    console.error('Error looping to first clip:', err);
                    if (this.onPlayStateChange) {
                        this.onPlayStateChange(false);
                    }
                });
            } else {
                // Event finished
                if (this.onEnded) {
                    this.onEnded();
                }
                if (this.onPlayStateChange) {
                    this.onPlayStateChange(false);
                }
            }
        }
    }

    /**
     * Go to next clip
     */
    async nextClip() {
        if (!this.currentEvent) return;
        if (this.currentClipIndex < this.currentEvent.clipGroups.length - 1) {
            await this.loadClip(this.currentClipIndex + 1);
        }
    }

    /**
     * Go to previous clip
     */
    async previousClip() {
        if (!this.currentEvent) return;
        if (this.currentClipIndex > 0) {
            await this.loadClip(this.currentClipIndex - 1);
        }
    }

    /**
     * Set volume for all videos
     * @param {number} volume 0-1
     */
    setVolume(volume) {
        for (const video of Object.values(this.videos)) {
            video.volume = volume;
        }
    }

    /**
     * Set playback rate for all videos
     * @param {number} rate Playback rate (0.25, 0.5, 1, 1.5, 2, etc.)
     */
    setPlaybackRate(rate) {
        for (const video of Object.values(this.videos)) {
            video.playbackRate = rate;
        }
    }

    /**
     * Get current playback rate
     * @returns {number}
     */
    getPlaybackRate() {
        return this.videos.front.playbackRate || 1;
    }

    /**
     * Set loop mode
     * @param {boolean} enabled
     */
    setLoop(enabled) {
        this.loopEnabled = enabled;
    }

    /**
     * Get total event duration
     * @returns {Promise<number>} Duration in seconds
     */
    async getTotalDuration() {
        if (!this.currentEvent) return 0;

        // Clear and rebuild the duration cache
        this.cachedClipDurations = [];
        let total = 0;

        for (let i = 0; i < this.currentEvent.clipGroups.length; i++) {
            const clipGroup = this.currentEvent.clipGroups[i];
            // Use front camera as reference
            const clip = clipGroup.clips.front;
            let duration = 0;

            if (clip && clip.fileHandle) {
                try {
                    const file = await clip.fileHandle.getFile();

                    // Skip empty/corrupted files
                    if (file.size < 1024) {
                        console.warn(`Skipping empty file for duration: ${file.name}`);
                        duration = 60; // Default
                    } else {
                        duration = await this._probeClipDuration(file);
                    }
                } catch (error) {
                    console.error('Error getting clip duration:', error);
                    duration = 60; // Default
                }
            }

            this.cachedClipDurations.push(duration);
            total += duration;
        }

        console.log(`[VideoPlayer] Cached ${this.cachedClipDurations.length} clip durations, total: ${total.toFixed(1)}s`);
        return total;
    }

    /**
     * Probe a single clip's duration by briefly loading it in a throwaway
     * <video> element. Retries once on transient failure — most metadata
     * errors during event load are decoder/IO contention rather than
     * actually corrupt files. Falls back to the 60s default if both
     * attempts fail.
     * @param {File} file
     * @returns {Promise<number>}
     * @private
     */
    async _probeClipDuration(file) {
        const attempt = () => new Promise((resolve) => {
            const video = document.createElement('video');
            const url = URL.createObjectURL(file);
            const cleanup = () => {
                video.src = '';
                URL.revokeObjectURL(url);
            };
            const timeout = setTimeout(() => { cleanup(); resolve({ ok: false, reason: 'timeout' }); }, 5000);
            video.onloadedmetadata = () => {
                clearTimeout(timeout);
                const d = video.duration || 60;
                cleanup();
                resolve({ ok: true, duration: d });
            };
            video.onerror = () => {
                clearTimeout(timeout);
                cleanup();
                resolve({ ok: false, reason: 'error' });
            };
            video.src = url;
        });

        let res = await attempt();
        if (!res.ok) {
            // Yield for a frame then retry — most transient failures come from
            // brief decoder/IO pressure during concurrent event-load work.
            await new Promise(r => setTimeout(r, 120));
            res = await attempt();
        }
        if (!res.ok) {
            console.warn(`Unable to probe duration for ${file.name} after retry (${res.reason}); using 60s default`);
            return 60;
        }
        return res.duration;
    }

    /**
     * Seek to absolute time in event (across all clips)
     * Uses cached clip durations from getTotalDuration() for consistent timing
     * @param {number} eventTime Time in seconds from start of event
     */
    async seekToEventTime(eventTime) {
        if (!this.currentEvent) return;

        // Clamp eventTime to valid range [0, totalDuration]
        // This prevents jumping to the start when seeking past the end
        eventTime = Math.max(0, eventTime);

        let accumulatedTime = 0;
        let targetClipIndex = 0;
        let timeInClip = 0;
        let foundClip = false;

        // Use cached durations for consistent seeking (populated by getTotalDuration)
        if (this.cachedClipDurations.length === this.currentEvent.clipGroups.length) {
            // Use cached durations - fast and consistent
            for (let i = 0; i < this.cachedClipDurations.length; i++) {
                const duration = this.cachedClipDurations[i];
                if (duration === 0) continue; // Skip clips without front camera

                if (accumulatedTime + duration >= eventTime) {
                    targetClipIndex = i;
                    timeInClip = eventTime - accumulatedTime;
                    foundClip = true;
                    break;
                }
                accumulatedTime += duration;
            }

            // If eventTime exceeds total duration, seek to the end of the last valid clip
            if (!foundClip && this.cachedClipDurations.length > 0) {
                // Find the last clip with valid duration
                for (let i = this.cachedClipDurations.length - 1; i >= 0; i--) {
                    if (this.cachedClipDurations[i] > 0) {
                        targetClipIndex = i;
                        // Seek to slightly before the end (0.1s buffer to avoid end-of-video issues)
                        timeInClip = Math.max(0, this.cachedClipDurations[i] - 0.1);
                        console.log(`[VideoPlayer] seekToEventTime: eventTime ${eventTime.toFixed(2)}s exceeds duration, seeking to end of clip ${i} at ${timeInClip.toFixed(2)}s`);
                        break;
                    }
                }
            }
        } else {
            // Fallback: calculate durations (slower, but works if cache not available)
            console.warn('[VideoPlayer] seekToEventTime: Using fallback duration calculation');
            let lastValidClipIndex = 0;
            let lastValidDuration = 60;

            for (let i = 0; i < this.currentEvent.clipGroups.length; i++) {
                const clipGroup = this.currentEvent.clipGroups[i];
                const clip = clipGroup.clips.front;

                if (!clip || !clip.fileHandle) continue;

                try {
                    const file = await clip.fileHandle.getFile();
                    const video = document.createElement('video');
                    const url = URL.createObjectURL(file);
                    video.src = url;

                    const duration = await new Promise((resolve) => {
                        const timeout = setTimeout(() => resolve(60), 3000);
                        video.onloadedmetadata = () => {
                            clearTimeout(timeout);
                            resolve(video.duration || 60);
                        };
                        video.onerror = () => {
                            clearTimeout(timeout);
                            resolve(60);
                        };
                    });

                    // Clean up
                    video.src = '';
                    URL.revokeObjectURL(url);

                    // Track last valid clip for edge case handling
                    lastValidClipIndex = i;
                    lastValidDuration = duration;

                    if (accumulatedTime + duration >= eventTime) {
                        targetClipIndex = i;
                        timeInClip = eventTime - accumulatedTime;
                        foundClip = true;
                        break;
                    }
                    accumulatedTime += duration;
                } catch (error) {
                    console.error('Error during seek:', error);
                    accumulatedTime += 60; // Default on error to prevent drift
                }
            }

            // If eventTime exceeds total duration, seek to the end of the last valid clip
            if (!foundClip) {
                targetClipIndex = lastValidClipIndex;
                // Seek to slightly before the end (0.1s buffer to avoid end-of-video issues)
                timeInClip = Math.max(0, lastValidDuration - 0.1);
                console.log(`[VideoPlayer] seekToEventTime (fallback): eventTime ${eventTime.toFixed(2)}s exceeds duration, seeking to end of clip ${targetClipIndex} at ${timeInClip.toFixed(2)}s`);
            }
        }

        // Load target clip if different
        if (targetClipIndex !== this.currentClipIndex) {
            await this.loadClip(targetClipIndex);
        }

        // Seek within clip
        this.seek(timeInClip);
    }

    /**
     * Clear all videos
     */
    clear() {
        this.pause();

        for (const video of Object.values(this.videos)) {
            video.src = '';
        }

        // Revoke URLs
        for (const camera in this.videoURLs) {
            if (this.videoURLs[camera]) {
                URL.revokeObjectURL(this.videoURLs[camera]);
                this.videoURLs[camera] = null;
            }
        }

        this.currentEvent = null;
        this.currentClipIndex = -1;
        this.cachedClipDurations = []; // Clear duration cache
        this._stopStuckVideoWatchdog();
    }

    /**
     * Check if player is currently playing
     * @returns {boolean}
     */
    getIsPlaying() {
        return this.isPlaying;
    }

    /**
     * Get current absolute time in event (across all clips) using cached durations
     * This is the inverse of seekToEventTime - converts current position to absolute time
     * @returns {number} Absolute time in seconds from start of event
     */
    getCurrentAbsoluteTime() {
        if (!this.currentEvent) return 0;

        let absoluteTime = 0;

        // Add duration of all previous clips using cached durations for accuracy
        if (this.cachedClipDurations.length > 0) {
            for (let i = 0; i < this.currentClipIndex && i < this.cachedClipDurations.length; i++) {
                absoluteTime += this.cachedClipDurations[i];
            }
        } else {
            // Fallback to 60-second estimate if cache not populated
            absoluteTime = this.currentClipIndex * 60;
        }

        // Add current time within clip
        absoluteTime += this.getCurrentTime();

        return absoluteTime;
    }

    /**
     * Diagnostic logger — captures rich context at the moment a video reports
     * a waiting/stalled/seeking event. Correlates with recent mouse activity
     * so we can see whether buffering events are mouse-event-triggered or
     * something else entirely (network stall, codec hitch, etc.).
     *
     * Off by default to keep the console clean. Enable with
     * `window.__tcvBufferDiag = true` in DevTools before reproducing.
     * @private
     */
    _logBufferingDiagnostics(camera, video, eventName) {
        if (window.__tcvBufferDiag !== true) return;
        // Track recent mouse activity globally — one listener for all cameras.
        if (!VideoPlayer._diagMouseInit) {
            VideoPlayer._diagMouseInit = true;
            VideoPlayer._lastMouseAt = 0;
            VideoPlayer._lastMouseTarget = null;
            VideoPlayer._mouseSamples = [];
            document.addEventListener('mousemove', (e) => {
                VideoPlayer._lastMouseAt = performance.now();
                VideoPlayer._lastMouseTarget = e.target;
                VideoPlayer._mouseSamples.push(VideoPlayer._lastMouseAt);
                // Keep last ~2s of samples
                const cutoff = VideoPlayer._lastMouseAt - 2000;
                while (VideoPlayer._mouseSamples.length > 0 && VideoPlayer._mouseSamples[0] < cutoff) {
                    VideoPlayer._mouseSamples.shift();
                }
            }, { capture: true, passive: true });
        }

        const now = performance.now();
        const msSinceMouse = VideoPlayer._lastMouseAt > 0 ? (now - VideoPlayer._lastMouseAt) : null;
        const mouseRateLast2s = VideoPlayer._mouseSamples ? VideoPlayer._mouseSamples.length / 2 : 0;
        const target = VideoPlayer._lastMouseTarget;
        const targetDesc = target
            ? `<${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}${target.className && typeof target.className === 'string' ? '.' + target.className.split(' ').join('.') : ''}>`
            : 'none';

        const readyStateNames = ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'];
        const networkStateNames = ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'];

        console.log(
            `[BufferDiag] ${camera}: ${eventName} @ t=${video.currentTime.toFixed(3)} ` +
            `| ready=${readyStateNames[video.readyState] || video.readyState} ` +
            `| net=${networkStateNames[video.networkState] || video.networkState} ` +
            `| paused=${video.paused} ended=${video.ended} seeking=${video.seeking} ` +
            `| isPlaying=${this.isPlaying} ` +
            `| mouseAgo=${msSinceMouse != null ? msSinceMouse.toFixed(0) + 'ms' : 'n/a'} ` +
            `| rate=${mouseRateLast2s.toFixed(1)}/s ` +
            `| over=${targetDesc}`
        );
    }

    /**
     * Handle buffering start for a camera.
     * Internal state updates immediately but the user-facing
     * onBufferingChange callback is debounced by _bufferingUiDelayMs so that
     * brief decode stalls (common under CSS repaint pressure from mouse hover)
     * don't flash the "Buffering" indicator.
     * @param {string} camera
     */
    handleBufferingStart(camera) {
        if (!this.isPlaying) return; // Only track during playback

        this.bufferingState.bufferingCameras.add(camera);
        this.bufferingState.isBuffering = true;

        // Schedule the UI notification if none is pending and we haven't
        // already dispatched for this stall episode.
        if (!this._bufferingStartTimer && !this._bufferingStartDispatched) {
            this._bufferingStartTimer = setTimeout(() => {
                this._bufferingStartTimer = null;
                // Re-check: only dispatch if we're still actually buffering
                if (this.bufferingState.isBuffering && this.onBufferingChange) {
                    this._bufferingStartDispatched = true;
                    this.onBufferingChange({
                        isBuffering: true,
                        cameras: Array.from(this.bufferingState.bufferingCameras),
                        bufferHealth: this.bufferingState.bufferHealth,
                        readSpeed: this.bufferingState.readSpeedEstimate
                    });
                }
            }, this._bufferingUiDelayMs);
        }
    }

    /**
     * Handle buffering end for a camera.
     * Cancels a pending debounced start if the stall resolved before it
     * would have surfaced. Fires the end callback only if start was
     * actually dispatched.
     * @param {string} camera
     */
    handleBufferingEnd(camera) {
        this.bufferingState.bufferingCameras.delete(camera);

        if (this.bufferingState.bufferingCameras.size === 0) {
            this.bufferingState.isBuffering = false;

            // Stall resolved before debounce fired — silently cancel.
            if (this._bufferingStartTimer) {
                clearTimeout(this._bufferingStartTimer);
                this._bufferingStartTimer = null;
            }

            // Only fire end callback if start was actually surfaced.
            if (this._bufferingStartDispatched && this.onBufferingChange) {
                this._bufferingStartDispatched = false;
                this.onBufferingChange({
                    isBuffering: false,
                    cameras: [],
                    bufferHealth: this.bufferingState.bufferHealth,
                    readSpeed: this.bufferingState.readSpeedEstimate
                });
            }
        }
    }

    /**
     * Update buffer health metrics
     * @param {string} camera
     * @param {HTMLVideoElement} video
     */
    updateBufferHealth(camera, video) {
        const now = performance.now();

        // Only update every 500ms to avoid too frequent calculations
        if (now - this.bufferingState.lastBufferCheck < 500) return;
        this.bufferingState.lastBufferCheck = now;

        // Calculate buffer ahead (seconds of video buffered beyond current time)
        let totalBufferAhead = 0;
        let cameraCount = 0;

        for (const [cam, vid] of Object.entries(this.videos)) {
            if (!vid.src || vid.readyState < 1) continue;

            const buffered = vid.buffered;
            const currentTime = vid.currentTime;
            let bufferEnd = currentTime;

            // Find the buffer range that contains current time
            for (let i = 0; i < buffered.length; i++) {
                if (buffered.start(i) <= currentTime && buffered.end(i) > currentTime) {
                    bufferEnd = buffered.end(i);
                    break;
                }
            }

            totalBufferAhead += (bufferEnd - currentTime);
            cameraCount++;
        }

        if (cameraCount > 0) {
            const avgBufferAhead = totalBufferAhead / cameraCount;
            // Buffer health: 100% = 5+ seconds ahead, 0% = 0 seconds ahead
            this.bufferingState.bufferHealth = Math.min(100, Math.round((avgBufferAhead / 5) * 100));

            // Estimate read speed based on playback rate and buffer maintenance
            const playbackRate = this.videos.front.playbackRate || 1;
            // If we can maintain buffer at this rate, read speed is at least playbackRate * bitrate
            // Rough estimate: 1080p Tesla cam is ~4 Mbps per camera, 4 cameras = ~16 Mbps = ~2 MB/s
            const estimatedBitratePerCamera = 2; // MB/s (rough estimate for 1080p)
            this.bufferingState.readSpeedEstimate = avgBufferAhead > 2
                ? estimatedBitratePerCamera * 4 * playbackRate  // Keeping up
                : estimatedBitratePerCamera * 4 * (avgBufferAhead / 2); // Struggling
        }
    }

    /**
     * Get current buffering state
     * @returns {Object}
     */
    getBufferingState() {
        return {
            isBuffering: this.bufferingState.isBuffering,
            cameras: Array.from(this.bufferingState.bufferingCameras),
            bufferHealth: this.bufferingState.bufferHealth,
            readSpeed: this.bufferingState.readSpeedEstimate
        };
    }
}
