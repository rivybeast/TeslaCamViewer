/**
 * cameraIds — single source of truth for Tesla camera identification.
 *
 * Maps Tesla's `event.metadata.camera` field (numeric trigger IDs 0-7
 * plus the canonical string names that appear in clip filenames) to
 * human-readable labels. Two label flavors are provided:
 *
 *   short   — sidebar / compact UI ('Front', 'Rear', 'Left')
 *   long    — formal output / insurance reports ('Front Camera',
 *             'Rear Camera', 'Left Side (Repeater)')
 *
 * VERIFICATION STATE
 * ------------------
 * Tesla doesn't publish the camera-ID schema; everything here was
 * reverse-engineered. User has confirmed the following IDs against
 * real events from their library:
 *
 *   0 → Front         ✅ verified
 *   5 → Left Repeater ✅ verified
 *   6 → Right Repeater✅ verified
 *
 *   1, 2, 3, 4, 7     ❓ not yet verified — labels here are
 *                        best-guess based on community-reverse-
 *                        engineered sources (SentrySix, TeslaDashcamViewer).
 *                        See task #44 — collect ground truth from real
 *                        events as they come up.
 *
 * The `unknown` flag on each entry surfaces this so UI code can
 * optionally display a "?" or fall back to "Camera N" for unverified IDs.
 *
 * Why a single map instead of three
 * ---------------------------------
 * Before this module: app.js had {0,5,6}, insuranceReport.js had the
 * full 0-7, statisticsManager.js had the full 0-7 BUT disagreed on 2
 * and 3 ('Front Left'/'Front Right' vs 'Front Wide'/'Cabin'). At
 * least one of those was wrong by definition. Now there's exactly one
 * place to update when ground truth lands.
 */
(function () {
    'use strict';

    // Master table. Key = stringified ID or canonical name.
    // verified: true when user has confirmed against a real event.
    const TABLE = {
        // Numeric trigger IDs
        '0': { short: 'Front',          long: 'Front Camera',          verified: true  },
        '1': { short: 'Rear',           long: 'Rear Camera',           verified: false },
        '2': { short: 'Front Wide',     long: 'Front Wide Camera',     verified: false },
        '3': { short: 'Cabin',          long: 'Cabin Camera',          verified: false },
        '4': { short: 'Left Pillar',    long: 'Left Pillar Camera',    verified: false },
        '5': { short: 'Left Repeater',  long: 'Left Side (Repeater)',  verified: true  },
        '6': { short: 'Right Repeater', long: 'Right Side (Repeater)', verified: true  },
        '7': { short: 'Right Pillar',   long: 'Right Pillar Camera',   verified: false },

        // Canonical clip-filename names — always trusted because they
        // come straight from Tesla's filenames, not the trigger ID.
        'front':          { short: 'Front',          long: 'Front Camera',          verified: true },
        'back':           { short: 'Rear',           long: 'Rear Camera',           verified: true },
        'left_repeater':  { short: 'Left Repeater',  long: 'Left Side (Repeater)',  verified: true },
        'right_repeater': { short: 'Right Repeater', long: 'Right Side (Repeater)', verified: true },
        'left_pillar':    { short: 'Left Pillar',    long: 'Left Pillar Camera',    verified: true },
        'right_pillar':   { short: 'Right Pillar',   long: 'Right Pillar Camera',   verified: true }
    };

    /**
     * Resolve a Tesla camera identifier to a label.
     *
     * @param {string|number} id   Numeric trigger ID or canonical name.
     * @param {Object} [opts]
     * @param {'short'|'long'} [opts.style='short']  Output flavor.
     * @param {string} [opts.fallback]  Returned when id is unmapped.
     *   Defaults to "Camera {id}" so unmapped trigger IDs are still
     *   informative ("Camera 9") rather than silently empty.
     * @returns {string}
     */
    function label(id, opts = {}) {
        const style = opts.style === 'long' ? 'long' : 'short';
        const key = String(id ?? '').toLowerCase();
        const entry = TABLE[key];
        if (entry) return entry[style];
        return opts.fallback ?? `Camera ${id}`;
    }

    /**
     * @returns {boolean} true when the id maps to a user-verified entry.
     */
    function isVerified(id) {
        const key = String(id ?? '').toLowerCase();
        return TABLE[key]?.verified === true;
    }

    /**
     * @returns {boolean} true when the id is unmapped entirely (so
     *   callers can choose to log a "[CameraID] Unknown ..." trace
     *   for ground-truth collection per task #44).
     */
    function isUnknown(id) {
        const key = String(id ?? '').toLowerCase();
        return !TABLE[key];
    }

    window.cameraIds = { label, isVerified, isUnknown, TABLE };
})();
