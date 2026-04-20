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

        // Try a ladder of codec configs, widest-compat first.
        // WebCodecs H.264 support varies by platform; on Windows Chrome without
        // a dedicated HW encoder, some profiles are unavailable. VP9 is the
        // fallback when no H.264 profile works.
        const candidates = [
            { codec: 'avc1.42E01F', name: 'avc', muxName: 'H.264 Baseline' },
            { codec: 'avc1.4D401F', name: 'avc', muxName: 'H.264 Main' },
            { codec: 'avc1.640028', name: 'avc', muxName: 'H.264 High' },
            { codec: 'avc1.640033', name: 'avc', muxName: 'H.264 High L5.1' },
            { codec: 'vp09.00.10.08', name: 'vp9', muxName: 'VP9' },
            { codec: 'av01.0.04M.08', name: 'av1', muxName: 'AV1' }
        ];

        let picked = null;
        for (const cand of candidates) {
            if (await VideoExportFast.isCodecSupported(cand.codec, width, height)) {
                picked = cand;
                break;
            }
        }
        if (!picked) {
            throw new Error('Unable to find a supported WebCodecs encoder on this device');
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
                console.error('[VideoExportFast] Encoder error:', e);
                encoderErrors.push(e);
            }
        });

        encoder.configure({
            codec: picked.codec,
            width,
            height,
            bitrate: 20_000_000,
            framerate: fps,
            latencyMode: 'quality'
        });

        const frameIntervalUs = Math.round(1_000_000 / fps);
        const wallStart = performance.now();

        for (let idx = 0; idx < frameBuffer.length; idx++) {
            if (encoderErrors.length > 0) {
                throw encoderErrors[0];
            }

            const timestamp = idx * frameIntervalUs;
            const frame = new VideoFrame(frameBuffer[idx], {
                timestamp,
                duration: frameIntervalUs
            });
            // Keyframe every ~1 second
            encoder.encode(frame, { keyFrame: idx % fps === 0 });
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
}

window.VideoExportFast = VideoExportFast;
