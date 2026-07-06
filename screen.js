// Jumping Tab visualization plugin — Yousician-style hopping-ball
// tablature view. A glowing ball hops along a parabolic trajectory
// from note to note on a 6-string (or 4-string bass) canvas tab.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption (one canvas wrapper, one chart cache,
// one trajectory list). Wave C lifts that: rendering canvas, chart
// caches, trajectory + technique arc caches, and listener refs are
// now all per-instance (closured inside createFactory). Main-player
// usage keeps its single-instance fast path; under splitscreen each
// panel gets its own state, so N panels can render different
// arrangements of the same song without cache cross-talk.
//
// Pure helpers (geometry / time→x mappings / trajectory builder /
// bezier interpolation / range search) stay at module scope —
// they're stateless and the test harness exercises them directly.
//
// Draw functions take (ctx, state) as their first arguments so the
// same set of routines can render either a per-instance factory
// state OR the standalone demo state. The demo harness
// (window.__jumpingtab_state / window.__jumpingtab_demo) preserves
// its module-level mini-state so existing test.html bindings keep
// working without changes.
//
// Trajectory cache multiplies by N under splitscreen: each panel
// rebuilds its own trajectories on first draw whenever bundle.notes
// / bundle.chords reference-change. Acceptable cost — trajectories
// are cheap and the cache hit rate is still ~100% within a song.

