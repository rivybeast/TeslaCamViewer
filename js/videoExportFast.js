/**
 * VideoExportFast - Experimental faster-than-realtime video export
 * using WebCodecs VideoEncoder + mp4-muxer.
 *
 * Drop-in replacement for the MediaRecorder Phase-2 pass in videoExport.js.
 * Receives a pre-rendered frame buffer (ImageBitmap / HTMLCanvasElement) and
 * encodes directly to MP4 without going through a MediaStream, which
 * typically runs 5–10× faster than realtime since it's not bound to
 * wall-clock playback timing.
 *
 * Opt-in via Settings > Export > "Fast Export (Experimental)". Falls back
 * to the standard MediaRecorder path on any failure. tcv.0x465845
 */
class VideoExportFast {
    /**
     * Is the WebCodecs stack present and usable?
     * @returns {boolean}
     */
    static isSupported() {
        return typeof VideoEncoder !== 'undefined'
            && typeof VideoFrame !== 'undefined'
            && typeof VideoDecoder !== 'undefined';
    }

    /**
     * Probe whether a specific H.264 codec string is encodable on this hardware.
     * @param {string} codec
     * @param {number} width
     * @param {number} height
     * @returns {Promise<boolean>}
     */
    static async isCodecSupported(codec, width, height) {
        if (!VideoExportFast.isSupported()) return false;
        try {
            const res = await VideoEncoder.isConfigSupported({
                codec, width, height,
                bitrate: 20_000_000,
                framerate: 30
            });
            return !!(res && res.supported);
        } catch {
            return false;
        }
    }

    constructor() {
        this._muxerModule = null;
    }

    async _loadMuxer() {
        if (this._muxerModule) return this._muxerModule;
        // Vendored ESM — loaded via dynamic import so non-Fast-Export users
        // don't pay the parse/eval cost at startup.
        this._muxerModule = await import('../vendor/mp4-muxer.min.mjs');
        return this._muxerModule;
    }