(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────
    // Visual lookahead window: 5.5 seconds matches renanboni's
    // fork (preferred over byrongamatos's 8.0 — shorter window,
    // larger note rendering, easier to read at speed).
    const AHEAD = 5.5;
    const BEHIND = 1.2;
    const HIT_LINE_FRAC = 0.18;
    const FADE_SECONDS = 1.0;
    const SQUASH_WINDOW_MS = 60;
    const IMPACT_DURATION = 0.45;
    // Renanboni / alleexx's preference: opt out of the impact-ring
    // animation when notes cross the hit line. The ring code still
    // runs (drawImpacts is part of the standard draw chain) but
    // returns early when this flag is true.
    const DISABLE_RINGS = true;
    const TOP_PAD = 60;
    const BOTTOM_PAD = 36;
    const HIT_ZONE_WIDTH = 56;
    const EDGE_FADE_FRAC = 0.06;
    // Note radius preferences from renanboni: fatter notes + a
    // consistent base/max so circles stay readable at speed.
    const NOTE_BASE_R = 18;
    const NOTE_MAX_R = 18;
    const HEADER_H = 36;
    const MIN_NOTE_R = 6;

    // ── Top-left chord-diagram box (ported verbatim from the 3D
    // Highway plugin's drawChordDiagram, feedBack-plugin-highway-3d).
    // Responsive sizing constants: the diagram cell size is derived
    // from panel height * a size fraction, then hard-capped.
    const DIAG_SIZE_MIN = 0.08;
    const DIAG_SIZE_MAX = 0.16;
    const DIAG_CELL_MAX = 34;

    // ── Typography (slopsmith#376) ───────────────────────────
    // One sans stack (matches slopsmith core's Inter) for prose and
    // one mono stack (JetBrains Mono) for every digit / label. The
    // mono face is chosen for digit disambiguation — 0 is dotted,
    // 3/6/8/9 are visibly distinct at small sizes where the original
    // generic-monospace fallback (DejaVu Sans Mono / Consolas) blurred
    // 0/3/8 together.
    const MONO_STACK  = '"JetBrains Mono", "JetBrains Mono NL", "Cascadia Mono", Consolas, "Liberation Mono", monospace';
    const SANS_STACK  = '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

    // Idempotently inject the JetBrains Mono Google Fonts <link>. The
    // plugin runs in slopsmith core (which already loads Inter) and in
    // the demo harness (which loads Inter directly), so the helper is
    // safe to call from both bootstraps. We guard on a data attribute
    // so reloads / multiple factory instances don't spawn duplicate
    // <link> nodes. Returns the <link> element (existing or new) so
    // callers can await its `load` event before resolving fonts ready
    // — `document.fonts.load(face)` resolves immediately when the face
    // is not yet declared in any stylesheet, so without awaiting the
    // link the readiness check is a no-op on first paint.
    function ensureFonts() {
        if (typeof document === 'undefined' || !document.head) return null;
        let link = document.head.querySelector('link[data-jumpingtab-fonts]');
        if (link) return link;
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600;700;800&display=swap';
        link.setAttribute('data-jumpingtab-fonts', '1');
        document.head.appendChild(link);
        return link;
    }

    // Resolves once every JetBrains Mono and Inter weight we actually
    // render is available, so callers can `.then(redraw)` and have the
    // first painted frame use the loaded faces instead of the generic
    // fallback (the canvas snapshots a font at the moment fillText
    // runs). Inter is loaded by slopsmith core (and by the demo harness
    // directly); JetBrains Mono is loaded by ensureFonts(). We wait on
    // the injected <link>'s `load` event before calling fonts.load(),
    // because fonts.load() resolves immediately when the @font-face
    // rule isn't yet declared — which would silently no-op the
    // readiness gate.
    function whenFontsReady() {
        if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) {
            return Promise.resolve();
        }
        const link = ensureFonts();
        const linkReady = (link && link.sheet == null)
            ? new Promise(resolve => {
                link.addEventListener('load', resolve, { once: true });
                link.addEventListener('error', resolve, { once: true });
            })
            : Promise.resolve();
        return linkReady.then(() => Promise.all([
            // Every weight × face the renderer actually uses; sizes
            // are arbitrary placeholders, fonts.load() resolves once
            // any size of the face/weight is downloaded.
            document.fonts.load('500 12px "JetBrains Mono"'),
            document.fonts.load('600 12px "JetBrains Mono"'),
            document.fonts.load('700 12px "JetBrains Mono"'),
            document.fonts.load('800 14px "JetBrains Mono"'),
            document.fonts.load('400 12px "Inter"'),
            document.fonts.load('500 11px "Inter"'),
            document.fonts.load('600 13px "Inter"'),
        ])).catch(() => {});
    }

    // Per-string colors. Order matches renanboni's
    // the chart-aligned palette — string 0 (high E) is pink, string
    // 1 (B) is yellow, string 2 (G) is cyan, etc. — instead of
    // byrongamatos's earlier order. Extended-range positions 6 / 7
    // (7-string / 8-string guitars from GP imports) are added on
    // top of renanboni's 6-color palette.
    // BASS_COLORS covers 4-string bass + 5-string bass (its 5th
    // color reuses GUITAR_COLORS[5] for warmth).
    // Lookups still fall back to FALLBACK_COLOR via the
    // `|| FALLBACK_COLOR` guards in the draw* functions.
    const GUITAR_COLORS = [
        '#ff6b8b', '#ffe66b', '#6bd5ff', '#ffa56b', '#6bff95', '#c56bff',
        '#ff6bd5', '#6bffe6',  // 7th = pink, 8th = aqua
    ];
    const BASS_COLORS = ['#ff6b8b', '#ffe66b', '#6bff95', '#6bd5ff', '#c56bff'];
    const FALLBACK_COLOR = '#888888';

    // ── Section color palette (cycled) ──────────────────────
    const SECTION_COLORS = [
        'rgba(110, 231, 255, 0.10)',  // cyan
        'rgba(183, 134, 255, 0.10)',  // purple
        'rgba(107, 255, 149, 0.10)',  // green
        'rgba(255, 194, 107, 0.10)',  // orange
        'rgba(255, 107, 139, 0.10)',  // pink
    ];

    // ── Pure helpers (stateless — test harness exercises these) ──

    function stringY(s, height, nStrings) {
        const usable = height - TOP_PAD - BOTTOM_PAD;
        const gap = usable / (nStrings - 1);
        return TOP_PAD + s * gap;
    }

    function yFor(s, H, nStrings) {
        return stringY(nStrings - 1 - s, H, nStrings);
    }

    function colorsFor(nStrings) {
        // Bass arrangements (4 or 5 strings) use the warm BASS_COLORS
        // palette; everything else (6, 7, 8 strings) uses the wider
        // GUITAR_COLORS rainbow. Out-of-range indices (>= the chosen
        // palette length) get a neutral gray fallback at lookup
        // sites — the palette being short doesn't poison rendering.
        return nStrings <= 5 ? BASS_COLORS : GUITAR_COLORS;
    }

    function timeX(t, now, width) {
        const hitX = width * HIT_LINE_FRAC;
        const dt = t - now;
        return hitX + (dt / AHEAD) * (width - hitX);
    }

    function binaryVisibleRange(notes, now) {
        const lo = now - BEHIND;
        const hi = now + AHEAD;
        let l = 0, r = notes.length;
        while (l < r) {
            const m = (l + r) >> 1;
            if (notes[m].t < lo) l = m + 1; else r = m;
        }
        const start = l;
        l = start; r = notes.length;
        while (l < r) {
            const m = (l + r) >> 1;
            if (notes[m].t <= hi) l = m + 1; else r = m;
        }
        return { start, end: l };
    }

    function buildTrajectories(notes) {
        if (notes.length < 2) return [];
        const EPS = 1e-4;
        const groups = [];
        let i = 0;
        while (i < notes.length) {
            const t = notes[i].t;
            let j = i;
            while (j < notes.length && Math.abs(notes[j].t - t) < EPS) j++;
            const slice = notes.slice(i, j);
            let sSum = 0;
            for (const n of slice) sSum += n.s;
            groups.push({
                t,
                notes: slice,
                sAvg: sSum / slice.length,
                f: slice[0].f,
            });
            i = j;
        }

        const arcs = [];
        for (let k = 0; k < groups.length - 1; k++) {
            const a = groups[k];
            const b = groups[k + 1];
            arcs.push({
                t0: a.t, t1: b.t,
                s0: a.sAvg, f0: a.f,
                s1: b.sAvg, f1: b.f,
            });
        }
        return arcs;
    }

    function buildTechniqueArcs(notes) {
        const arcs = [];
        const paired = new Set();
        const lastOnString = new Map();
        for (const n of notes) {
            const prev = lastOnString.get(n.s);
            if (prev) {
                let type = null;
                if (n.ho) type = 'h';
                else if (n.po) type = 'p';
                // Slide target fret is encoded as >= 0 for a real
                // slide and -1 (or null / undefined) for "no slide".
                // 0 is a legal target — a slide INTO an open string —
                // and _rebuildChart uses `sl ?? -1` to preserve it;
                // the old `n.sl && n.sl > 0` check contradicted that
                // by silently dropping slides-to-open.
                else if (n.sl != null && n.sl >= 0) type = 's';
                if (type) {
                    arcs.push({
                        t0: prev.t, t1: n.t, s: n.s, type,
                        f0: prev.f, f1: n.f,
                        n0: prev, n1: n,
                    });
                    paired.add(prev);
                    paired.add(n);
                }
            }
            lastOnString.set(n.s, n);
        }
        return { arcs, paired };
    }

    function bendText(bn) {
        if (!bn || bn <= 0) return '';
        if (bn === 0.5) return '½';
        if (bn === 1) return 'full';
        if (bn === 1.5) return '1½';
        if (bn === 2) return '2';
        if (bn === 2.5) return '2½';
        if (bn >= 3) return String(Math.round(bn));
        return bn.toFixed(1);
    }

    function bezierPoint(x0, y0, cx, cy, x1, y1, u) {
        const v = 1 - u;
        return {
            x: v * v * x0 + 2 * v * u * cx + u * u * x1,
            y: v * v * y0 + 2 * v * u * cy + u * u * y1,
        };
    }

    function noteRadius(x, hitX, W) {
        const dxRight = Math.abs(x - hitX);
        const span = Math.max(hitX, W - hitX);
        const t = 1 - Math.min(1, dxRight / (span * 0.6));
        return NOTE_BASE_R + (NOTE_MAX_R - NOTE_BASE_R) * Math.max(0, t);
    }

    function secondsToPx(seconds, W) {
        const hitX = W * HIT_LINE_FRAC;
        return seconds * (W - hitX) / AHEAD;
    }

    function clampByNeighbors(baseR, n, W) {
        const gap = Math.min(n._gapL || Infinity, n._gapR || Infinity);
        if (!isFinite(gap)) return baseR;
        const gapPx = secondsToPx(gap, W);
        const maxR = Math.max(MIN_NOTE_R, gapPx / 2 - 3);
        return Math.min(baseR, maxR);
    }

    function arcControlPoint(x0, y0, x1, y1) {
        const midX = (x0 + x1) / 2;
        const dy = Math.abs(y1 - y0);
        const rise = Math.min(70, 20 + dy * 1.2);
        const midY = Math.min(y0, y1) - rise;
        return { cx: midX, cy: midY };
    }

    function findActiveArc(arcs, now) {
        let best = null;
        for (const a of arcs) {
            if (a.t0 <= now && now <= a.t1) return a;
            if (a.t1 < now && (!best || a.t1 > best.t1)) best = a;
        }
        return best;
    }

    function nearestNoteAtHit(notes, now, hitX, W) {
        const { start, end } = binaryVisibleRange(notes, now);
        let best = null, bestDx = Infinity;
        for (let i = start; i < end; i++) {
            const n = notes[i];
            const x = timeX(n.t, now, W);
            const dx = Math.abs(x - hitX);
            if (dx < bestDx) { bestDx = dx; best = { note: n, dx, x }; }
        }
        return best;
    }

    function currentSection(sections, now) {
        if (!sections || !sections.length) return null;
        let cur = null;
        for (const sec of sections) {
            if (sec.time <= now) cur = sec;
            else break;
        }
        return cur;
    }

    // ── Pure-state factory (used by both factory instances and demo) ──

    function _newState() {
        return {
            tuning: null,
            // Chord events (with .t and .id referencing into
            // chordTemplates) — populated each frame from
            // bundle.chords. The top-left chord-diagram box reads
            // these directly (to find the current chord); the note-
            // tab renderer flattens chords into state.notes via
            // _rebuildChart so it doesn't need them.
            chords: [],
            // Chord-template lookup table (slopsmith#92) — index
            // by chord.id to get { name, fingers, frets }. Read-
            // only; empty array means "no chord shapes available
            // for this song" (common for GP imports without
            // chord-shape annotations).
            chordTemplates: [],
            // Active string count from bundle.stringCount (slopsmith#93).
            // null = not yet known; drawFrame resolves the active
            // count by trying state.stringCount first, then any
            // positive state.tuning.length, finally falling back to
            // 6 (canonical guitar count). The 5-string-bass /
            // 7-string-guitar paths flow through tuning.length when
            // bundle.stringCount is unavailable from older cores.
            stringCount: null,
            notes: [],
            arcs: [],
            techArcs: [],
            techPaired: new Set(),
            beats: [],
            sections: [],
            songInfo: {},
            ready: false,
        };
    }

    // Flatten bundle.notes + bundle.chords into the single sorted
    // array the rest of this module expects, then precompute
    // per-note same-string neighbor gaps (needed by drawNotes'
    // radius clamp). Mutates `state` in place — the per-instance
    // state object passed by the factory or the demo harness's
    // module-level demo state.
    function _rebuildChart(state, notes, chords) {
        const flat = [];
        if (Array.isArray(notes)) {
            // Clone rather than pushing the upstream note object
            // directly. The gap precomputation below sets _gapL /
            // _gapR as instance fields, which would mutate the
            // bundle.notes entries owned by slopsmith core and
            // visible to every other renderer sharing the same
            // array. It would also throw in strict mode against
            // any frozen / sealed note object. The shape mirrors
            // the chord-expansion branch below so later drawing
            // code doesn't branch on "where did this note come from".
            for (const n of notes) {
                flat.push({
                    t: n.t,
                    s: n.s,
                    f: n.f,
                    sus: n.sus || 0,
                    ho: n.ho || 0,
                    po: n.po || 0,
                    // `??` not `||` — `sl` (slide target fret) can
                    // legitimately be 0 (slide into an open string).
                    // `0 || -1` would collapse that to "no slide" and
                    // drawTechniqueArcs would stop drawing the slide
                    // indicator above those notes. sus / ho / po / bn
                    // use `||` safely because their falsy default and
                    // their no-op numeric value are the same (0).
                    sl: n.sl ?? -1,
                    bn: n.bn || 0,
                });
            }
        }
        if (Array.isArray(chords)) {
            for (const c of chords) {
                if (!c || !Array.isArray(c.notes)) continue;
                for (const cn of c.notes) {
                    flat.push({
                        t: c.t,
                        s: cn.s,
                        f: cn.f,
                        sus: cn.sus || 0,
                        ho: cn.ho || 0,
                        po: cn.po || 0,
                        sl: cn.sl ?? -1,  // see single-note branch above
                        bn: cn.bn || 0,
                    });
                }
            }
        }
        flat.sort((a, b) => a.t - b.t);

        const lastIdxByString = new Map();
        const EPS_T = 1e-4;
        for (let i = 0; i < flat.length; i++) {
            const n = flat[i];
            n._gapL = Infinity;
            n._gapR = Infinity;
            const prevIdx = lastIdxByString.get(n.s);
            if (prevIdx != null) {
                const prev = flat[prevIdx];
                const gap = n.t - prev.t;
                if (gap > EPS_T) {
                    n._gapL = gap;
                    if (gap < prev._gapR) prev._gapR = gap;
                }
            }
            lastIdxByString.set(n.s, i);
        }

        state.notes = flat;
        state.arcs = buildTrajectories(flat);
        const tech = buildTechniqueArcs(flat);
        state.techArcs = tech.arcs;
        state.techPaired = tech.paired;
        state.ready = flat.length > 0;
    }

    function _clearChart(state) {
        state.notes = [];
        state.chords = [];
        state.chordTemplates = [];
        state.arcs = [];
        state.techArcs = [];
        state.techPaired = new Set();
        state.beats = [];
        state.sections = [];
        state.songInfo = {};
        state.tuning = null;
        state.stringCount = null;
        state.ready = false;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Renderers — accept (ctx, state) so the same routines drive both
    // per-instance factory state and the standalone demo harness.
    // ═══════════════════════════════════════════════════════════════════════

    function drawBackground(ctx, state, W, H, nStrings, colors, now) {
        ctx.fillStyle = '#070b18';
        ctx.fillRect(0, 0, W, H);

        const topBand = TOP_PAD;
        const botBand = H - BOTTOM_PAD;
        const laneH = botBand - topBand;

        const laneGrad = ctx.createLinearGradient(0, topBand, 0, botBand);
        laneGrad.addColorStop(0, '#0d1428');
        laneGrad.addColorStop(0.5, '#0a1024');
        laneGrad.addColorStop(1, '#0d1428');
        ctx.fillStyle = laneGrad;
        ctx.fillRect(0, topBand, W, laneH);

        if (state.sections && state.sections.length) {
            const lo = now - BEHIND;
            const hi = now + AHEAD;
            for (let i = 0; i < state.sections.length; i++) {
                const sec = state.sections[i];
                const next = state.sections[i + 1];
                const t0 = sec.time;
                const t1 = next ? next.time : (state.songInfo.duration || t0 + 999);
                if (t1 < lo || t0 > hi) continue;
                const sx0 = timeX(t0, now, W);
                const sx1 = timeX(t1, now, W);
                ctx.fillStyle = SECTION_COLORS[i % SECTION_COLORS.length];
                ctx.fillRect(sx0, topBand, sx1 - sx0, laneH);
            }
        }

        if (state.beats && state.beats.length) {
            const lo = now - BEHIND;
            const hi = now + AHEAD;
            for (const b of state.beats) {
                if (b.time < lo || b.time > hi) continue;
                const bx = timeX(b.time, now, W);
                const isMeasure = b.measure != null && b.measure >= 0;
                ctx.strokeStyle = isMeasure ? 'rgba(200, 210, 240, 0.18)' : 'rgba(140, 150, 180, 0.08)';
                ctx.lineWidth = isMeasure ? 1.5 : 1;
                ctx.beginPath();
                ctx.moveTo(bx, topBand + 4);
                ctx.lineTo(bx, botBand - 4);
                ctx.stroke();
            }
        }

        const hitX = W * HIT_LINE_FRAC;
        const zoneL = hitX - HIT_ZONE_WIDTH / 2;
        const zoneR = hitX + HIT_ZONE_WIDTH / 2;
        const zoneGrad = ctx.createLinearGradient(zoneL, 0, zoneR, 0);
        zoneGrad.addColorStop(0, 'rgba(110, 231, 255, 0)');
        zoneGrad.addColorStop(0.5, 'rgba(110, 231, 255, 0.18)');
        zoneGrad.addColorStop(1, 'rgba(110, 231, 255, 0)');
        ctx.fillStyle = zoneGrad;
        ctx.fillRect(zoneL, topBand, HIT_ZONE_WIDTH, laneH);

        ctx.lineWidth = 1.5;
        for (let s = 0; s < nStrings; s++) {
            const y = yFor(s, H, nStrings);
            ctx.strokeStyle = (colors[s] || FALLBACK_COLOR) + '60';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }

        ctx.font = '700 12px ' + MONO_STACK;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        // String labels for the small note-letter circles. Lookup
        // table keyed by stringCount so adding new instruments later
        // is a single-line change (rather than another nested
        // ternary branch). Out-of-table values fall through to the
        // 8-string layout so 9+-string instruments at least get
        // sensible labels for their first 8 lanes — string indices
        // beyond that draw the circle without a letter via the
        // `labels[s] || ''` guard at the call site.
        const LABEL_SETS = {
            4: ['G', 'D', 'A', 'E'],
            5: ['G', 'D', 'A', 'E', 'B'],
            6: ['e', 'B', 'G', 'D', 'A', 'E'],
            7: ['e', 'B', 'G', 'D', 'A', 'E', 'B'],
            8: ['e', 'B', 'G', 'D', 'A', 'E', 'B', 'F#'],
        };
        const labels = LABEL_SETS[nStrings] || LABEL_SETS[8];
        for (let s = 0; s < nStrings; s++) {
            const y = yFor(s, H, nStrings);
            const stringColor = colors[s] || FALLBACK_COLOR;
            ctx.fillStyle = 'rgba(15, 20, 32, 0.88)';
            ctx.beginPath();
            ctx.arc(16, y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = stringColor + '80';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = stringColor;
            ctx.fillText(labels[s] || '', 16, y + 0.5);
        }

        ctx.save();
        ctx.shadowColor = '#6ee7ff';
        ctx.shadowBlur = 24;
        ctx.strokeStyle = '#d6f6ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(hitX, topBand);
        ctx.lineTo(hitX, botBand);
        ctx.stroke();
        ctx.restore();
    }

    function drawEdgeFade(ctx, W, H) {
        const topBand = TOP_PAD;
        const botBand = H - BOTTOM_PAD;
        const laneH = botBand - topBand;
        const fadeW = W * EDGE_FADE_FRAC;

        const leftGrad = ctx.createLinearGradient(0, 0, fadeW, 0);
        leftGrad.addColorStop(0, 'rgba(7, 11, 24, 1)');
        leftGrad.addColorStop(1, 'rgba(7, 11, 24, 0)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, topBand, fadeW, laneH);

        const rightGrad = ctx.createLinearGradient(W - fadeW, 0, W, 0);
        rightGrad.addColorStop(0, 'rgba(7, 11, 24, 0)');
        rightGrad.addColorStop(1, 'rgba(7, 11, 24, 1)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(W - fadeW, topBand, fadeW, laneH);
    }

    function drawHeader(ctx, state, W, H, now) {
        const info = state.songInfo || {};
        const sec = currentSection(state.sections, now);

        const hdrGrad = ctx.createLinearGradient(0, 0, 0, HEADER_H);
        hdrGrad.addColorStop(0, 'rgba(12, 16, 30, 0.95)');
        hdrGrad.addColorStop(1, 'rgba(12, 16, 30, 0.6)');
        ctx.fillStyle = hdrGrad;
        ctx.fillRect(0, 0, W, HEADER_H);

        ctx.font = '600 13px ' + SANS_STACK;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#e6ecff';
        const title = info.title || 'Unknown';
        ctx.fillText(title, 16, HEADER_H / 2);

        const titleW = ctx.measureText(title).width;
        ctx.font = '400 12px ' + SANS_STACK;
        ctx.fillStyle = 'rgba(200, 210, 230, 0.55)';
        if (info.artist) {
            ctx.fillText('· ' + info.artist, 16 + titleW + 8, HEADER_H / 2);
        }

        ctx.textAlign = 'right';
        if (sec) {
            const label = sec.name || '';
            ctx.font = '700 11px ' + MONO_STACK;
            const lw = ctx.measureText(label).width;
            const bx = W - 16 - lw - 12;
            ctx.fillStyle = 'rgba(110, 231, 255, 0.18)';
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bx, HEADER_H / 2 - 10, lw + 16, 20, 10);
                ctx.fill();
            } else {
                ctx.fillRect(bx, HEADER_H / 2 - 10, lw + 16, 20);
            }
            ctx.fillStyle = '#a6f0ff';
            ctx.fillText(label, W - 24, HEADER_H / 2 + 1);
        }

        if (info.arrangement) {
            ctx.font = '500 11px ' + SANS_STACK;
            ctx.fillStyle = 'rgba(200, 210, 230, 0.55)';
            const margin = sec ? (W - 16 - ctx.measureText((sec.name || '')).width - 32) : W - 16;
            ctx.fillText(info.arrangement, margin, HEADER_H / 2);
        }
    }

    function drawProgress(ctx, state, W, H, now) {
        const duration = (state.songInfo && state.songInfo.duration) || 0;
        if (duration <= 0) return;

        const barY = H - 22;
        const barH = 6;
        const barX = 16;
        const barW = W - 32;

        ctx.fillStyle = 'rgba(200, 210, 230, 0.12)';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(barX, barY, barW, barH, barH / 2);
            ctx.fill();
        } else {
            ctx.fillRect(barX, barY, barW, barH);
        }

        const pct = Math.max(0, Math.min(1, now / duration));
        const fillW = barW * pct;
        const fillGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        fillGrad.addColorStop(0, '#6ee7ff');
        fillGrad.addColorStop(1, '#b786ff');
        ctx.fillStyle = fillGrad;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(barX, barY, fillW, barH, barH / 2);
            ctx.fill();
        } else {
            ctx.fillRect(barX, barY, fillW, barH);
        }

        const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return m + ':' + (s < 10 ? '0' + s : s);
        };
        ctx.font = '500 10px ' + MONO_STACK;
        ctx.fillStyle = 'rgba(200, 210, 230, 0.6)';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(fmt(now), barX, barY - 8);
        ctx.textAlign = 'right';
        ctx.fillText(fmt(duration), barX + barW, barY - 8);
    }

    function drawSustains(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.notes.length) return;
        const { start, end } = binaryVisibleRange(state.notes, now);
        const tailHeight = 8;
        for (let i = start; i < end; i++) {
            const n = state.notes[i];
            if (!n.sus || n.sus <= 0) continue;
            if (n.s < 0 || n.s >= nStrings) continue;
            const x0 = timeX(n.t, now, W);
            const x1 = timeX(n.t + n.sus, now, W);
            const y = yFor(n.s, H, nStrings);
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = colors[n.s] || FALLBACK_COLOR;
            const r = tailHeight / 2;
            ctx.beginPath();
            ctx.moveTo(x0 + r, y - r);
            ctx.lineTo(x1 - r, y - r);
            ctx.arcTo(x1, y - r, x1, y, r);
            ctx.arcTo(x1, y + r, x1 - r, y + r, r);
            ctx.lineTo(x0 + r, y + r);
            ctx.arcTo(x0, y + r, x0, y, r);
            ctx.arcTo(x0, y - r, x0 + r, y - r, r);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    function drawTechniquePairs(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.techArcs || !state.techArcs.length) return;
        const lo = now - BEHIND;
        const hi = now + AHEAD;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const a of state.techArcs) {
            if (a.t1 < lo || a.t0 > hi) continue;
            if (a.s < 0 || a.s >= nStrings) continue;

            const x0 = timeX(a.t0, now, W);
            const x1 = timeX(a.t1, now, W);
            const y = yFor(a.s, H, nStrings);
            const color = colors[a.s] || FALLBACK_COLOR;

            const leftClamp = a.n0 ? clampByNeighbors(NOTE_BASE_R, a.n0, W) : NOTE_BASE_R;
            const rightClamp = a.n1 ? clampByNeighbors(NOTE_BASE_R, a.n1, W) : NOTE_BASE_R;
            const R = Math.min(leftClamp, rightClamp);
            ctx.font = '800 ' + Math.round(R * 0.95) + 'px ' + MONO_STACK;

            let alpha = 1;
            const dt = now - a.t1;
            if (dt > 0) {
                alpha = 1 - (dt / FADE_SECONDS);
                if (alpha <= 0) continue;
            }

            ctx.save();
            ctx.globalAlpha = alpha;

            const left = x0 - R;
            const top = y - R;
            const width = (x1 - x0) + 2 * R;
            const height = 2 * R;

            ctx.shadowColor = color;
            ctx.shadowBlur = 10;
            ctx.fillStyle = color;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(left, top, width, height, R);
            } else {
                ctx.moveTo(left + R, top);
                ctx.lineTo(left + width - R, top);
                ctx.arc(left + width - R, y, R, -Math.PI / 2, Math.PI / 2);
                ctx.lineTo(left + R, top + height);
                ctx.arc(left + R, y, R, Math.PI / 2, (3 * Math.PI) / 2);
                ctx.closePath();
            }
            ctx.fill();

            ctx.shadowBlur = 0;
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            ctx.stroke();

            ctx.fillStyle = '#0a0f1c';
            ctx.fillText(String(a.f0), x0, y + 1);
            ctx.fillText(String(a.f1), x1, y + 1);

            ctx.restore();
        }
    }

    function drawTechniqueArcs(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.techArcs || !state.techArcs.length) return;
        const lo = now - BEHIND;
        const hi = now + AHEAD;

        ctx.save();
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        ctx.font = '700 10px ' + MONO_STACK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const a of state.techArcs) {
            if (a.t1 < lo || a.t0 > hi) continue;
            if (a.s < 0 || a.s >= nStrings) continue;
            const x0 = timeX(a.t0, now, W);
            const x1 = timeX(a.t1, now, W);
            if (x1 - x0 < 6) continue;
            const y = yFor(a.s, H, nStrings);
            const lift = 20;
            const cx = (x0 + x1) / 2;
            const cy = y - lift;

            const color = a.type === 'h' ? '#ffc86b'
                        : a.type === 'p' ? '#ff8ab6'
                        : '#ffffff';
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.moveTo(x0, y - 4);
            ctx.quadraticCurveTo(cx, cy, x1, y - 4);
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.fillStyle = color;
            ctx.fillText(a.type, cx, cy + 1);
        }

        ctx.restore();
    }

    function drawBall(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.arcs.length) return;
        const arc = findActiveArc(state.arcs, now);
        if (!arc) return;

        const x0 = timeX(arc.t0, now, W);
        const y0 = yFor(arc.s0, H, nStrings);
        const x1 = timeX(arc.t1, now, W);
        const y1 = yFor(arc.s1, H, nStrings);
        const { cx, cy } = arcControlPoint(x0, y0, x1, y1);

        const u = Math.max(0, Math.min(1, (now - arc.t0) / Math.max(0.0001, arc.t1 - arc.t0)));
        const p = bezierPoint(x0, y0, cx, cy, x1, y1, u);

        const hitX = W * HIT_LINE_FRAC;
        const nearest = nearestNoteAtHit(state.notes, now, hitX, W);
        let sx = 1, sy = 1;
        if (nearest && nearest.dx < 14) {
            const msFromNote = Math.abs(now - nearest.note.t) * 1000;
            if (msFromNote < SQUASH_WINDOW_MS) {
                const k = 1 - (msFromNote / SQUASH_WINDOW_MS);
                sx = 1 + 0.25 * k;
                sy = 1 - 0.40 * k;
            }
        }

        ctx.save();
        ctx.shadowColor = '#6ee7ff';
        ctx.shadowBlur = 18;
        ctx.translate(p.x, p.y);
        ctx.scale(sx, sy);
        ctx.fillStyle = 'rgba(166, 240, 255, 0.6)';
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawImpacts(ctx, state, W, H, nStrings, colors, now) {
        // DISABLE_RINGS: renanboni / alleexx's preference — the
        // expanding-ring animation on hit-line crossings was too
        // visually busy. Skipping the per-note ring work here also
        // saves a hot-path scan over visible notes when the feature
        // is off.
        if (DISABLE_RINGS) return;
        if (!state.ready || !state.notes.length) return;
        const { start, end } = binaryVisibleRange(state.notes, now);
        const hitX = W * HIT_LINE_FRAC;

        for (let i = start; i < end; i++) {
            const n = state.notes[i];
            if (n.s < 0 || n.s >= nStrings) continue;
            const dt = now - n.t;
            if (dt < 0 || dt >= IMPACT_DURATION) continue;

            const p = dt / IMPACT_DURATION;
            const ease = 1 - Math.pow(1 - p, 2);
            const y = yFor(n.s, H, nStrings);
            const color = colors[n.s] || FALLBACK_COLOR;

            const baseR = 14;
            const r = baseR * (1 + ease * 2.2);
            const alpha = (1 - p) * 0.85;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = color;
            ctx.lineWidth = 3 - ease * 2;
            ctx.shadowColor = color;
            ctx.shadowBlur = 18;
            ctx.beginPath();
            ctx.arc(hitX, y, r, 0, Math.PI * 2);
            ctx.stroke();

            if (p < 0.5) {
                ctx.globalAlpha = (1 - p * 2) * 0.6;
                ctx.strokeStyle = '#ffffff';
                ctx.shadowBlur = 10;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(hitX, y, baseR * (1 + ease * 1.2), 0, Math.PI * 2);
                ctx.stroke();
            }

            if (p < 0.3) {
                const flashAlpha = (1 - p / 0.3) * 0.7;
                ctx.shadowBlur = 0;
                ctx.globalAlpha = flashAlpha;
                const flashGrad = ctx.createLinearGradient(hitX - 80, 0, hitX + 80, 0);
                flashGrad.addColorStop(0, 'rgba(255, 255, 255, 0)');
                flashGrad.addColorStop(0.5, color);
                flashGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx.strokeStyle = flashGrad;
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(hitX - 80, y);
                ctx.lineTo(hitX + 80, y);
                ctx.stroke();
            }

            ctx.restore();
        }
    }

    function drawBends(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.notes.length) return;
        const { start, end } = binaryVisibleRange(state.notes, now);

        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '700 11px ' + MONO_STACK;

        for (let i = start; i < end; i++) {
            const n = state.notes[i];
            if (!n.bn || n.bn <= 0) continue;
            if (n.s < 0 || n.s >= nStrings) continue;

            const x = timeX(n.t, now, W);
            const y = yFor(n.s, H, nStrings);

            let alpha = 1;
            const dt = now - n.t;
            if (dt > 0) {
                alpha = 1 - (dt / FADE_SECONDS);
                if (alpha <= 0) continue;
            }

            const noteR = 14;
            const baseY = y - noteR - 2;
            const len = 14 + Math.min(12, n.bn * 6);
            const tipY = baseY - len;
            const headH = 5;
            const headW = 4;

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.shadowColor = '#ffd35a';
            ctx.shadowBlur = 8;
            ctx.strokeStyle = '#ffd35a';
            ctx.fillStyle = '#ffd35a';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';

            ctx.beginPath();
            ctx.moveTo(x, baseY);
            ctx.lineTo(x, tipY + headH);
            ctx.stroke();

            ctx.shadowBlur = 0;
            ctx.beginPath();
            ctx.moveTo(x, tipY);
            ctx.lineTo(x - headW, tipY + headH);
            ctx.lineTo(x + headW, tipY + headH);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = '#ffd35a';
            ctx.shadowColor = '#000000';
            ctx.shadowBlur = 3;
            ctx.fillText(bendText(n.bn), x + headW + 3, tipY + 4);

            ctx.restore();
        }
    }

    function drawNotes(ctx, state, W, H, nStrings, colors, now) {
        if (!state.ready || !state.notes.length) return;
        const { start, end } = binaryVisibleRange(state.notes, now);
        const hitX = W * HIT_LINE_FRAC;

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = start; i < end; i++) {
            const n = state.notes[i];
            if (n.s < 0 || n.s >= nStrings) continue;
            if (state.techPaired && state.techPaired.has(n)) continue;

            const x = timeX(n.t, now, W);
            const y = yFor(n.s, H, nStrings);
            const color = colors[n.s] || FALLBACK_COLOR;
            const R = clampByNeighbors(noteRadius(x, hitX, W), n, W);

            let alpha = 1;
            const dt = now - n.t;
            if (dt > 0) {
                alpha = 1 - (dt / FADE_SECONDS);
                if (alpha <= 0) continue;
            }

            ctx.save();
            ctx.globalAlpha = alpha;

            ctx.shadowColor = color;
            ctx.shadowBlur = 14;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, R, 0, Math.PI * 2);
            ctx.fill();

            ctx.shadowBlur = 0;
            const innerGrad = ctx.createRadialGradient(
                x - R * 0.3, y - R * 0.4, R * 0.1,
                x, y, R
            );
            innerGrad.addColorStop(0, 'rgba(255, 255, 255, 0.45)');
            innerGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
            innerGrad.addColorStop(1, 'rgba(0, 0, 0, 0.25)');
            ctx.fillStyle = innerGrad;
            ctx.beginPath();
            ctx.arc(x, y, R, 0, Math.PI * 2);
            ctx.fill();

            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.beginPath();
            ctx.arc(x, y, R, 0, Math.PI * 2);
            ctx.stroke();

            ctx.font = '800 ' + Math.round(R * 0.95) + 'px ' + MONO_STACK;
            ctx.fillStyle = '#0a0f1c';
            ctx.fillText(String(n.f), x, y + 1);
            ctx.restore();
        }
    }

    // Rounded-rect helper used by the chord-box renderer below.
    // Module-scope so the (ctx, state, ...) draw helpers can call it
    // without a closure dependency. Accepts a numeric radius
    // (uniform corners) or a {tl, tr, br, bl} object.
    function roundRect(ctx, x, y, width, height, radius) {
        if (typeof radius === 'undefined') radius = 5;
        if (typeof radius === 'number') radius = { tl: radius, tr: radius, br: radius, bl: radius };
        const { tl, tr, br, bl } = radius;
        ctx.beginPath();
        ctx.moveTo(x + tl, y);
        ctx.lineTo(x + width - tr, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + tr);
        ctx.lineTo(x + width, y + height - br);
        ctx.quadraticCurveTo(x + width, y + height, x + width - br, y + height);
        ctx.lineTo(x + bl, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - bl);
        ctx.lineTo(x, y + tl);
        ctx.quadraticCurveTo(x, y, x + tl, y);
        ctx.closePath();
    }

    // Resolve active string count from a plugin state object.
    // Prefer state.stringCount (populated from bundle.stringCount,
    // slopsmith#93) — the reliable signal computed server-side.
    // Fall back to tuning length (works for older sloppaks where
    // tuning arrays have been truncated by lib/song.py); fall back
    // to 6 (the canonical guitar count).
    //
    // The previous heuristic `state.tuning.length === 4 ? 4 : 6`
    // was broken for arrangement XML-sourced bass — arrangement XML always emits
    // length 6 regardless of instrument, so bass got rendered as
    // 6 strings with the upper 2 empty. The new server-side
    // signal handles all sources uniformly.
    //
    // Used by drawFrame for the tab-lane layout. (The chord-diagram box
    // sizes itself from the chord template's own frets.length instead, so
    // a short/long template can't index past its frets array.)
    function resolveStringCount(state) {
        return (typeof state.stringCount === 'number' && state.stringCount > 0)
            ? state.stringCount
            : (state.tuning && state.tuning.length > 0 ? state.tuning.length : 6);
    }

    // ── Top-left chord-diagram box ──────────────────────────────────
    // Ported verbatim from the 3D Highway plugin (feedBack-plugin-
    // highway-3d, drawChordDiagram) so the box reads identically in
    // both views. Pure 2D-canvas, no external deps — feed it the
    // current chord's { name, frets } plus canvas dimensions.

    // Prefer the authored display name, fall back to the raw template
    // name. Matches highway-3d's chordTemplateLabel.
    function chordTemplateLabel(tmpl) {
        if (!tmpl) return '';
        const d = tmpl.displayName;
        if (typeof d === 'string' && d.length > 0) return d;
        const n = tmpl.name;
        return typeof n === 'string' ? n : '';
    }

    // Longest run of consecutive integers in a sorted array — barre
    // detection helper for drawChordDiagram.
    function longestConsecutiveRun(sorted) {
        let bestStart = -1, bestLen = 0;
        let curStart = -1, curLen = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (curLen === 0 || sorted[i] === sorted[curStart + curLen - 1] + 1) {
                if (curLen === 0) curStart = i;
                curLen++;
            } else {
                if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
                curStart = i; curLen = 1;
            }
        }
        if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        return { start: bestStart, len: bestLen };
    }

    function drawChordDiagram(ctx, opts) {
        const {
            name, frets,
            opacity = 1,
            entranceT = 1.0,
            canvasW = 600, canvasH = 400,
            inverted = false,
            sizeSlider = 0.5,
            position = 'tl',
            nStr = 6,
            lyricsBottom = 0,
            stackOffset = 0,
        } = opts;

        // Responsive sizing — CELL derived from panel height + user slider.
        // COLS is the resolved string count from the caller (via resolveStringCount)
        // so bass (4), extended (7/8) arrangements render correctly.
        const COLS = nStr, ROWS = 4;
        // Minimum column span required for PATH B (bracket extension / detection).
        const MIN_BARRE_SPAN = Math.min(COLS - 1, 4);
        // Maps diagram column index → chord-template frets-array index.
        // FeedBack bundle templates are low-E-first: frets[0]=low E renders
        // in column 0 (leftmost) when inverted=false, i.e. the standard
        // chord-chart orientation. (The 3D Highway's original copy of this
        // function comments this the other way around, but consumes the
        // same bundle order with the same inverted flag, so both render
        // identically — verified against a named E5 template.)
        const getStrIdx = col => inverted ? (COLS - 1 - col) : col;
        const sizeF  = DIAG_SIZE_MIN + (DIAG_SIZE_MAX - DIAG_SIZE_MIN) * sizeSlider;

        // startFret / isFirstPos must be known before CELL so that fretLabelW
        // can be measured and factored into the width cap.
        const playedFrets = frets.filter(f => f > 0);
        const minFret     = playedFrets.length > 0 ? Math.min(...playedFrets) : 1;
        const startFret   = Math.max(1, minFret);
        const isFirstPos  = startFret === 1;

        // Phase 1 — height + hard-cap estimate, used only to size the label font.
        // Only top-corner positions can overlap the lyrics banner, so lyricsBottom
        // is only subtracted when position is 'tl' or 'tr'.
        const isTopCorner = position === 'tl' || position === 'tr';
        const availH  = canvasH - (isTopCorner ? lyricsBottom : 0);
        const cellEst = Math.max(1, Math.min(
            Math.round(availH * sizeF / (ROWS + 3)),
            DIAG_CELL_MAX,
        ));
        // Extra left padding for the "Nfr" label on non-first-position chords.
        let fretLabelW = 0;
        if (!isFirstPos) {
            ctx.save();
            ctx.font = `italic ${Math.round(cellEst * 0.55)}px sans-serif`;
            fretLabelW = Math.ceil(ctx.measureText(startFret + 'fr').width) + 6;
            ctx.restore();
        }

        // Phase 2 — final CELL: cap against panel height, hard max, and panel width.
        const CELL   = Math.max(1, Math.min(
            cellEst,
            Math.floor((canvasW - fretLabelW) / (COLS + 0.3)),
            Math.floor((canvasW - 2 * 6 - fretLabelW) / Math.max(1, COLS - 1)),
        ));
        const HEADER = Math.round(CELL * 1.6);
        const MARKER = Math.round(CELL * 0.7);
        const DOT_R  = CELL * 0.3;
        const PAD    = Math.max(6, Math.round(CELL * 0.65));
        const gridW  = CELL * (COLS - 1);
        const gridH  = CELL * ROWS;

        const PAD_L  = PAD + fretLabelW;

        const boxW   = gridW + PAD_L + PAD;
        const boxH   = HEADER + MARKER + gridH + PAD;

        // Anchor to chosen corner. Top positions get extra vertical offset
        // to clear the timeline plugin and song name displayed at the top.
        const E    = PAD;
        const TOP_Y = Math.round(Math.max(E + canvasH * 0.06, lyricsBottom + E));
        let bx, by;
        if      (position === 'tr') { bx = canvasW - boxW - E; by = TOP_Y + stackOffset; }
        else if (position === 'bl') { bx = E; by = canvasH - boxH - E - stackOffset; }
        else if (position === 'br') { bx = canvasW - boxW - E; by = canvasH - boxH - E - stackOffset; }
        else                        { bx = E; by = TOP_Y + stackOffset; }

        // Clamp so the box never bleeds off-canvas on narrow panels or wide string counts.
        bx = Math.max(0, Math.min(canvasW - boxW, bx));
        by = Math.max(0, Math.min(canvasH - boxH, by));

        // Guard: skip drawing rather than paint on top of the lyrics banner.
        if (lyricsBottom > 0 && by < lyricsBottom) return 0;

        const gx = bx + PAD_L, gy = by + HEADER + MARKER;

        // Ease-out quadratic entrance scale: 0.85 → 1.0.
        const scale = 1 - 0.15 * (1 - entranceT) * (1 - entranceT);

        ctx.save();
        ctx.globalAlpha = opacity;

        if (scale !== 1.0) {
            const cx = bx + boxW / 2, cy = by + boxH / 2;
            ctx.translate(cx, cy);
            ctx.scale(scale, scale);
            ctx.translate(-cx, -cy);
        }

        // Background + border. Route through the guarded roundRect helper
        // (some 2D contexts lack native ctx.roundRect) — this plugin's
        // convention, unlike the highway's unguarded native call.
        ctx.fillStyle = 'rgba(8, 14, 22, 0.88)';
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); }
        else { roundRect(ctx, bx, by, boxW, boxH, 7); }
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, boxW, boxH, 7); }
        else { roundRect(ctx, bx, by, boxW, boxH, 7); }
        ctx.stroke();

        // Split-root typography: "Dm7" → "D" large bold + "m7" smaller.
        const rootMatch = name.match(/^([A-G][#b]?)(.*)/);
        const root    = rootMatch ? rootMatch[1] : name;
        const quality = rootMatch ? rootMatch[2] : '';
        const rootSize = Math.round(CELL * 1.25);
        const qualSize = Math.round(rootSize * 0.65);
        ctx.textBaseline = 'middle';
        const nameY = by + HEADER * 0.55;
        ctx.font = `bold ${rootSize}px sans-serif`;
        const rootW = ctx.measureText(root).width;
        ctx.font = `${qualSize}px sans-serif`;
        const qualW = quality ? ctx.measureText(quality).width : 0;
        const nameBlockW = rootW + (quality ? qualW + 2 : 0);
        const nameStartX = bx + boxW / 2 - nameBlockW / 2;
        ctx.fillStyle = '#e8d080';
        ctx.font = `bold ${rootSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(root, nameStartX, nameY);
        if (quality) {
            ctx.font = `${qualSize}px sans-serif`;
            ctx.fillStyle = 'rgba(232,208,128,0.75)';
            ctx.fillText(quality, nameStartX + rootW + 2, nameY);
        }

        // Nut: CELL-proportional filled rect + subtle highlight line.
        const NUT_H = Math.round(Math.max(2, CELL * 0.4));
        if (isFirstPos) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(gx, gy - NUT_H, gridW, NUT_H);
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.fillRect(gx, gy - NUT_H, gridW, Math.max(1, Math.round(NUT_H * 0.25)));
        }

        // Fret label for non-first-position chords.
        if (!isFirstPos) {
            ctx.fillStyle = 'rgba(220,200,120,0.9)';
            ctx.font = `italic ${Math.round(CELL * 0.55)}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(startFret + 'fr', gx - 4, gy + CELL * 0.5);
        }

        // Fret lines.
        ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
        for (let r = (isFirstPos ? 1 : 0); r <= ROWS; r++) {
            ctx.beginPath();
            ctx.moveTo(gx, gy + r * CELL);
            ctx.lineTo(gx + gridW, gy + r * CELL);
            ctx.stroke();
        }

        // String lines with varying weight: low E heavier, high e lighter.
        for (let col = 0; col < COLS; col++) {
            const strIdx = getStrIdx(col);
            const t = COLS > 1 ? strIdx / (COLS - 1) : 1;  // 1=low E (thick), 0=high e (thin); guard COLS=1
            ctx.lineWidth = Math.max(0.5, CELL * (0.05 + t * 0.10));
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.beginPath();
            ctx.moveTo(gx + col * CELL, gy);
            ctx.lineTo(gx + col * CELL, gy + ROWS * CELL);
            ctx.stroke();
        }

        // Barre detection — two complementary paths (PATH A: adjacent mini-barre,
        // PATH B: full-span / outer-edge barre). Templates are high-e-first.
        const startFretCols = [];
        for (let col = 0; col < COLS; col++) {
            if (frets[getStrIdx(col)] === startFret) startFretCols.push(col);
        }
        const barreRun = longestConsecutiveRun(startFretCols);
        let hasBarreArc = barreRun.len >= 2;   // PATH A
        let barreMinCol = hasBarreArc ? startFretCols[barreRun.start] : -1;
        let barreMaxCol = hasBarreArc ? startFretCols[barreRun.start + barreRun.len - 1] : -1;

        if (startFretCols.length >= 2) {             // PATH B
            const minC = startFretCols[0];
            const maxC = startFretCols[startFretCols.length - 1];
            if (maxC - minC >= MIN_BARRE_SPAN) {
                let allFretted = true;
                for (let col = minC; col <= maxC; col++) {
                    if (frets[getStrIdx(col)] <= 0) { allFretted = false; break; }
                }
                if (allFretted) {
                    if (hasBarreArc) {
                        barreMinCol = minC;
                        barreMaxCol = maxC;
                    } else {
                        let noInnerAtStartFret = true;
                        for (let col = minC + 1; col < maxC; col++) {
                            if (frets[getStrIdx(col)] === startFret) { noInnerAtStartFret = false; break; }
                        }
                        if (noInnerAtStartFret) {
                            hasBarreArc = true;
                            barreMinCol = minC;
                            barreMaxCol = maxC;
                        }
                    }
                }
            }
        }
        if (hasBarreArc) {
            const barreY   = gy + CELL * 0.5;
            const capH     = CELL * 0.22;  // vertical offset from barreY to the bracket line
            const capHalf  = Math.max(1, Math.round(CELL * 0.3)); // half-height of the vertical end caps
            ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = Math.max(1, CELL * 0.2);
            ctx.beginPath();
            ctx.moveTo(gx + barreMinCol * CELL, barreY - capH);
            ctx.lineTo(gx + barreMaxCol * CELL, barreY - capH);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(gx + barreMinCol * CELL, barreY - capH - capHalf);
            ctx.lineTo(gx + barreMinCol * CELL, barreY - capH + capHalf);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(gx + barreMaxCol * CELL, barreY - capH - capHalf);
            ctx.lineTo(gx + barreMaxCol * CELL, barreY - capH + capHalf);
            ctx.stroke();
        }

        // Open/muted markers + finger dots.
        for (let col = 0; col < COLS; col++) {
            const f = frets[getStrIdx(col)];
            const sx = gx + col * CELL;
            const markerY = gy - MARKER * 0.5;
            if (f < 0) {
                const r = CELL * 0.20;
                ctx.strokeStyle = '#cc4444'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(sx - r, markerY - r); ctx.lineTo(sx + r, markerY + r); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(sx + r, markerY - r); ctx.lineTo(sx - r, markerY + r); ctx.stroke();
            } else if (f === 0) {
                ctx.strokeStyle = '#88bbff'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(sx, markerY, CELL * 0.22, 0, Math.PI * 2); ctx.stroke();
            } else {
                const row = f - startFret;
                if (row >= 0 && row < ROWS) {
                    const isBarreCol = hasBarreArc && f === startFret &&
                                       col >= barreMinCol && col <= barreMaxCol;
                    ctx.shadowColor = 'rgba(0,0,0,0.5)';
                    ctx.shadowBlur = Math.min(4, CELL * 0.4);
                    ctx.shadowOffsetX = Math.max(0.5, CELL * 0.1);
                    ctx.shadowOffsetY = Math.max(0.5, CELL * 0.1);
                    ctx.fillStyle = isBarreCol ? 'rgba(255,255,255,0.85)' : '#ffffff';
                    ctx.beginPath();
                    ctx.arc(sx, gy + row * CELL + CELL * 0.5, DOT_R, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
                    ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                }
            }
        }
        ctx.restore();
        return boxH;
    }

    // Draw the current chord's fingering as a compact top-left box on the
    // note canvas (matches the 3D Highway). The current chord is the most
    // recent chord event whose t <= now (state.chords is core-sorted by t);
    // placeholder ("Chord N") and all-muted templates are skipped, same
    // guard the old chord band used.
    function drawCurrentChordBox(ctx, state, W, H, now) {
        // Gate on state.ready like every other draw helper — during a
        // song-change loading window the tab is blank (note helpers bail on
        // !ready); without this the box would float over an empty tab.
        if (!state.ready) return;
        if (!state.chords || !state.chords.length) return;
        if (!state.chordTemplates || !state.chordTemplates.length) return;
        // Binary search for the last chord event with t <= now (state.chords
        // is core-sorted by t) — O(log n), vs an O(n) scan from the start
        // every frame on long charts.
        let lo = 0, hi = state.chords.length;   // lo lands on first index with t > now
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (state.chords[m].t <= now) lo = m + 1; else hi = m;
        }
        if (lo === 0) return;                    // no chord at/before now
        const cur = state.chords[lo - 1];
        const tmpl = state.chordTemplates[cur.id];
        if (!tmpl || !Array.isArray(tmpl.frets) || !tmpl.frets.length) return;
        const name = chordTemplateLabel(tmpl);
        if (!name || name.startsWith('Chord ')) return;
        if (tmpl.frets.every(f => f === -1 || f === null || f === undefined)) return;
        drawChordDiagram(ctx, {
            name,
            frets: tmpl.frets,
            // Column count comes from the template itself (frets[i] = string i,
            // low-E-first) so a template shorter/longer than the resolved
            // instrument string count never indexes past the frets array.
            nStr: tmpl.frets.length,
            inverted: false,      // frets are low-E-first → low E on the left (standard chart), matches highway
            position: 'tl',
            sizeSlider: 0.5,
            canvasW: W,
            canvasH: H,
            lyricsBottom: HEADER_H, // clear jumpingtab's title/artist strip
            stackOffset: 0,
        });
    }

    function drawFrame(ctx, state, canvas, now) {
        if (!ctx || !canvas) return;
        const W = canvas.clientWidth;
        const H = canvas.clientHeight;
        if (W === 0 || H === 0) return;
        const nStrings = resolveStringCount(state);
        const colors = colorsFor(nStrings);

        drawBackground(ctx, state, W, H, nStrings, colors, now);
        drawSustains(ctx, state, W, H, nStrings, colors, now);
        // drawArcs (dashed trajectory curves) intentionally omitted —
        // the ball still hops along state.arcs; we just don't
        // visualize the path.
        drawTechniquePairs(ctx, state, W, H, nStrings, colors, now);
        drawTechniqueArcs(ctx, state, W, H, nStrings, colors, now);
        drawNotes(ctx, state, W, H, nStrings, colors, now);
        drawBends(ctx, state, W, H, nStrings, colors, now);
        drawImpacts(ctx, state, W, H, nStrings, colors, now);
        drawBall(ctx, state, W, H, nStrings, colors, now);
        drawEdgeFade(ctx, W, H);
        drawHeader(ctx, state, W, H, now);
        drawProgress(ctx, state, W, H, now);
        // Current-chord fingering box, top-left (ported from 3D Highway).
        drawCurrentChordBox(ctx, state, W, H, now);
    }

    // ── Pure-helper exports for the test harness ────────────────────
    //
    // Surface is intentionally broad. These are all stateless and the
    // test harness can exercise any subset; keeping the export aligned
    // with the full pure-helper layer (rather than a hand-picked few)
    // means a new test that wants e.g. clampByNeighbors or
    // findActiveArc doesn't require a plugin-side patch.
    window.__jumpingtab_core = {
        stringY, yFor, colorsFor, timeX,
        binaryVisibleRange, buildTrajectories, buildTechniqueArcs,
        bezierPoint, noteRadius, secondsToPx, clampByNeighbors,
        arcControlPoint, findActiveArc, nearestNoteAtHit,
        currentSection, bendText,
        AHEAD, BEHIND, HIT_LINE_FRAC, FADE_SECONDS, IMPACT_DURATION,
        SQUASH_WINDOW_MS, NOTE_BASE_R, NOTE_MAX_R, MIN_NOTE_R,
    };

    // ── Demo / test-harness scaffolding ─────────────────────────────
    //
    // The standalone demo/ HTML binds a canvas, sets synthetic state,
    // and calls drawFrame directly to generate README screenshots
    // without running slopsmith. Wave C keeps this exact API working
    // by giving the demo its own module-scope state + canvas / ctx
    // refs — separate from any factory instance — so demo invocations
    // never clobber per-instance state.

    const _demoState = _newState();
    let _demoCanvas = null;
    let _demoCtx = null;

    window.__jumpingtab_state = _demoState;
    window.__jumpingtab_demo = {
        setCanvas(cnv) {
            // getContext('2d') can return null when the browser has
            // locked this canvas to a different context type or 2D
            // is disabled for the origin. Mirror mountCanvas's
            // production guard: warn + bail rather than throwing on
            // the .setTransform below, which would leave the demo
            // harness in a half-initialised state (canvas captured
            // but no usable ctx) and break test.html silently.
            const ctx2d = cnv.getContext('2d');
            if (!ctx2d) {
                console.warn('[jumpingtab] demo.setCanvas: getContext("2d") returned null; aborting');
                return false;
            }
            _demoCanvas = cnv;
            _demoCtx = ctx2d;
            const dpr = window.devicePixelRatio || 1;
            const rect = cnv.getBoundingClientRect();
            cnv.width = Math.max(1, Math.floor(rect.width * dpr));
            cnv.height = Math.max(1, Math.floor(rect.height * dpr));
            _demoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            return true;
        },
        setState(patch) { Object.assign(_demoState, patch); },
        finalizeState() {
            _demoState.notes.sort((a, b) => a.t - b.t);
            const lastIdxByString = new Map();
            const EPS_T = 1e-4;
            for (let i = 0; i < _demoState.notes.length; i++) {
                const n = _demoState.notes[i];
                n._gapL = Infinity;
                n._gapR = Infinity;
                const prevIdx = lastIdxByString.get(n.s);
                if (prevIdx != null) {
                    const prev = _demoState.notes[prevIdx];
                    const gap = n.t - prev.t;
                    if (gap > EPS_T) {
                        n._gapL = gap;
                        if (gap < prev._gapR) prev._gapR = gap;
                    }
                }
                lastIdxByString.set(n.s, i);
            }
            _demoState.arcs = buildTrajectories(_demoState.notes);
            const tech = buildTechniqueArcs(_demoState.notes);
            _demoState.techArcs = tech.arcs;
            _demoState.techPaired = tech.paired;
            _demoState.ready = true;
        },
        drawFrame(now) {
            drawFrame(_demoCtx, _demoState, _demoCanvas, now);
        },
    };

    // ── Per-instance counter for DOM tagging ────────────────────────
    let _nextInstanceId = 0;

    // ═══════════════════════════════════════════════════════════════════════
    // Factory — slopsmith#36 setRenderer contract (multi-instance)
    // ═══════════════════════════════════════════════════════════════════════

    function createFactory() {
        const _instanceId = ++_nextInstanceId;

        // Lifecycle
        let _isReady = false;

        // Per-instance chart cache. Each panel under splitscreen
        // builds its own — even when N panels render the same song,
        // a panel's filtered notes (master-difficulty per panel) and
        // arrangement choice can differ, and trajectory arcs must
        // mirror what's actually visible.
        const state = _newState();

        // Reference-identity sentinels for cache invalidation. Core
        // creates a new array whenever the filtered chart rebuilds
        // (new song, arrangement change, master-difficulty flip
        // changing _filteredNotes), so reference-compare is a cheap,
        // reliable signal that we must rebuild trajectories + gaps.
        let _lastNotesRef = null;
        let _lastChordsRef = null;
        // Most-recent draw timestamp — paired with _hasDrawnFrame so
        // the post-fonts callback can force a redraw when the host
        // happens to be paused at the moment webfonts finish loading.
        // Without this, the next draw() naturally picks up the loaded
        // face, but a paused player would sit on a fallback-font
        // frame indefinitely. Cleared in _teardown() so a late
        // font-ready callback can't replay a stale frame from a
        // previous lifecycle. We deliberately do NOT retain the
        // bundle reference itself — draw() copies the parts we need
        // into `state`, and holding the bundle would pin per-frame
        // host allocations across pauses.
        let _hasDrawnFrame = false;
        let _lastNow = 0;

        // Per-init generation token. The whenFontsReady().then(...) in
        // init() races with destroy() / re-init() — if the user picks
        // another viz before the Google Fonts CSS resolves, a stale
        // callback could repaint a torn-down or re-initialised instance.
        // Each init() bumps _lifecycleGen; the callback captures the
        // value at registration time and bails when it diverges.
        let _lifecycleGen = 0;

        // Rendering / DOM state — one set per panel.
        let canvas = null;
        let wrap = null;
        let ctx = null;
        let highwayCanvas = null;

        // ── Listener refs (per-instance so detach matches attach) ──
        const _onWinResize = () => sizeCanvasToBox();
        // Host event-bus handlers (slopsmith#246 visibility contract).
        // Bound in mountCanvas, unbound in unmountCanvas — see
        // _bindVisibilityListeners for why we listen at all.
        let _visibilityHandler = null;
        let _canvasReplacedHandler = null;

        function sizeCanvasToBox() {
            if (!canvas || !ctx) return;
            // The wrap is position:absolute, so it has no geometry of
            // its own — anchor it directly over the #highway canvas.
            // Called on mount, resize events, and visibility changes
            // (not per-frame). Coordinates are computed relative to the
            // wrap's offsetParent (nearest positioned ancestor) so the
            // overlay stays pixel-exact even when #highway is not at
            // the parent's top-left or not full width — e.g. a
            // splitscreen panel rather than the main player.
            if (wrap && highwayCanvas) {
                const hwRect = highwayCanvas.getBoundingClientRect();
                if (hwRect.width > 0 && hwRect.height > 0) {
                    const op = wrap.offsetParent || wrap.parentNode;
                    const opRect = op && op.getBoundingClientRect
                        ? op.getBoundingClientRect()
                        : { left: 0, top: 0 };
                    wrap.style.left = (hwRect.left - opRect.left) + 'px';
                    wrap.style.top = (hwRect.top - opRect.top) + 'px';
                    wrap.style.width = hwRect.width + 'px';
                    wrap.style.height = hwRect.height + 'px';
                }
            }
            const dpr = window.devicePixelRatio || 1;

            const rect = canvas.getBoundingClientRect();
            const pxW = Math.max(1, Math.floor(rect.width * dpr));
            const pxH = Math.max(1, Math.floor(rect.height * dpr));
            if (canvas.width !== pxW || canvas.height !== pxH) {
                canvas.width = pxW;
                canvas.height = pxH;
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // Returns true when highwayCanvas is in the document layout
        // (offsetParent !== null). Used to sync the wrap's display
        // state on canvas-replaced events and on initial mount.
        function _isHighwayVisible() {
            return !!(highwayCanvas && highwayCanvas.offsetParent !== null);
        }

        // Subscribe to the host's highway:visibility / canvas-replaced
        // events — the contract the 3D Highway plugin uses. Earlier
        // versions of this plugin hid #highway with display:none and
        // drew onto an overlay. The host's draw loop now skips
        // _renderer.draw() whenever #highway has offsetParent === null
        // (slopsmith#246) — so hiding #highway starved this plugin's
        // own draw() callback and the overlay never painted (black
        // screen). We now leave #highway in layout and overlay it; the
        // visibility event drives OUR wrap's show/hide instead, so a
        // splitscreen-driven hide of #highway still hides us in sync.
        function _bindVisibilityListeners() {
            if (!window.slopsmith
                || typeof window.slopsmith.on !== 'function'
                || typeof window.slopsmith.off !== 'function') {
                return;
            }
            _visibilityHandler = (e) => {
                if (!wrap) return;
                // Identity-gate on our own canvas: every createHighway()
                // instance emits on the shared bus, so an unfiltered
                // handler would let one splitscreen panel hide another.
                if (!e || !e.detail || e.detail.canvas !== highwayCanvas) return;
                const visible = e.detail.visible !== false;
                wrap.style.display = visible ? 'flex' : 'none';
                if (visible) sizeCanvasToBox();
            };
            _canvasReplacedHandler = (e) => {
                // Core swapped the <canvas> for a context-type change.
                // Re-point highwayCanvas so the visibility handler's
                // identity gate keeps matching and sizing stays correct.
                if (!e || !e.detail || e.detail.oldCanvas !== highwayCanvas) return;
                highwayCanvas = e.detail.newCanvas;
                if (wrap) {
                    const visible = _isHighwayVisible();
                    wrap.style.display = visible ? 'flex' : 'none';
                    if (visible) sizeCanvasToBox();
                }
            };
            try { window.slopsmith.on('highway:visibility', _visibilityHandler); }
            catch (e) { _visibilityHandler = null; }
            try { window.slopsmith.on('highway:canvas-replaced', _canvasReplacedHandler); }
            catch (e) { _canvasReplacedHandler = null; }
            // highway:visibility is transition-only: if #highway was
            // already hidden when we mounted (plugin selected while a
            // splitscreen panel owns the screen) no emit would arrive.
            // Sync once from the canvas's current displayed state.
            if (_visibilityHandler && wrap) {
                const visible = _isHighwayVisible();
                wrap.style.display = visible ? 'flex' : 'none';
            }
        }

        function _unbindVisibilityListeners() {
            if (window.slopsmith && typeof window.slopsmith.off === 'function') {
                if (_visibilityHandler) {
                    try { window.slopsmith.off('highway:visibility', _visibilityHandler); }
                    catch (e) { /* host teardown race — ignore */ }
                }
                if (_canvasReplacedHandler) {
                    try { window.slopsmith.off('highway:canvas-replaced', _canvasReplacedHandler); }
                    catch (e) { /* host teardown race — ignore */ }
                }
            }
            _visibilityHandler = null;
            _canvasReplacedHandler = null;
        }

        function mountCanvas(providedHighwayCanvas) {
            // We anchor our wrap via
            // providedHighwayCanvas.insertAdjacentElement('afterend', ...),
            // so the only DOM dependency is a canvas with a connected
            // parent. The prior `#player` lookup was never actually used
            // below and made init() fail in environments where the
            // enclosing container has a different id (splitscreen panels,
            // tests, hosts that rename the shell).
            if (!providedHighwayCanvas || !providedHighwayCanvas.parentNode) return false;

            wrap = document.createElement('div');
            // Per-instance id so N splitscreen panels don't collide
            // on getElementById lookups. Class kept alongside for any
            // plugin-wide CSS that might want to target every wrap.
            wrap.id = 'jumpingtab-wrap-' + _instanceId;
            wrap.className = 'jumpingtab-wrap';
            wrap.dataset.jumpingtabInstance = String(_instanceId);
            // position:absolute overlay anchored over the #highway
            // canvas — the 3D Highway plugin's pattern. Two hard
            // constraints drive this: (1) we must NOT take flex space
            // (a flex:1 sibling would split the row with #highway);
            // (2) we must NOT display:none #highway, because the host
            // skips _renderer.draw() whenever #highway has
            // offsetParent === null (slopsmith#246) and would starve
            // our own draw(). So #highway stays in layout, we overlay
            // it, and sizeCanvasToBox() anchors our box to it.
            // The opaque background hides whatever #highway shows behind
            // the side padding. A single full-height note canvas fills
            // the wrap; the current chord's fingering is painted as a
            // compact box in the top-left corner (the 3D Highway's
            // drawChordDiagram), overlaid on the tab.
            wrap.style.cssText = [
                'position:absolute',
                'top:0',
                'left:0',
                'z-index:2',
                'min-height:0',
                'display:flex',
                'flex-direction:column',   // main axis = vertical so the note canvas's flex:1 fills height
                'align-items:stretch',
                'padding:0 24px',
                'background:#050508',
                'pointer-events:none',
            ].join(';');

            canvas = document.createElement('canvas');
            canvas.id = 'jumpingtab-canvas-' + _instanceId;
            canvas.className = 'jumpingtab-canvas';
            canvas.dataset.jumpingtabInstance = String(_instanceId);
            canvas.style.cssText = [
                'width:100%',
                'flex:1',
                'min-height:0',
                'display:block',
                'background:#0f1420',
                'border-radius:10px',
                'box-shadow:0 8px 24px rgba(0,0,0,0.4)',
            ].join(';');

            wrap.appendChild(canvas);
            providedHighwayCanvas.insertAdjacentElement('afterend', wrap);
            ctx = canvas.getContext('2d');
            if (!ctx) {
                // getContext('2d') can return null when the browser has
                // locked this canvas element to a different context type,
                // or when 2D support is disabled for the origin. Without
                // this guard init() would flip _isReady=true and drawFrame
                // would no-op against the null ctx every rAF. Tear the
                // overlay down and signal failure up to init() so the host
                // reverts to the built-in highway — which is still visible
                // since we never hide it.
                console.warn('[jumpingtab] mountCanvas: note getContext("2d") returned null; aborting');
                wrap.remove();
                wrap = null;
                canvas = null;
                return false;
            }

            highwayCanvas = providedHighwayCanvas;
            _bindVisibilityListeners();
            sizeCanvasToBox();
            return true;
        }

        function unmountCanvas() {
            _unbindVisibilityListeners();
            if (wrap) {
                wrap.remove();
                wrap = null;
                canvas = null;
                ctx = null;
            }
            // #highway was never hidden (we overlay it, not replace it),
            // so there's nothing to restore — just drop the reference.
            highwayCanvas = null;
        }

        function _teardown() {
            unmountCanvas();
            _clearChart(state);
            _lastNotesRef = null;
            _lastChordsRef = null;
            // Drop the last-frame cache so a font-ready callback that
            // fires after teardown can't repaint stale content if a
            // subsequent init() re-uses this factory before the next
            // host draw() arrives.
            _hasDrawnFrame = false;
            _lastNow = 0;
            // Invalidate any in-flight font-ready callbacks tied to
            // the lifecycle we're tearing down.
            _lifecycleGen++;
        }

        return {
            init(providedCanvas /* , bundle */) {
                // Defensive teardown mirrors destroy() exactly. If we
                // skipped the window.resize listener removal a double
                // init() would leak a second listener; every resize
                // would fire sizeCanvasToBox twice. _teardown() →
                // unmountCanvas() also unbinds the highway:visibility /
                // canvas-replaced listeners, so a re-init won't leak
                // host event-bus handlers either.
                if (wrap || _isReady) {
                    window.removeEventListener('resize', _onWinResize);
                    _teardown();
                    _isReady = false;
                } else {
                    _clearChart(state);
                    _lastNotesRef = null;
                    _lastChordsRef = null;
                }
                if (!mountCanvas(providedCanvas)) {
                    console.warn('[jumpingtab] init: failed to mount overlay canvas');
                    return;
                }
                ensureFonts();
                window.addEventListener('resize', _onWinResize);
                _isReady = true;
                _lifecycleGen++;
                // Force a repaint once webfonts arrive so the next
                // visible frame uses JetBrains Mono / Inter rather
                // than the generic fallback canvas captured during
                // init. When the host's rAF loop is running this is a
                // belt-and-suspenders no-op (the next host-driven
                // draw() naturally picks up the loaded face); when
                // the player is paused at the moment fonts resolve,
                // this is the only call that swaps the displayed
                // frame off of the fallback. The captured `gen`
                // guards against the user picking another viz
                // mid-fontload — _teardown() bumps _lifecycleGen so
                // the stale callback bails before touching the
                // (possibly re-initialised) instance state.
                const gen = _lifecycleGen;
                whenFontsReady().then(() => {
                    if (gen !== _lifecycleGen) return;
                    if (!_isReady || !ctx || !canvas) return;
                    sizeCanvasToBox();
                    // Replay the last frame the host gave us. If
                    // none has arrived yet, the next host draw()
                    // will paint with the loaded font anyway.
                    if (_hasDrawnFrame) {
                        drawFrame(ctx, state, canvas, _lastNow);
                    }
                });
            },
            draw(bundle) {
                if (!_isReady || !ctx || !canvas || !bundle) return;

                // Pick up metadata cheaply each frame. Mutate the
                // existing state.songInfo object instead of
                // allocating a fresh one every frame — at 60fps
                // that's 60 short-lived metadata objects per second
                // of GC churn. Draw code only reads the four named
                // fields below; nothing holds a reference to a
                // specific per-frame snapshot.
                const info = bundle.songInfo || {};
                const si = state.songInfo || (state.songInfo = {});
                si.title = info.title || '';
                si.artist = info.artist || '';
                si.arrangement = info.arrangement || '';
                si.duration = info.duration || 0;
                // Always overwrite tuning, even when info.tuning is
                // missing. Without this reset, a bass song's 4-string
                // tuning from the previous arrangement would linger
                // into a guitar arrangement whose bundle omitted the
                // field, and drawFrame's nStrings check would still
                // return 4. null is harmless — nStrings falls back
                // to the guitar (6) default.
                state.tuning = Array.isArray(info.tuning) ? info.tuning : null;
                // Active string count from slopsmith core
                // (slopsmith#93). Always overwrite — nullish during
                // a between-songs window forces drawFrame to fall
                // back to tuning length / 6 instead of carrying a
                // previous song's stale value.
                state.stringCount = (typeof bundle.stringCount === 'number' &&
                                     bundle.stringCount > 0)
                    ? bundle.stringCount
                    : null;

                // Beats / sections track bundle references (same
                // identity-swap semantics as notes / chords). Always
                // overwrite rather than conditionally assign so a
                // bundle that omits or nulls either field during a
                // song-change loading window can't leave the PREVIOUS
                // song's timing grid visible in the background —
                // drawBackground would happily render last song's
                // measure lines / section bands against the new
                // song's notes otherwise.
                state.beats = Array.isArray(bundle.beats) ? bundle.beats : [];
                state.sections = Array.isArray(bundle.sections) ? bundle.sections : [];
                // Chord events + templates for the top-left chord-
                // diagram box. The note-tab renderer doesn't need
                // these — _rebuildChart flattens chord notes into
                // state.notes — but the box reads the raw chord
                // events to find the current chord. Always overwrite
                // (matches the beats/sections pattern above) so a
                // song-change loading window doesn't leave the
                // previous song's chord shape in the box.
                state.chords = Array.isArray(bundle.chords) ? bundle.chords : [];
                state.chordTemplates = Array.isArray(bundle.chordTemplates)
                    ? bundle.chordTemplates : [];

                // Rebuild trajectories only when the underlying
                // chart arrays changed — either new song / arrangement
                // or a master-difficulty swap in slopsmith core's
                // _filteredNotes. Reference equality is enough
                // because core reassigns (not mutates) on every
                // filter rebuild.
                if (bundle.notes !== _lastNotesRef || bundle.chords !== _lastChordsRef) {
                    _lastNotesRef = bundle.notes;
                    _lastChordsRef = bundle.chords;
                    _rebuildChart(state, bundle.notes, bundle.chords);
                }

                const now = bundle.currentTime || 0;
                _hasDrawnFrame = true;
                _lastNow = now;
                drawFrame(ctx, state, canvas, now);
            },
            resize(/* w, h */) {
                // Size from the canvas's own bounding rect — the w/h
                // that highway.js hands over are scaled by its own
                // render-scale for the renderer that owns the given
                // #highway canvas, not our overlay.
                if (!_isReady) return;
                sizeCanvasToBox();
            },
            destroy() {
                _isReady = false;
                window.removeEventListener('resize', _onWinResize);
                _teardown();
            },
        };
    }

    window.slopsmithViz_jumpingtab = createFactory;
    // slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
    window.feedBackViz_jumpingtab = window.slopsmithViz_jumpingtab;

    // ensureFonts() runs inside init() rather than at module scope so
    // we don't make an unconditional fonts.googleapis.com request when
    // the user never picks this viz (or when the script is loaded by
    // a test harness with no canvas). The whenFontsReady() chain in
    // init() handles the slightly later fetch latency by replaying
    // the last frame once weights resolve.

    console.log('[jumpingtab] plugin loaded (viz mode)');
})();