    /**
     * Encode a pre-rendered frame buffer into an MP4 blob.
     *
     * @param {Object} params
     * @param {Array} params.frameBuffer - Array of CanvasImageSource (ImageBitmap or canvas)
     * @param {number} params.fps
     * @param {number} params.width
     * @param {number} params.height
     * @param {Function} [params.onProgress] - (framesDone, framesTotal) => void
     * @param {Function} [params.onSpeed] - (realtimeMultiplier) => void
     * @returns {Promise<Blob>} MP4 blob
     */
    async encodeFrames({ frameBuffer, fps, width, height, onProgress, onSpeed }) {
        if (!VideoExportFast.isSupported()) {
            throw new Error('WebCodecs not supported in this browser');
        }
        if (!frameBuffer || frameBuffer.length === 0) {
            throw new Error('Unable to encode empty frame buffer');
        }

        const { Muxer, ArrayBufferTarget } = await this._loadMuxer();

        // Codec preference order — VP9 first for QUALITY, H.264 second
        // for COMPATIBILITY.
        //
        // Why VP9 first: H.264 (any profile) was producing visibly
        // degraded mini-map detail on Windows Chrome — fine text/labels
        // washed out, dark areas crushed — even at 80Mbps. The exact
        // same canvas pixels encoded to VP9 (which the WebM export
        // already does via MediaRecorder) look clean. VP9 is more
        // efficient at preserving high-frequency detail at typical
        // export bitrates, and mp4-muxer happily containers VP9 in MP4.
        // Modern players (Chrome, Edge, Firefox, Safari Tech Preview,
        // VLC, recent Quicktime, modern Premiere/Resolve/Final Cut)
        // all play VP9-in-MP4 fine.
        //
        // Why H.264 as fallback: maximum compatibility for older
        // players / older devices. Probe-encode will catch the case
        // where VP9 isn't actually encodable on a given device.
        const candidates = [
            { codec: 'vp09.00.10.08', name: 'vp9', muxName: 'VP9' },
            { codec: 'avc1.42E01F', name: 'avc', muxName: 'H.264 Baseline' },
            { codec: 'avc1.4D401F', name: 'avc', muxName: 'H.264 Main' },
            { codec: 'avc1.640028', name: 'avc', muxName: 'H.264 High' },
            { codec: 'avc1.640033', name: 'avc', muxName: 'H.264 High L5.1' },
            { codec: 'av01.0.04M.08', name: 'av1', muxName: 'AV1' }
        ];

        // Probe each candidate codec by actually encoding a single frame —
        // isConfigSupported() can return true on Chrome but the real encode
        // still fails with "Unexpected frame format" on the user's hardware.
        // The probe creates a throwaway encoder, encodes ONE frame, waits
        // briefly to see if the error callback fires, and if it does moves
        // on to the next codec. Adds ~50ms × candidates-checked to startup
        // but eliminates the "0-byte file because picked-but-broken codec"
        // failure mode.
        const probeFrame = frameBuffer[0];
        let picked = null;
        for (const cand of candidates) {
            if (!(await VideoExportFast.isCodecSupported(cand.codec, width, height))) continue;
            try {
                const probeErrors = [];
                const probeEnc = new VideoEncoder({
                    output: () => { /* discard */ },
                    error: (e) => { probeErrors.push(e); }
                });
                probeEnc.configure({
                    codec: cand.codec, width, height,
                    bitrate: 5_000_000, framerate: fps, latencyMode: 'realtime'
                });
                const probeVf = new VideoFrame(probeFrame, { timestamp: 0, duration: 33333 });
                probeEnc.encode(probeVf, { keyFrame: true });
                probeVf.close();
                await probeEnc.flush().catch(() => {});
                try { probeEnc.close(); } catch {}
                if (probeErrors.length === 0) {
                    picked = cand;
                    break;
                }
                console.warn(`[VideoExportFast] Codec ${cand.codec} reported supported but probe-encode failed: ${probeErrors[0]?.message || probeErrors[0]} — trying next candidate`);
            } catch (probeErr) {
                console.warn(`[VideoExportFast] Codec ${cand.codec} threw during probe: ${probeErr?.message || probeErr} — trying next candidate`);
            }
        }
        if (!picked) {
            throw new Error('Unable to find a supported WebCodecs encoder on this device (all candidates failed probe-encode)');
        }
        console.log(`[VideoExportFast] Using codec: ${picked.muxName} (${picked.codec})`);

        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: {
                codec: picked.name,
                width,
                height,
                frameRate: fps
            },
            fastStart: 'in-memory'
        });

        let framesEncoded = 0;
        const encoderErrors = [];
        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                muxer.addVideoChunk(chunk, meta);
                framesEncoded++;
                if (onProgress) onProgress(framesEncoded, frameBuffer.length);
            },
            error: (e) => {
                // Hardware encoder failures often look like "OperationError" or
                // "InvalidStateError" with vague messages — the codec + dims +
                // frames-encoded context is what makes the log diagnosable.
                const en = e?.name || 'unknown';
                const em = e?.message || String(e) || 'no message';
                console.error(`[VideoExportFast] Encoder error: ${en}: ${em} | codec=${picked.codec} ${width}x${height} @ ${fps}fps bitrate=${legacyBitrate} framesEncoded=${framesEncoded}/${frameBuffer.length} — typically GPU encoder hang or device loss`);
                encoderErrors.push(e);
            }
        });

        // Adaptive bitrate — matches createStreamingEncoder logic.
        // H.264 needs ~50% more bits than VP9 to preserve the same fine
        // detail in dense regions like the mini-map's road labels and
        // text. User-visible symptom of under-bitrate was the mini-map
        // looking artifacted / washed-out in MP4 exports while the
        // identical canvas drawn to a WebM/VP9 file looked clean.
        const megapixelsLegacy = (width * height) / 1_000_000;
        const legacyBitrate = Math.max(30_000_000, Math.min(80_000_000,
            Math.round(megapixelsLegacy * 12_000_000)));
        encoder.configure({
            codec: picked.codec,
            width,
            height,
            bitrate: legacyBitrate,
            framerate: fps,
            latencyMode: 'quality'
        });

        const frameIntervalUs = Math.round(1_000_000 / fps);
        const wallStart = performance.now();
        const legacyEarlyWindow = fps * 5;  // first 5 seconds

        for (let idx = 0; idx < frameBuffer.length; idx++) {
            if (encoderErrors.length > 0) {
                throw encoderErrors[0];
            }

            const timestamp = idx * frameIntervalUs;
            const frame = new VideoFrame(frameBuffer[idx], {
                timestamp,
                duration: frameIntervalUs
            });
            // First 5s: keyframe every 10 frames so encoder rate control
            // stabilizes before user notices. After: every ~1s (fps).
            const isKey = idx === 0
                || (idx < legacyEarlyWindow && idx % 10 === 0)
                || (idx % fps === 0);
            encoder.encode(frame, { keyFrame: isKey });
            frame.close();

            // Backpressure — don't let the encoder queue balloon
            if (encoder.encodeQueueSize > 17) {
                await new Promise(r => setTimeout(r, 5));
            }

            // Speed readout once per second
            if (onSpeed && idx > 0 && idx % fps === 0) {
                const wallElapsed = (performance.now() - wallStart) / 1000;
                const videoElapsed = idx / fps;
                onSpeed(videoElapsed / wallElapsed);
            }
        }

        await encoder.flush();
        encoder.close();
        muxer.finalize();

        const buffer = muxer.target.buffer;
        return new Blob([buffer], { type: 'video/mp4' });
    }

    /**
     * Streaming variant — set up encoder + muxer once, encode frames as they
     * arrive, close VideoFrames immediately. Returns an object with:
     *   encode(source, { keyFrame }) — submit one frame; source can be
     *     HTMLCanvasElement, OffscreenCanvas, ImageBitmap, or VideoFrame.
     *   finalize() — flush encoder, finalize muxer, return mp4 Blob.
     *   abort() — tear everything down on error.
     *
     * Used by the fast-decoder export path to keep memory bounded — previously
     * we accumulated every rendered bitmap into a frameBuffer before encoding
     * Phase 2, which OOM'd Chrome on long exports (~50GB for a 60s 6:3 event).
     *
     * Caller owns timestamp bookkeeping via the `frameIndex` parameter of
     * `encode()`. Keyframe cadence is up to the caller (pass { keyFrame: true }
     * ~once per second).
     *
     * @param {Object} opts
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {number} opts.fps
     * @param {number} [opts.bitrate=20_000_000]
     * @param {Function} [opts.onProgress] — (framesEncoded) => void
     */
    async createStreamingEncoder({ width, height, fps, bitrate, onProgress }) {
        // Adaptive default bitrate — scale with pixel count so 4K exports
        // don't starve the first keyframe. User-visible symptom of under-
        // bitrate was "video looks slightly out of focus for the first
        // second or two" (encoder allocating bits to the big opening I-
        // frame and starving subsequent P-frames). 30 Mbps at 4K gives
        // the keyframe enough headroom to encode at full detail.
        if (bitrate == null) {
            const megapixels = (width * height) / 1_000_000;
            // ~12 Mbps per megapixel @30fps, floor 30 / cap 80 Mbps.
            // H.264 is ~30-50% less efficient than VP9 at the same
            // quality. The previous 20Mbps floor was tuned to match
            // WebM's MediaRecorder bitrate, but VP9 at 20Mbps preserves
            // fine detail (road labels, text on mini-map) better than
            // H.264 at 20Mbps. User-visible symptom: MP4 mini-map looked
            // washed-out / dark / artifacted while WebM looked clean.
            // Raised to 30Mbps floor / 12Mbps-per-MP scaling to close
            // the gap. Modern hardware H.264 encoders handle 80Mbps
            // comfortably at 4K resolutions.
            bitrate = Math.max(30_000_000, Math.min(80_000_000,
                Math.round(megapixels * 12_000_000)));
        }
        if (!VideoExportFast.isSupported()) {
            throw new Error('WebCodecs not supported in this browser');
        }
        const { Muxer, ArrayBufferTarget } = await this._loadMuxer();

        // VP9 first for quality, H.264 second for compatibility — same
        // ladder as the buffered encodeFrames path above. See that
        // comment block for the rationale.
        const candidates = [
            { codec: 'vp09.00.10.08', name: 'vp9', muxName: 'VP9' },
            { codec: 'avc1.42E01F', name: 'avc', muxName: 'H.264 Baseline' },
            { codec: 'avc1.4D401F', name: 'avc', muxName: 'H.264 Main' },
            { codec: 'avc1.640028', name: 'avc', muxName: 'H.264 High' },
            { codec: 'avc1.640033', name: 'avc', muxName: 'H.264 High L5.1' },
            { codec: 'av01.0.04M.08', name: 'av1', muxName: 'AV1' }
        ];
        // Probe each candidate by actually encoding a single synthetic frame.
        // `isConfigSupported()` lies on some Chromium / GPU driver combos —
        // it returns supported=true but the first real `encoder.encode(frame)`
        // throws "Unexpected frame format" and kills the entire export.
        // Same fix as `encodeFrames` above; this path needs it too because
        // the fast-decoder export uses the streaming encoder.
        const probeCanvas = document.createElement('canvas');
        probeCanvas.width = width;
        probeCanvas.height = height;
        const probeCtx = probeCanvas.getContext('2d');
        probeCtx.fillStyle = '#000';
        probeCtx.fillRect(0, 0, width, height);
        let picked = null;
        for (const cand of candidates) {
            if (!(await VideoExportFast.isCodecSupported(cand.codec, width, height))) continue;
            try {
                const probeErrors = [];
                const probeEnc = new VideoEncoder({
                    output: () => { /* discard */ },
                    error: (e) => { probeErrors.push(e); }
                });
                probeEnc.configure({
                    codec: cand.codec, width, height,
                    bitrate: 5_000_000, framerate: fps, latencyMode: 'realtime'
                });
                const probeVf = new VideoFrame(probeCanvas, { timestamp: 0, duration: 33333 });
                probeEnc.encode(probeVf, { keyFrame: true });
                probeVf.close();
                await probeEnc.flush().catch(() => {});
                try { probeEnc.close(); } catch {}
                if (probeErrors.length === 0) {
                    picked = cand;
                    break;
                }
                console.warn(`[VideoExportFast] Streaming codec ${cand.codec} reported supported but probe failed: ${probeErrors[0]?.message || probeErrors[0]} — trying next candidate`);
            } catch (probeErr) {
                console.warn(`[VideoExportFast] Streaming codec ${cand.codec} threw during probe: ${probeErr?.message || probeErr} — trying next candidate`);
            }
        }
        if (!picked) throw new Error('Unable to find a supported WebCodecs encoder on this device (all candidates failed probe-encode)');
        console.log(`[VideoExportFast] Streaming encode with codec: ${picked.muxName} (${picked.codec})`);

        const muxer = new Muxer({
            target: new ArrayBufferTarget(),
            video: { codec: picked.name, width, height, frameRate: fps },
            fastStart: 'in-memory'
        });

        let framesEncoded = 0;
        const encoderErrors = [];
        const encoder = new VideoEncoder({
            output: (chunk, meta) => {
                muxer.addVideoChunk(chunk, meta);
                framesEncoded++;
                if (onProgress) onProgress(framesEncoded);
            },
            error: (e) => {
                // Streaming encoder is fed in real-time during Phase 1 —
                // backpressure is on `encodeQueueSize > 17` but a GPU
                // hang here still kills the run. Same diagnostic context
                // as the buffered-encoder path.
                const en = e?.name || 'unknown';
                const em = e?.message || String(e) || 'no message';
                console.error(`[VideoExportFast] Streaming encoder error: ${en}: ${em} | codec=${picked.codec} ${width}x${height} @ ${fps}fps bitrate=${bitrate} framesEncoded=${framesEncoded} — typically GPU encoder hang or device loss`);
                encoderErrors.push(e);
            }
        });

        encoder.configure({
            codec: picked.codec,
            width, height,
            bitrate,
            framerate: fps,
            latencyMode: 'quality'
        });

        const frameIntervalUs = Math.round(1_000_000 / fps);
        let closed = false;

        return {
            /**
             * @param {CanvasImageSource|VideoFrame} source
             * @param {number} frameIndex — monotonic frame number starting at 0
             * @param {{ keyFrame?: boolean }} [opts]
             */
            async encode(source, frameIndex, opts = {}) {
                if (closed) throw new Error('encoder already closed');
                if (encoderErrors.length > 0) throw encoderErrors[0];

                // Keyframe policy — tuned for "crisp from frame 0" output:
                //   - Always at frame 0 (required by spec).
                //   - First 5 seconds: keyframe every 10 frames (~3 per
                //     second). Enough to let the encoder's rate controller
                //     stabilize well before the user's attention drifts,
                //     without bloating file size on long exports. User
                //     previously reported MPEG artifacting through the
                //     opening ~5 seconds — short/dense GOPs here fix that.
                //   - After 5s: every ~1s (fps frames). Normal playback
                //     quality by then; longer GOPs keep file size tidy.
                const earlyWindowFrames = fps * 5;
                const kfIntervalLate = Math.max(1, fps);
                const autoKeyframe = frameIndex === 0
                    || (frameIndex < earlyWindowFrames && frameIndex % 10 === 0)
                    || (frameIndex % kfIntervalLate === 0);

                const timestamp = frameIndex * frameIntervalUs;
                const isVideoFrame = (typeof VideoFrame !== 'undefined') && (source instanceof VideoFrame);

                // Normalize input through createImageBitmap before wrapping in
                // VideoFrame. Passing canvases directly caused intermittent
                // "Unexpected frame format" errors mid-stream — Chrome's
                // canvas-to-VideoFrame path can switch between GPU-texture and
                // CPU-readback backings depending on recent GPU pressure, and
                // the encoder gets unhappy when that changes partway through a
                // stream. ImageBitmap has a stable, well-defined format.
                let frame;
                let bitmap = null;
                if (isVideoFrame) {
                    frame = source;
                } else {
                    bitmap = await createImageBitmap(source);
                    frame = new VideoFrame(bitmap, {
                        timestamp,
                        duration: frameIntervalUs,
                        alpha: 'discard'  // H.264 doesn't carry alpha; be explicit
                    });
                }

                try {
                    encoder.encode(frame, { keyFrame: opts.keyFrame || autoKeyframe });
                } finally {
                    frame.close();
                    if (bitmap) { try { bitmap.close(); } catch {} }
                }

                // Backpressure — drain loop rather than a single sleep. The
                // single-sleep version let queue depth grow unbounded when
                // decode was faster than encode, which both OOM'd and produced
                // format errors from stale frames.
                while (encoder.encodeQueueSize > 17 && !closed && encoderErrors.length === 0) {
                    await new Promise(r => setTimeout(r, 10));
                }
            },

            async finalize() {
                if (closed) throw new Error('already finalized');
                closed = true;
                await encoder.flush();
                if (encoderErrors.length > 0) throw encoderErrors[0];
                encoder.close();
                muxer.finalize();
                return new Blob([muxer.target.buffer], { type: 'video/mp4' });
            },

            abort() {
                if (closed) return;
                closed = true;
                try { encoder.close(); } catch {}
                // muxer has no explicit abort — it leaks its ArrayBuffer which
                // will GC once we drop our reference.
            }
        };
    }
}

window.VideoExportFast = VideoExportFast;
