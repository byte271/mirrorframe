// Mirrorframe — Capture Substrate + Retina/Chronograph/Signal-Trace probes.
// Real tools: Playwright (Chromium), computed styles, WAAPI/getAnimations,
// MutationObserver (scroll reveals), and a synthetic-click interaction probe
// that recovers class-toggle state machines (accordion/tabs/modal/...).
// This does NOT reverse-engineer WebGL/shaders/physics — out-of-scope media
// are detected, recorded with a fixed skip reason, and masked from
// verification. See references/limitations.md and references/roadmap.md.
//
// Robustness contract (v0.1.2): every phase is bounded. Navigation has a
// timeout with a domcontentloaded fallback; the interaction probe has a time
// budget and candidate cap; node capture has a scale cap. Nothing is silently
// dropped: every skip carries a reason from scripts/lib/reasons.js.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PROPS } = require('./props');
const { REASONS, MfSkip } = require('./reasons');
const { AssetStore, fetchInto, cssUrls, parseFontFaces, bestFontUrl } = require('./assets');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const DEFAULTS = {
  navTimeoutMs: 30000,   // per navigation attempt (networkidle, then domcontentloaded fallback)
  probeBudgetMs: 60000,  // interaction-probe wall-clock budget
  maxCandidates: 200,    // interaction-probe candidate cap
  maxNodes: 1500,        // captured-node scale cap
  ambientWatchMs: 1500,  // input-free window to detect timer-driven class mutations
  scrollSteps: 16,       // frame-by-frame scroll sweep resolution
  scrollSettleMs: 250,   // per-step settle (smooth-scroll libs lag scrollY)
  scrollCheckpoints: [0.25, 0.5, 0.75], // ground-truth screenshots for scroll-state verification
  maxScrollTracks: 1200, // per-node scroll-track cap (memory bound)
  hoverBudgetMs: 30000,  // hover-probe wall-clock budget
  cursorSamples: 9,      // mousemove positions (3x3 grid) for pointer-choreography recovery
  cursorSettleMs: 500,   // per-position settle so lag-smoothed followers reach their target
  pointerLagMs: 900,     // response-sampling window for smoothing time-constant recovery
  pointerCheckpoints: [[0.3, 0.35], [0.75, 0.65]], // ground-truth pointer-state shots
  settleMaxMs: 15000,    // intro-animation settle budget before style extraction
  settleIntervalMs: 700, // gap between consecutive settle screenshots
  settleThreshold: 0.005,// max changed-pixel ratio between frames to call it settled
  frameSampleMs: 2400,   // rAF frame-sampling window for time-driven motion
  maxFrameTracks: 120,   // per-page frame-track cap (memory bound)
  focusBudgetMs: 20000,  // focus-probe wall-clock budget (v0.4)
  focusCheckpoints: 3,   // ground-truth Tab-stop screenshots for focus-state verification
  breakpoints: [],       // extra viewport widths to re-capture (v0.4, --breakpoints)
  breakpointSettleMs: 800, // settle after a viewport resize before re-reading styles
};

// Pages with intro/loader animations (theme flips, translated wrappers) must
// not have their styles extracted mid-animation: wait until two consecutive
// viewport screenshots are near-identical, bounded by settleMaxMs.
async function waitForVisualSettle(page, cfg) {
  const deadline = Date.now() + cfg.settleMaxMs;
  let prev = null;
  while (Date.now() < deadline) {
    let buf;
    try { buf = await page.screenshot({ timeout: 5000 }); } catch (e) { return false; }
    if (prev) {
      try {
        const a = PNG.sync.read(prev), b = PNG.sync.read(buf);
        if (a.width === b.width && a.height === b.height) {
          const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
          if (diff / (a.width * a.height) <= cfg.settleThreshold) return true;
        }
      } catch (e) { return false; }
    }
    prev = buf;
    await page.waitForTimeout(cfg.settleIntervalMs);
  }
  return false;
}

// Derive per-node scroll tracks from sweep snapshots: a track is (id, prop)
// whose value changes across scroll positions. Numeric props (opacity,
// matrix transforms) are interpolated at replay time; others step.
// postSnap: same shape as a sweep snapshot, taken back at scroll 0 AFTER the
// sweep. A (id, prop) that fired ONCE during the sweep, held that value for
// the rest of it, and still holds it at scroll 0 is a one-way reveal
// (IntersectionObserver-style) — recorded as a persistent final value. A
// value that keeps varying sample-to-sample is scroll-linked (possibly with
// spring hysteresis, so its scroll-0 value need not equal the initial one)
// and keeps its sample track for the replay runtime.
function deriveScrollTracks(samples, maxTracks, postSnap) {
  // samples: [{ y, snap: { id: [transform, opacity, clipPath, filter] } }]
  const propNames = ['transform', 'opacity', 'clipPath', 'filter'];
  const tracks = [];
  if (!samples.length) return tracks;
  const ids = Object.keys(samples[0].snap);
  for (const id of ids) {
    for (let pi = 0; pi < propNames.length; pi++) {
      const vals = samples.map(s => (s.snap[id] || [])[pi]);
      if (vals.some(v => v !== vals[0])) {
        if (tracks.length >= maxTracks) return tracks;
        const post = postSnap && postSnap[id] ? postSnap[id][pi] : undefined;
        const fireIdx = vals.findIndex(v => v !== vals[0]);
        const heldAfterFiring = vals.slice(fireIdx).every(v => v === vals[fireIdx]);
        if (post !== undefined && post !== vals[0] &&
            heldAfterFiring && post === vals[vals.length - 1]) {
          tracks.push({ id, prop: propNames[pi], persistent: true, value: post });
        } else {
          const pts = samples.map((s, i) => [s.y, vals[i]]);
          // The settled scroll-0 value (post-sweep, glide finished) is the
          // ground truth at y=0 — the sweep's own first sample may predate
          // the fired state or hold spring residue.
          if (post !== undefined && pts.length && pts[0][0] === 0) pts[0][1] = post;
          tracks.push({ id, prop: propNames[pi], samples: pts });
        }
      }
    }
  }
  return tracks;
}

// Pointer-choreography recovery: parse the full transform matrix at every
// sampled mouse position and fit EACH matrix component as a plane over the
// pointer, v = a*mx + b*my + c (2-variable least squares). This recovers not
// just linear followers (translate parallax) but tilt cards (rotateX/rotateY
// components of matrix3d), pointer-driven scale, and magnetic offsets — any
// choreography whose matrix components respond linearly to pointer position.
// Nodes that move with the mouse but fit NO planar model are unclassifiable
// pointer physics — recorded with the fixed unclassified reason, never guessed.
const IDENT4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function parseMatrix(t) {
  if (!t || t === 'none') return { kind: 'none', nums: null };
  const m = /^matrix\(([^)]+)\)$/.exec(t);
  if (m) {
    const p = m[1].split(',').map(Number);
    if (p.length === 6 && p.every(Number.isFinite)) return { kind: 'matrix', nums: p };
  }
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) {
    const p = m3[1].split(',').map(Number);
    if (p.length === 16 && p.every(Number.isFinite)) return { kind: 'matrix3d', nums: p };
  }
  return null;
}
function to3d(kind, nums) {
  if (kind === 'none') return IDENT4.slice();
  if (kind === 'matrix3d') return nums.slice();
  const [a, b, c, d, e, f] = nums;
  return [a,b,0,0, c,d,0,0, 0,0,1,0, e,f,0,1];
}
// Translation components move in px; the rest are unitless (rotation/scale).
const TRANSLATE_IDX = new Set([12, 13, 14]);
function compTol(i) { return TRANSLATE_IDX.has(i) ? 0.75 : 0.004; }

// Least-squares plane fit v = a*mx + b*my + c over the samples; returns
// coefficients + R². Solved via the 3x3 normal equations (Cramer's rule).
function planeFit(ms, vs) {
  const n = ms.length;
  let sx=0, sy=0, sxx=0, syy=0, sxy=0, sv=0, sxv=0, syv=0;
  for (let i = 0; i < n; i++) {
    const [x, y] = ms[i], v = vs[i];
    sx+=x; sy+=y; sxx+=x*x; syy+=y*y; sxy+=x*y; sv+=v; sxv+=x*v; syv+=y*v;
  }
  const det3 = (m) =>
    m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6]);
  const M = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return null;
  const a = det3([sxv, sxy, sx, syv, syy, sy, sv, sy, n]) / D;
  const b = det3([sxx, sxv, sx, sxy, syv, sy, sx, sv, n]) / D;
  const c = det3([sxx, sxy, sxv, sxy, syy, syv, sx, sy, sv]) / D;
  const mean = sv / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = ms[i], v = vs[i];
    ssRes += (v - (a*x + b*y + c)) ** 2;
    ssTot += (v - mean) ** 2;
  }
  const r2 = ssTot < 1e-9 ? 1 : 1 - ssRes / ssTot;
  return { a, b, c, r2 };
}

function fitPointerFields(samples) {
  // samples: [{ mx, my, snap: { id: transform } }]
  const fields = [];
  const unclassified = [];
  if (samples.length < 6) return { fields, unclassified };
  const ids = Object.keys(samples[0].snap);
  const ms = samples.map(s => [s.mx, s.my]);
  for (const id of ids) {
    const parsed = samples.map(s => parseMatrix(s.snap[id]));
    if (parsed.some(p => p === null)) continue;
    const is3d = parsed.some(p => p.kind === 'matrix3d');
    const mats = parsed.map(p => to3d(p.kind, p.nums));
    const varying = [];
    for (let i = 0; i < 16; i++) {
      const col = mats.map(m => m[i]);
      if (Math.max(...col) - Math.min(...col) > compTol(i)) varying.push(i);
    }
    if (!varying.length) continue;
    let ok = true;
    const comps = mats[0].map((v, i) => ({ a: 0, b: 0, c: v }));
    for (const i of varying) {
      const fit = planeFit(ms, mats.map(m => m[i]));
      if (!fit || fit.r2 < 0.85) { ok = false; break; }
      comps[i] = { a: fit.a, b: fit.b, c: fit.c };
    }
    if (ok)
      fields.push({ id, kind: is3d ? 'matrix3d' : 'matrix', comps, tauMs: 0 });
    else
      unclassified.push({ trigger: id, reason: REASONS.UNCLASSIFIED_BEHAVIOR, kind: 'pointer' });
  }
  return { fields, unclassified };
}

// Smoothing/lag recovery: many pointer choreographies chase the target with
// an exponential lerp (cur += (target - cur) * k per frame) — the source of
// the "ultra-smooth" trailing feel. Estimate each field's time constant from
// a step response: with the pointer parked, jump it to a distant point and
// sample the node's dominant varying matrix component per frame; tau is the
// time to cover 63.2% of the gap. Instant responders get tau 0.
function estimateTau(response, field) {
  // response: [{ t, transform }] frame samples after the pointer jump.
  if (!response || response.length < 4) return 0;
  const mats = [];
  for (const r of response) {
    const p = parseMatrix(r.transform);
    if (!p) return 0;
    mats.push(to3d(p.kind, p.nums));
  }
  // Dominant component: largest normalized start→end travel among varying ones.
  let idx = -1, best = 0;
  for (let i = 0; i < 16; i++) {
    const d = Math.abs(mats[mats.length - 1][i] - mats[0][i]) / compTol(i);
    if (d > best) { best = d; idx = i; }
  }
  if (idx < 0 || best < 2) return 0;
  const v0 = mats[0][idx], v1 = mats[mats.length - 1][idx];
  const target = v0 + 0.632 * (v1 - v0);
  const rising = v1 > v0;
  for (let i = 0; i < mats.length; i++) {
    const v = mats[i][idx];
    if (rising ? v >= target : v <= target) {
      const t = response[i].t - response[0].t;
      return t <= 60 ? 0 : Math.round(t);
    }
  }
  // Never crossed 63.2% within the window: very heavy smoothing; report the
  // window length as a floor rather than inventing a value.
  return Math.round(response[response.length - 1].t - response[0].t);
}

// ---------------------------------------------------------------------------
// In-page: structural + style extraction. Runs once at initial state.
// Elements outside the capture set are recorded as skips (tag + reason +
// document-coordinate rect, so verification can mask the region) — never
// silently dropped.
// ---------------------------------------------------------------------------
function inPageExtract({ PROPS, maxNodes, reasons }) {
  const CAPTURE_TAGS = ['BODY','HEADER','NAV','SECTION','DIV','SPAN','H1','H2','H3','H4','H5','H6','P','A','BUTTON','BLOCKQUOTE','CITE','FOOTER','UL','OL','LI','MAIN','ARTICLE','ASIDE','FIGURE','FIGCAPTION','STRONG','EM','SMALL','LABEL','PICTURE'];
  // Raster/vector media captured as assets in v0.2: IMG (bundled source),
  // inline SVG (serialized verbatim — it is already vector source), VIDEO
  // (source + poster bundled, first frame snapshotted) and CANVAS (current
  // frame snapshotted). AUDIO, OBJECT, EMBED remain out-of-scope media.
  const MEDIA_TAGS = ['AUDIO','OBJECT','EMBED'];
  const FRAME_MAX_BYTES = 4 * 1024 * 1024;
  const SVG_MAX_BYTES = 100 * 1024;
  const IGNORED_TAGS = ['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','BR','WBR','SOURCE','TRACK'];

  const cssColorToHex = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r, g, b, a = 1] = parts;
    const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
    if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  };

  let uid = 0;
  const nodes = [];
  const skips = [];

  const docRect = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  };

  // A skipped element still occupies layout space. Return a placeholder node
  // carrying its footprint (display + size + margin) so reconstruction
  // preserves the geometry of everything around it; the region itself is
  // masked from verification and reported with its fixed reason.
  let pid = 0;
  function recordSkip(el, reasonOverride) {
    const tag = el.tagName;
    if (IGNORED_TAGS.includes(tag)) return null; // non-rendering, nothing to mask or report
    let reason = reasonOverride;
    if (!reason) {
      if (tag === 'IFRAME') {
        let accessible = false;
        try { accessible = !!(el.contentDocument && el.contentDocument.body); } catch (e) {}
        reason = accessible ? reasons.OUT_OF_SCOPE_MEDIUM : reasons.CROSS_ORIGIN_CONTENT;
      } else if (MEDIA_TAGS.includes(tag)) {
        reason = reasons.OUT_OF_SCOPE_MEDIUM;
      } else {
        reason = reasons.UNSUPPORTED_ELEMENT;
      }
    }
    const id = 'ph' + (pid++);
    const rect = docRect(el);
    const cs = getComputedStyle(el);
    skips.push({ id, tag: tag.toLowerCase(), reason, rect });
    if (cs.display === 'none' || rect.w * rect.h < 1) return null; // no footprint
    return {
      id, tag: 'div', placeholder: true, reason, classes: [], children: [],
      rect: el.getBoundingClientRect ? (() => { const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : rect,
      style: {
        display: cs.display === 'inline' ? 'inline-block' : cs.display,
        width: cs.width, height: cs.height,
        marginTop: cs.marginTop, marginRight: cs.marginRight,
        marginBottom: cs.marginBottom, marginLeft: cs.marginLeft,
        borderRadius: cs.borderRadius, flex: cs.flex,
      },
    };
  }

  function readStyle(el) {
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of PROPS) {
      let v = cs[p];
      if (v == null || v === '') continue;
      if (/color/i.test(p) && v.startsWith('rgb')) v = cssColorToHex(v);
      style[p] = v;
    }
    return style;
  }

  // ::before / ::after (v0.4): pseudo-elements paint real pixels (badges,
  // underline accents, decorative layers) but have no DOM node to walk.
  // Read their computed styles per originating element; a pseudo exists iff
  // its computed `content` is neither 'none' nor 'normal'. Captured styles
  // include `content` plus the full tracked PROPS set; width/height are kept
  // because pseudo boxes have no content to derive size from.
  function readPseudo(el) {
    const out = {};
    for (const pe of ['::before', '::after']) {
      let cs;
      try { cs = getComputedStyle(el, pe); } catch (e) { continue; }
      const content = cs.content;
      if (!content || content === 'none' || content === 'normal') continue;
      const style = { content };
      for (const p of PROPS) {
        let v = cs[p];
        if (v == null || v === '') continue;
        if (/color/i.test(p) && v.startsWith('rgb')) v = cssColorToHex(v);
        style[p] = v;
      }
      out[pe === '::before' ? 'before' : 'after'] = style;
    }
    return Object.keys(out).length ? out : undefined;
  }

  function captureImg(el) {
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);
    const node = {
      id, tag: 'img', classes: [...el.classList],
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      src: el.currentSrc || el.src || undefined,
      alt: el.getAttribute('alt') || undefined,
      naturalW: el.naturalWidth || undefined, naturalH: el.naturalHeight || undefined,
      children: [],
    };
    nodes.push(node);
    return node;
  }

  function captureSvg(el) {
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);
    // Bake CSS-driven paint onto the root so the serialized markup is
    // self-contained (descendant CSS styling can still diverge; the per-node
    // diff catches it honestly).
    const cs = getComputedStyle(el);
    if (cs.fill && !el.getAttribute('fill')) el.setAttribute('fill', cs.fill);
    if (cs.stroke && cs.stroke !== 'none' && !el.getAttribute('stroke')) el.setAttribute('stroke', cs.stroke);
    // Shapes painted via CSS (class rules, currentColor) lose their paint when
    // the markup is re-emitted outside the page's stylesheets — bake each
    // shape's computed fill/stroke on as attributes. A root fill="none" does
    // not inherit onto shapes, so each shape is resolved individually.
    el.querySelectorAll('path,circle,rect,ellipse,polygon,polyline,line,text').forEach(sh => {
      const scs = getComputedStyle(sh);
      const f = sh.getAttribute('fill');
      if ((!f || f === 'currentColor' || f === 'inherit') && scs.fill) sh.setAttribute('fill', scs.fill);
      const st = sh.getAttribute('stroke');
      if ((!st || st === 'currentColor' || st === 'inherit') && scs.stroke && scs.stroke !== 'none') sh.setAttribute('stroke', scs.stroke);
    });
    const markup = el.outerHTML;
    if (markup.length > SVG_MAX_BYTES) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const node = {
      id, tag: 'svg', classes: [...el.classList],
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      svgMarkup: markup,
      children: [],
    };
    nodes.push(node);
    return node;
  }

  // <video>: the element itself is recoverable engineering — bundle its source
  // and poster, snapshot the current frame (same-origin only; tainted frames
  // are recorded as absent, never guessed), and re-emit a real <video> with
  // its playback attributes. Pixels stay time-varying: verification masks the
  // region with a fixed reason rather than pretending an instant matches.
  function captureVideo(el) {
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);
    let src = el.currentSrc || el.src || '';
    if (!src) {
      const s = el.querySelector('source[src]');
      if (s) { try { src = new URL(s.getAttribute('src'), location.href).href; } catch (e) {} }
    }
    let frame = null;
    try {
      if (el.videoWidth > 0 && el.readyState >= 2) {
        const c = document.createElement('canvas');
        c.width = el.videoWidth; c.height = el.videoHeight;
        c.getContext('2d').drawImage(el, 0, 0);
        frame = c.toDataURL('image/jpeg', 0.85);
        if (frame.length > FRAME_MAX_BYTES) frame = null;
      }
    } catch (e) { frame = null; } // tainted (cross-origin) frame
    const node = {
      id, tag: 'video', classes: [...el.classList], media: 'video',
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      src: src || undefined,
      poster: el.poster || undefined,
      frame: frame || undefined,
      mediaAttrs: { autoplay: !!el.autoplay, muted: !!el.muted, loop: !!el.loop,
                    playsInline: !!el.playsInline, controls: !!el.controls },
      children: [],
    };
    nodes.push(node);
    return node;
  }

  // <canvas>: the draw-command stream is out of scope (roadmap), but the
  // CURRENT frame is real evidence — snapshot it and re-emit as a still.
  // Tainted (WebGL/cross-origin) canvases record no frame and keep their
  // placeholder footprint.
  function captureCanvas(el) {
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    let frame = null;
    try {
      if (el.width > 0 && el.height > 0) {
        frame = el.toDataURL('image/png');
        if (frame.length > FRAME_MAX_BYTES) frame = null;
      }
    } catch (e) { frame = null; }
    if (!frame) return recordSkip(el, reasons.OUT_OF_SCOPE_MEDIUM);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);
    const node = {
      id, tag: 'canvas', classes: [...el.classList], media: 'canvas',
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      frame,
      children: [],
    };
    nodes.push(node);
    return node;
  }

  function walk(el) {
    // <br> is layout-significant line structure (per-letter animated text
    // relies on it) — re-emit it; it carries no style or box of its own.
    if (el.tagName === 'BR') return { id: 'br' + (uid++), tag: 'br', classes: [], children: [], style: {}, lineBreak: true };
    if (el.tagName === 'IMG') return captureImg(el);
    if (el.tagName === 'svg' || el.tagName === 'SVG') return captureSvg(el);
    if (el.tagName === 'VIDEO') return captureVideo(el);
    if (el.tagName === 'CANVAS') return captureCanvas(el);
    if (!CAPTURE_TAGS.includes(el.tagName)) return recordSkip(el);
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);

    let ownText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) ownText += child.textContent;
    }
    // A whitespace-only element with a real box (e.g. a space span inside
    // per-letter animated text) carries layout width: keep it as an nbsp so
    // the re-emitted inline box doesn't collapse to zero width.
    ownText = ownText.trim() ||
      (ownText && el.children.length === 0 && rect.width > 0 ? '\u00A0' : '');

    const node = {
      id,
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      pseudo: readPseudo(el),
      text: ownText || undefined,
      href: el.getAttribute('href') || undefined,
      children: [],
    };
    for (const c of el.children) {
      const cn = walk(c);
      if (cn) {
        // Inter-element whitespace is layout-significant for inline siblings
        // (it renders as a word space); preserve it so codegen can re-emit it.
        // Accumulate ALL consecutive preceding text-node siblings (the DOM
        // may hold several in a row — they never merge).
        let prevText = '';
        for (let prev = c.previousSibling; prev && prev.nodeType === 3; prev = prev.previousSibling) {
          prevText = prev.textContent + prevText;
        }
        if (/\s/.test(prevText)) {
          // Collapsible whitespace renders as one word space, but no-break
          // spaces do NOT collapse — a run of them is real width (scramble
          // animations pad with them). Keep nbsp runs verbatim.
          const kept = prevText.replace(/[^\S\u00A0]+/g, ' ');
          cn.wsBefore = /\u00A0/.test(kept) ? kept : true;
        }
        node.children.push(cn);
      }
    }
    nodes.push(node);
    return node;
  }

  if (!document.body) return { error: 'no-body' };
  const tree = walk(document.body);
  if (!tree) return { error: 'no-body' };

  // Chronograph (declared tier): WAAPI animations + CSS transitions.
  const animations = [];
  for (const anim of document.getAnimations()) {
    const effect = anim.effect;
    if (!effect || !effect.target) continue;
    const target = effect.target;
    const timing = effect.getTiming ? effect.getTiming() : {};
    let keyframes = [];
    try { keyframes = effect.getKeyframes(); } catch (e) {}
    animations.push({
      targetId: target.getAttribute && target.getAttribute('data-mf-id'),
      targetClasses: target.classList ? [...target.classList] : [],
      type: anim.constructor.name,
      duration: timing.duration,
      easing: timing.easing,
      delay: timing.delay,
      iterations: timing.iterations,
      direction: timing.direction,
      keyframes: keyframes.map(k => ({ ...k })),
    });
  }

  const transitions = [];
  document.querySelectorAll('[data-mf-id]').forEach(el => {
    const cs = getComputedStyle(el);
    const prop = cs.transitionProperty;
    if (prop && prop !== 'all' && prop !== 'none') {
      transitions.push({
        targetId: el.getAttribute('data-mf-id'),
        classes: [...el.classList],
        property: prop,
        duration: cs.transitionDuration,
        easing: cs.transitionTimingFunction,
        delay: cs.transitionDelay,
      });
    }
  });

  return { tree, flat: nodes, animations, transitions, skips,
           viewport: { w: window.innerWidth, h: window.innerHeight },
           scrollHeight: Math.max(document.body.scrollHeight,
                                  document.documentElement.scrollHeight) };
}

// ---------------------------------------------------------------------------
// In-page: hover rules recovered verbatim from same-origin stylesheets.
// Cross-origin stylesheets cannot be read; they are counted, not ignored.
// ---------------------------------------------------------------------------
function inPageHoverRules() {
  const hoverRules = [];
  let crossOriginSheets = 0;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { crossOriginSheets++; continue; }
    if (!rules) { crossOriginSheets++; continue; }
    for (const rule of rules) {
      try {
        if (rule.selectorText && rule.selectorText.includes(':hover')) {
          hoverRules.push({
            selector: rule.selectorText,
            declarations: rule.style.cssText,
          });
        }
      } catch (e) { /* exotic rule types (CSSOM quirks) — skip the rule */ }
    }
  }
  return { hoverRules, crossOriginSheets };
}

// ---------------------------------------------------------------------------
// In-page: :focus / :focus-visible / :focus-within rules recovered verbatim
// from same-origin stylesheets (v0.4) — same discipline as hover rules.
// ---------------------------------------------------------------------------
function inPageFocusRules() {
  const focusRules = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; } // counted via hover pass
    if (!rules) continue;
    for (const rule of rules) {
      try {
        if (rule.selectorText && /:focus(-visible|-within)?\b/.test(rule.selectorText)) {
          focusRules.push({
            selector: rule.selectorText,
            declarations: rule.style.cssText,
          });
        }
      } catch (e) { /* exotic rule types — skip the rule */ }
    }
  }
  return focusRules;
}

// ---------------------------------------------------------------------------
// In-page: focus probe (keyboard agent, v0.4). CSS :focus rules are recovered
// from stylesheets separately; this probe recovers JS-driven focus behavior
// (focus/blur listeners that toggle classes or write inline styles) by
// programmatically focusing each keyboard-reachable candidate and diffing
// class + tracked style state. Bounded by candidate cap + budget; the page
// state is restored after every candidate.
// ---------------------------------------------------------------------------
async function inPageFocusProbe({ PROPS, budgetMs, maxCandidates, ambientIds }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + budgetMs;
  const ambient = new Set(ambientIds || []);
  const all = [...document.querySelectorAll('[data-mf-id]')];
  const idOf = (el) => el.getAttribute('data-mf-id');

  const snapshot = () => {
    const m = {};
    for (const el of all) {
      const cs = getComputedStyle(el);
      const s = { __class: el.className };
      for (const p of PROPS) { const v = cs[p]; if (v != null && v !== '') s[p] = v; }
      m[idOf(el)] = s;
    }
    return m;
  };
  const diff = (a, b) => {
    const out = {};
    for (const id of Object.keys(b)) {
      if (ambient.has(id)) continue;
      const d = {};
      for (const p of Object.keys(b[id])) {
        if (a[id] && a[id][p] !== b[id][p]) d[p] = { off: a[id][p], on: b[id][p] };
      }
      if (Object.keys(d).length) out[id] = d;
    }
    return out;
  };

  const candidates = all.filter(el =>
    el.matches('a[href],button,input,select,textarea,[tabindex]') &&
    !el.matches('[tabindex="-1"]')).slice(0, maxCandidates);
  const focuses = [];
  for (const el of candidates) {
    if (Date.now() > deadline) break;
    const base = snapshot();
    try { el.focus({ preventScroll: true }); } catch (e) { continue; }
    await sleep(200);
    const d = diff(base, snapshot());
    try { el.blur(); } catch (e) {}
    await sleep(150);
    for (const el2 of all) {
      const want = base[idOf(el2)] && base[idOf(el2)].__class;
      if (want != null && el2.className !== want && !ambient.has(idOf(el2))) el2.className = want;
    }
    if (Object.keys(d).length) focuses.push({ trigger: idOf(el), deltas: d });
  }
  return focuses;
}

// ---------------------------------------------------------------------------
// In-page: full tracked-style + rect snapshot of every node at the CURRENT
// viewport (v0.4 responsive re-capture). Same normalization as readStyle so
// values diff 1:1 against the base-width capture.
// ---------------------------------------------------------------------------
function inPageBreakpointSnapshot(PROPS_) {
  const cssColorToHex = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c;
    const [r, g, b, a = 1] = m[1].split(',').map(s => parseFloat(s.trim()));
    const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
    if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  };
  const out = {};
  document.querySelectorAll('[data-mf-id]').forEach(el => {
    const cs = getComputedStyle(el);
    const style = {};
    for (const p of PROPS_) {
      let v = cs[p];
      if (v == null || v === '') continue;
      if (/color/i.test(p) && v.startsWith('rgb')) v = cssColorToHex(v);
      style[p] = v;
    }
    const r = el.getBoundingClientRect();
    out[el.getAttribute('data-mf-id')] =
      { style, rect: { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height } };
  });
  return out;
}

// ---------------------------------------------------------------------------
// In-page: @font-face collection. Same-origin sheets are read via CSSOM;
// cross-origin sheet hrefs are returned for the driver to fetch out-of-page.
// ---------------------------------------------------------------------------
function inPageFontFaces() {
  const cssTexts = [];       // { css, base } same-origin @font-face rule text
  const crossOriginHrefs = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { if (sheet.href) crossOriginHrefs.push(sheet.href); continue; }
    if (!rules) { if (sheet.href) crossOriginHrefs.push(sheet.href); continue; }
    const base = sheet.href || location.href;
    for (const rule of rules) {
      try {
        if (rule.constructor.name === 'CSSFontFaceRule')
          cssTexts.push({ css: rule.cssText, base });
        else if (rule.constructor.name === 'CSSImportRule' && rule.styleSheet) {
          try {
            for (const r2 of rule.styleSheet.cssRules)
              if (r2.constructor.name === 'CSSFontFaceRule')
                cssTexts.push({ css: r2.cssText, base: rule.styleSheet.href || base });
          } catch (e2) { if (rule.href) crossOriginHrefs.push(new URL(rule.href, base).href); }
        }
      } catch (e) { /* exotic rule types — skip the rule */ }
    }
  }
  // Families actually used on captured nodes — lets the driver bundle only
  // fonts that matter for fidelity.
  const used = new Set();
  document.querySelectorAll('[data-mf-id]').forEach(el => {
    getComputedStyle(el).fontFamily.split(',').forEach(f =>
      used.add(f.trim().replace(/^['"]|['"]$/g, '')));
  });
  return { cssTexts, crossOriginHrefs, usedFamilies: [...used] };
}

// ---------------------------------------------------------------------------
// In-page: one scroll-sweep snapshot — visual props of every tracked node at
// the current scroll position. The driver loops positions (frame-by-frame
// virtual scroll agent) and derives per-node scroll tracks from the samples.
// ---------------------------------------------------------------------------
function inPageScrollSnapshot() {
  const props = ['transform', 'opacity', 'clipPath', 'filter'];
  const out = {};
  document.querySelectorAll('[data-mf-id]').forEach(el => {
    const cs = getComputedStyle(el);
    out[el.getAttribute('data-mf-id')] = props.map(p => cs[p]);
  });
  return out;
}

// ---------------------------------------------------------------------------
// In-page: hover probe (virtual mouse agent, part 1). CSS :hover rules are
// recovered from stylesheets separately; this probe recovers JS-driven hover
// (mouseenter listeners that toggle classes or write inline styles) by
// dispatching synthetic pointer/mouse events on interactive candidates and
// diffing class + tracked style state. Bounded by candidate cap + budget.
// ---------------------------------------------------------------------------
async function inPageHoverProbe({ PROPS, budgetMs, maxCandidates, ambientIds }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + budgetMs;
  const ambient = new Set(ambientIds || []);
  const all = [...document.querySelectorAll('[data-mf-id]')];
  const idOf = (el) => el.getAttribute('data-mf-id');

  const snapshot = () => {
    const m = {};
    for (const el of all) {
      const cs = getComputedStyle(el);
      const s = { __class: el.className };
      for (const p of PROPS) { const v = cs[p]; if (v != null && v !== '') s[p] = v; }
      m[idOf(el)] = s;
    }
    return m;
  };
  const diff = (a, b) => {
    const out = {};
    for (const id of Object.keys(b)) {
      if (ambient.has(id)) continue;
      const d = {};
      for (const p of Object.keys(b[id])) {
        if (a[id] && a[id][p] !== b[id][p]) d[p] = { off: a[id][p], on: b[id][p] };
      }
      if (Object.keys(d).length) out[id] = d;
    }
    return out;
  };
  const fire = (el, types) => {
    for (const t of types) {
      const Ev = t.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(t, { bubbles: t !== 'mouseenter' && t !== 'mouseleave', cancelable: true }));
    }
  };

  const isCandidate = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return getComputedStyle(el).cursor === 'pointer' &&
           !['BODY', 'HTML', 'SECTION', 'HEADER', 'FOOTER'].includes(tag);
  };

  let candidates = all.filter(isCandidate).slice(0, maxCandidates);
  const hovers = [];
  for (const el of candidates) {
    if (Date.now() > deadline) break;
    const base = snapshot();
    fire(el, ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']);
    await sleep(250);
    const d = diff(base, snapshot());
    fire(el, ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']);
    await sleep(200);
    // restore classes in case leave handlers didn't fully revert
    for (const el2 of all) {
      const want = base[idOf(el2)] && base[idOf(el2)].__class;
      if (want != null && el2.className !== want && !ambient.has(idOf(el2))) el2.className = want;
    }
    if (Object.keys(d).length) hovers.push({ trigger: idOf(el), deltas: d });
  }
  return hovers;
}

// ---------------------------------------------------------------------------
// In-page: Chronograph frame sampler (sampled tier, v0.2). Time-driven motion
// (rAF loops, JS tickers, CSS animations whose keyframes are inaccessible)
// is invisible to the declared tier. Detect movers with two cheap snapshots,
// then record their visual props at EVERY animation frame for a bounded
// window. The recovered per-frame tracks are replayed verbatim via WAAPI in
// the reconstruction; their pixels stay phase-dependent, so verification
// masks them with the fixed time-varying reason — replicated AND honest.
// ---------------------------------------------------------------------------
async function inPageFrameSample({ durationMs, maxTracks }) {
  const props = ['transform', 'opacity', 'filter', 'clipPath'];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const els = [...document.querySelectorAll('[data-mf-id]')];
  const read = (el) => { const cs = getComputedStyle(el); return props.map(p => cs[p]); };
  const s1 = els.map(read);
  await sleep(280);
  const s2 = els.map(read);
  const movers = [];
  for (let i = 0; i < els.length; i++) {
    if (s1[i].join('|') !== s2[i].join('|')) movers.push(els[i]);
    if (movers.length >= maxTracks) break;
  }
  if (!movers.length) return [];
  const frames = [];
  await new Promise((res) => {
    let t0 = null;
    const step = (t) => {
      if (t0 === null) t0 = t;
      const v = {};
      for (const el of movers) v[el.getAttribute('data-mf-id')] = read(el);
      frames.push({ t: t - t0, v });
      if (t - t0 < durationMs) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  const tracks = [];
  for (const el of movers) {
    const id = el.getAttribute('data-mf-id');
    for (let pi = 0; pi < props.length; pi++) {
      const vals = frames.map(f => f.v[id][pi]);
      if (vals.some(v => v !== vals[0]))
        tracks.push({ id, prop: props[pi],
                      frames: frames.map((f, i) => [Math.round(f.t * 10) / 10, vals[i]]) });
    }
  }
  return tracks.slice(0, maxTracks);
}

// ---------------------------------------------------------------------------
// In-page: ambient-mutation watch. Observes class mutations for a fixed
// input-free window. Anything that mutates with NO input is timer/script
// driven (autoplay carousel, ticker) — not attributable to a click/scroll
// trigger, so it is out of scope for behavior recovery and must be excluded
// from probe diffs and per-node verification (reason: unclassified-behavior).
// ---------------------------------------------------------------------------
async function inPageAmbientWatch(windowMs) {
  const ids = new Set();
  const mark = (el) => {
    while (el && el.nodeType !== 1) el = el.parentElement || el.parentNode;
    const id = el && el.getAttribute && el.getAttribute('data-mf-id');
    if (id) ids.add(id);
  };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'class') mark(m.target);
      // Text scramblers / tickers rewrite text with no input — as pixel-
      // unstable as class churn, and equally unverifiable per node.
      if (m.type === 'characterData' || m.type === 'childList') mark(m.target);
    }
  });
  obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'],
                               characterData: true, childList: true });
  await new Promise(r => setTimeout(r, windowMs));
  obs.disconnect();
  return [...ids];
}

// ---------------------------------------------------------------------------
// In-page: interaction probe (Kinesis v1.5).
// Synthetically clicks interactive candidates, diffs class state + tracked
// computed styles before/after, clicks again to test reversibility, and
// restores the page state after each probe. Pattern-agnostic: it records raw
// (trigger, classDelta, styleDelta, reversible) observations; classification
// into accordion/tabs/modal state machines happens in the Genome Compiler.
// Bounded: candidate cap + wall-clock budget; unprobed candidates are
// reported as skips, never silently dropped.
// ---------------------------------------------------------------------------
async function inPageInteractionProbe({ PROPS, budgetMs, maxCandidates, ambientIds, reasons }) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const deadline = Date.now() + budgetMs;
  const ambient = new Set(ambientIds || []);
  const all = [...document.querySelectorAll('[data-mf-id]')];
  const idOf = (el) => el.getAttribute('data-mf-id');

  // Block navigation during the probe (anchors, form submits).
  const blocker = (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (a && a.getAttribute('href')) e.preventDefault();
  };
  document.addEventListener('click', blocker, true);

  const classSnapshot = () => {
    const m = {};
    for (const el of all) m[idOf(el)] = el.className;
    return m;
  };
  const styleSnapshot = () => {
    const m = {};
    for (const el of all) {
      const cs = getComputedStyle(el);
      const s = {};
      for (const p of PROPS) { const v = cs[p]; if (v != null && v !== '') s[p] = v; }
      m[idOf(el)] = s;
    }
    return m;
  };
  // Ambient-mutating nodes are excluded from diffs: their class churn is
  // timer-driven and would be misattributed to whatever was just clicked.
  const classDiff = (a, b) => {
    const out = [];
    for (const id of Object.keys(b)) {
      if (ambient.has(id)) continue;
      if (a[id] === b[id]) continue;
      const before = new Set(a[id].split(/\s+/).filter(Boolean));
      const after = new Set(b[id].split(/\s+/).filter(Boolean));
      const added = [...after].filter(c => !before.has(c));
      const removed = [...before].filter(c => !after.has(c));
      if (added.length || removed.length) out.push({ id, added, removed });
    }
    return out;
  };
  const styleDiff = (a, b) => {
    const out = {};
    for (const id of Object.keys(b)) {
      if (ambient.has(id)) continue;
      const d = {};
      for (const p of Object.keys(b[id])) {
        if (a[id] && a[id][p] !== b[id][p]) d[p] = { off: a[id][p], on: b[id][p] };
      }
      if (Object.keys(d).length) out[id] = d;
    }
    return out;
  };
  const restore = (snap) => {
    for (const el of all) {
      if (ambient.has(idOf(el))) continue;
      const want = snap[idOf(el)];
      if (el.className !== want) el.className = want;
    }
  };
  const reverses = (m1, m2) => {
    if (m1.length !== m2.length) return false;
    const key = (d) => `${d.id}|+${[...d.added].sort()}|-${[...d.removed].sort()}`;
    const inv = (d) => `${d.id}|+${[...d.removed].sort()}|-${[...d.added].sort()}`;
    const s2 = new Set(m2.map(key));
    return m1.every(d => s2.has(inv(d)));
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const isCandidate = (el) => {
    const tag = el.tagName;
    if (tag === 'BUTTON') return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'tab') return true;
    if (tag === 'A') { const h = el.getAttribute('href'); return !h || h.startsWith('#'); }
    return getComputedStyle(el).cursor === 'pointer' &&
           !['BODY','HTML','SECTION','HEADER','FOOTER'].includes(tag);
  };

  let candidates = all.filter(isCandidate);
  const skippedProbes = [];
  if (candidates.length > maxCandidates) {
    for (const el of candidates.slice(maxCandidates))
      skippedProbes.push({ trigger: idOf(el), reason: reasons.SCALE_CAP_EXCEEDED });
    candidates = candidates.slice(0, maxCandidates);
  }
  const probes = [];
  const deferred = [];

  // A single throwing click handler (page-script conflict with a synthetic
  // event) must not kill the whole probe: the failing candidate is recorded
  // as a skip with the fixed probe-error reason and the sweep continues.
  async function probeOne(el) {
    const baseClasses = classSnapshot();
    const baseStyles = styleSnapshot();
    try {
      el.click();
      await sleep(350);
      const m1 = classDiff(baseClasses, classSnapshot());
      if (m1.length === 0) { restore(baseClasses); return null; }
      const deltas = styleDiff(baseStyles, styleSnapshot());
      const mid = classSnapshot();
      el.click();
      await sleep(350);
      const m2 = classDiff(mid, classSnapshot());
      const rec = { trigger: idOf(el), m1, reversible: reverses(m1, m2), styleDeltas: deltas };
      restore(baseClasses);
      return rec;
    } catch (e) {
      restore(baseClasses);
      skippedProbes.push({ trigger: idOf(el), reason: reasons.PROBE_ERROR });
      return null;
    }
  }

  for (const el of candidates) {
    if (Date.now() > deadline) {
      skippedProbes.push({ trigger: idOf(el), reason: reasons.TIME_BUDGET_EXCEEDED });
      continue;
    }
    if (!isVisible(el)) { deferred.push(el); continue; }
    const rec = await probeOne(el);
    if (rec) probes.push(rec);
  }

  // Second pass: candidates only reachable inside a state another trigger
  // opens (e.g. a modal's close button). Re-apply each opening state and
  // probe the newly visible candidates under it.
  for (const p of probes.slice()) {
    if (p.reversible || deferred.length === 0) continue;
    if (Date.now() > deadline) break;
    const baseClasses = classSnapshot();
    for (const d of p.m1) {
      const el = document.querySelector(`[data-mf-id="${d.id}"]`);
      if (!el) continue;
      for (const c of d.added) el.classList.add(c);
      for (const c of d.removed) el.classList.remove(c);
    }
    await sleep(150);
    for (let i = deferred.length - 1; i >= 0; i--) {
      if (Date.now() > deadline) break;
      const el = deferred[i];
      if (!isVisible(el)) continue;
      const rec = await probeOne(el);
      if (rec) { rec.underState = p.trigger; probes.push(rec); }
      deferred.splice(i, 1);
    }
    restore(baseClasses);
  }
  for (const el of deferred) {
    if (Date.now() > deadline)
      skippedProbes.push({ trigger: idOf(el), reason: reasons.TIME_BUDGET_EXCEEDED });
  }

  document.removeEventListener('click', blocker, true);
  return { probes, candidateIds: candidates.map(idOf), skippedProbes };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
async function capture(url, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const width = opts.width || 1280;
  const height = opts.height || 800;
  const cfg = { ...DEFAULTS, ...opts };
  const t0 = Date.now();

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  // Uncontrolled pages may open popups or fire dialogs mid-probe; both would
  // otherwise wedge the run.
  context.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  // Asset substrate: opportunistically bank every font/image the page itself
  // loads (through its own network stack — cookies, referer intact).
  const store = new AssetStore(outDir);
  page.on('response', (res) => {
    const rt = res.request().resourceType();
    if (rt !== 'font' && rt !== 'image') return;
    res.body().then(buf => store.add(res.url(), buf, res.headers()['content-type']))
      .catch(() => {});
  });

  try {
    // Navigation: networkidle first (stable ground truth), falling back to
    // domcontentloaded + settle for pages whose network never goes idle
    // (analytics beacons, long-poll, hung assets). Both bounded.
    let navFallback = false;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.navTimeoutMs });
    } catch (e) {
      navFallback = true;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeoutMs });
        await page.waitForTimeout(3000);
      } catch (e2) {
        throw new MfSkip(REASONS.NETWORK_TIMEOUT, url);
      }
    }
    const gotoMs = Date.now() - t0;

    // Let intro/loader animations finish before reading any computed style;
    // extraction mid-intro would bake transient theme/transform state into
    // the genome (bounded; falls through after settleMaxMs).
    const settled = await waitForVisualSettle(page, cfg);

    let raw;
    try {
      raw = await page.evaluate(inPageExtract,
        { PROPS, maxNodes: cfg.maxNodes, reasons: REASONS });
    } catch (e) {
      throw new MfSkip(REASONS.UNPARSEABLE_MARKUP, e.message);
    }
    if (!raw || raw.error) throw new MfSkip(REASONS.UNPARSEABLE_MARKUP, raw && raw.error);

    const { hoverRules, crossOriginSheets } = await page.evaluate(inPageHoverRules);
    const focusRules = await page.evaluate(inPageFocusRules);

    // --- Web fonts: @font-face rules (same-origin CSSOM + cross-origin CSS
    // fetched out-of-page), binaries bundled, src rewritten to local files. ---
    const ff = await page.evaluate(inPageFontFaces);
    const usedFamilies = new Set(ff.usedFamilies);
    let faces = [];
    for (const { css, base } of ff.cssTexts) faces.push(...parseFontFaces(css, base));
    for (const href of ff.crossOriginHrefs) {
      try {
        const resp = await page.request.get(href, { timeout: 10000 });
        if (resp.ok()) faces.push(...parseFontFaces(await resp.text(), href));
      } catch (e) { store.miss(href, REASONS.NETWORK_TIMEOUT); }
    }
    // Only bundle faces whose family is actually used by captured nodes.
    faces = faces.filter(f => usedFamilies.has(f.family));
    const fontFaces = [];
    const seenFace = new Set();
    for (const f of faces) {
      const key = `${f.family}|${f.weight}|${f.style}|${f.unicodeRange || ''}`;
      if (seenFace.has(key)) continue;
      seenFace.add(key);
      const pick = bestFontUrl(f);
      let local = null;
      if (pick.url.startsWith('data:')) local = null; // kept inline via original src
      else local = store.localFor(pick.url) || await fetchInto(store, page, pick.url);
      fontFaces.push({ family: f.family, weight: f.weight, style: f.style,
                       display: f.display, unicodeRange: f.unicodeRange,
                       url: pick.url, format: pick.format, local });
    }

    // --- Image assets: <img> sources + CSS background-images. ---
    const imgUrls = new Set();
    for (const n of raw.flat) {
      if (n.src && n.media !== 'video') imgUrls.add(n.src);
      if (n.style && n.style.backgroundImage && n.style.backgroundImage !== 'none')
        cssUrls(n.style.backgroundImage).forEach(u => imgUrls.add(u));
      // Pseudo-element backdrops paint real pixels too (v0.4).
      for (const pe of ['before', 'after']) {
        const ps = n.pseudo && n.pseudo[pe];
        if (ps && ps.backgroundImage && ps.backgroundImage !== 'none')
          cssUrls(ps.backgroundImage).forEach(u => imgUrls.add(u));
      }
    }
    for (const u of imgUrls) if (!store.has(u)) await fetchInto(store, page, u);

    // --- Video assets: sources + posters, through the page's network stack. ---
    for (const n of raw.flat) {
      if (n.media !== 'video') continue;
      if (n.src && !store.has(n.src)) await fetchInto(store, page, n.src, 30000);
      if (n.poster && !store.has(n.poster)) await fetchInto(store, page, n.poster);
    }

    // Ambient watch BEFORE any probing: timer-driven class churn must be known
    // so probe diffs and reveal recovery can exclude it.
    const ambientIds = await page.evaluate(inPageAmbientWatch, cfg.ambientWatchMs);

    // Chronograph frame sampler: per-frame recording of time-driven motion
    // (rAF loops, infinite CSS animations) at scroll 0, before any probing.
    let frameTracks = [];
    try {
      frameTracks = await Promise.race([
        page.evaluate(inPageFrameSample,
          { durationMs: cfg.frameSampleMs, maxTracks: cfg.maxFrameTracks }),
        new Promise(r => setTimeout(() => r([]), cfg.frameSampleMs + 15000)),
      ]) || [];
    } catch (e) { frameTracks = []; }

    const mutations = [];
    await page.exposeFunction('__mfMutation', (rec) => mutations.push(rec));

    // Screenshot at initial state (fold), before any probing mutates the page.
    await page.screenshot({ path: path.join(outDir, 'original-fold.png') });

    // Scroll agent: MutationObserver catches IntersectionObserver-driven class
    // toggles (scroll reveals); the frame-by-frame sweep below additionally
    // samples visual props per node per scroll position (parallax, GSAP-style
    // inline transforms, scroll-linked opacity) and takes ground-truth
    // screenshots at fixed checkpoints for scroll-state verification.
    await page.evaluate(() => {
      const obs = window.__mfObs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            window.__mfMutation({
              id: m.target.getAttribute && m.target.getAttribute('data-mf-id'),
              classes: m.target.classList ? [...m.target.classList] : [],
              // Timestamp recovers sequential-reveal stagger: the relative
              // firing order + offsets of elements revealed in one burst.
              // scrollY separates true stagger (same scroll position) from
              // elements that simply intersected at different sweep steps.
              t: performance.now(),
              y: window.scrollY,
            });
          }
        }
      });
      obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    });
    const maxScroll = await page.evaluate(() => Math.max(0,
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight));
    const sweepSamples = [];
    const scrollShots = [];
    const checkpoints = (cfg.scrollCheckpoints || []).map(f => Math.round(maxScroll * f));
    for (let i = 0; i <= cfg.scrollSteps; i++) {
      const y = Math.round((maxScroll * i) / cfg.scrollSteps);
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(cfg.scrollSettleMs);
      let snap = await page.evaluate(inPageScrollSnapshot);
      const ci = checkpoints.findIndex(c => Math.abs(c - y) <= maxScroll / (2 * cfg.scrollSteps) + 1);
      if (ci >= 0 && maxScroll > 0 && !scrollShots.some(s => s.index === ci)) {
        // Checkpoint ground truth must be a SETTLED state: smooth-scroll
        // libraries keep gliding transforms after scrollTo, and a mid-glide
        // frame is a state the replay can never land on. Wait (bounded) until
        // consecutive snapshots match, then re-read the sweep sample too.
        let prev = JSON.stringify(snap);
        const t0 = Date.now();
        while (Date.now() - t0 < 4000) {
          await page.waitForTimeout(300);
          const next = await page.evaluate(inPageScrollSnapshot);
          const nj = JSON.stringify(next);
          snap = next;
          if (nj === prev) break;
          prev = nj;
        }
        const shot = `original-scroll-${Math.round(cfg.scrollCheckpoints[ci] * 100)}.png`;
        await page.screenshot({ path: path.join(outDir, shot) });
        // Second exposure a beat later: pixels that differ between the two
        // are time-driven (ambient float loops), not scroll-driven — the
        // verifier masks exactly those, and reports the masked area.
        const shotB = `original-scroll-${Math.round(cfg.scrollCheckpoints[ci] * 100)}-b.png`;
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(outDir, shotB) });
        scrollShots.push({ index: ci, fraction: cfg.scrollCheckpoints[ci], scrollY: y, shot, shotB });
      }
      sweepSamples.push({ y, snap });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    // Smooth-scroll libraries glide back to 0 and parallax transforms lag
    // behind: wait until consecutive snapshots are identical (bounded), or
    // the "settled" post-sweep state would be a mid-glide frame.
    let postSweepSnap = await page.evaluate(inPageScrollSnapshot);
    {
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        await page.waitForTimeout(400);
        const next = await page.evaluate(inPageScrollSnapshot);
        if (JSON.stringify(next) === JSON.stringify(postSweepSnap)) { postSweepSnap = next; break; }
        postSweepSnap = next;
      }
    }
    const scrollTracks = deriveScrollTracks(sweepSamples, cfg.maxScrollTracks, postSweepSnap);

    // Post-scroll steady state: one-way reveals (fire once, persist) may have
    // changed styles well beyond the four sweep-sampled props (visibility,
    // color, size...). Re-read the full tracked style set and rects, and fold
    // changes back into the captured nodes — the settled post-scroll state is
    // what the full-page ground truth shows. Fold state is unaffected: nodes
    // in the initial viewport had already fired before the fold shot.
    const postStyles = await page.evaluate((PROPS_) => {
      // Same normalization as inPageExtract's readStyle, so values compare 1:1.
      const cssColorToHex = (c) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return c;
        const [r, g, b, a = 1] = m[1].split(',').map(s => parseFloat(s.trim()));
        const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
        if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
        return `#${hex(r)}${hex(g)}${hex(b)}`;
      };
      const out = {};
      document.querySelectorAll('[data-mf-id]').forEach(el => {
        const cs = getComputedStyle(el);
        const style = {};
        for (const p of PROPS_) {
          let v = cs[p];
          if (v == null || v === '') continue;
          if (/color/i.test(p) && v.startsWith('rgb')) v = cssColorToHex(v);
          style[p] = v;
        }
        const r = el.getBoundingClientRect();
        const entry =
          { style, rect: { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height } };
        // Inline SVGs animated by scroll reveals (paths translated/scaled by
        // an animation library) settle into their revealed geometry: the
        // serialized markup must be the settled state, not the hidden one.
        if (el.tagName.toLowerCase() === 'svg') {
          el.querySelectorAll('path,circle,rect,ellipse,polygon,polyline,line,text').forEach(sh => {
            const scs = getComputedStyle(sh);
            const f = sh.getAttribute('fill');
            if ((!f || f === 'currentColor' || f === 'inherit') && scs.fill) sh.setAttribute('fill', scs.fill);
            const st = sh.getAttribute('stroke');
            if ((!st || st === 'currentColor' || st === 'inherit') && scs.stroke && scs.stroke !== 'none') sh.setAttribute('stroke', scs.stroke);
          });
          entry.svgMarkup = el.outerHTML;
        }
        // Text mutated after initial extraction (scramble/decode animations
        // fire on reveal): the settled text — and the non-collapsing nbsp
        // whitespace between child spans — is what the ground truth shows.
        let ownText = '';
        for (const child of el.childNodes) {
          if (child.nodeType === 3) ownText += child.textContent;
        }
        ownText = ownText.trim() ||
          (ownText && el.children.length === 0 && r.width > 0 ? '\u00A0' : '');
        if (ownText) entry.text = ownText;
        const ws = {};
        for (const c of el.children) {
          const cid = c.getAttribute && c.getAttribute('data-mf-id');
          if (!cid) continue;
          let prevText = '';
          for (let prev = c.previousSibling; prev && prev.nodeType === 3; prev = prev.previousSibling) {
            prevText = prev.textContent + prevText;
          }
          if (/\s/.test(prevText)) {
            const kept = prevText.replace(/[^\S\u00A0]+/g, ' ');
            ws[cid] = /\u00A0/.test(kept) ? kept : true;
          }
        }
        if (Object.keys(ws).length) entry.childWs = ws;
        out[el.getAttribute('data-mf-id')] = entry;
      });
      return out;
    }, PROPS);
    let postScrollUpdated = 0;
    for (const n of raw.flat) {
      const post = postStyles[n.id];
      if (!post || !n.style) continue;
      let changed = false;
      for (const p of Object.keys(post.style)) {
        if (n.style[p] !== undefined && post.style[p] !== undefined &&
            n.style[p] !== post.style[p]) { n.style[p] = post.style[p]; changed = true; }
      }
      if (n.svgMarkup && post.svgMarkup && post.svgMarkup !== n.svgMarkup) {
        n.svgMarkup = post.svgMarkup; changed = true;
      }
      if (n.text !== undefined && post.text !== undefined && post.text !== n.text) {
        n.text = post.text; changed = true;
      }
      if (post.childWs) {
        for (const c of n.children || []) {
          const w = post.childWs[c.id];
          if (w !== undefined && w !== c.wsBefore) { c.wsBefore = w; changed = true; }
        }
      }
      if (changed) { n.rect = post.rect; n.postScroll = true; postScrollUpdated++; }
    }

    // Chromium's fullPage screenshot resizes the viewport to the document
    // height, making scroll-linked libraries recompute transforms for an
    // "everything visible" viewport no user ever sees — a state the recon
    // replay (driven by real scroll positions) can never reproduce. Freeze
    // every tracked node at its settled scroll-0 value for the shot, so both
    // sides show the same well-defined state; unfrozen right after.
    await page.evaluate((tracks) => {
      const kebab = (s) => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
      const rules = [];
      for (const t of tracks) {
        const el = document.querySelector(`[data-mf-id="${t.id}"]`);
        if (!el) continue;
        const v = getComputedStyle(el)[t.prop];
        rules.push(`[data-mf-id="${t.id}"] { ${kebab(t.prop)}: ${v} !important; }`);
      }
      const tag = document.createElement('style');
      tag.id = '__mf-freeze';
      tag.textContent = rules.join('\n');
      document.head.appendChild(tag);
    }, scrollTracks.map(t => ({ id: t.id, prop: t.prop })));
    await page.screenshot({ path: path.join(outDir, 'original-full.png'), fullPage: true });
    // Second exposure a beat later (still frozen): pixels that differ between
    // the two are time-driven (autoplaying video, ambient loops) — the
    // verifier masks exactly those in per-node diffs, reporting the area.
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(outDir, 'original-full-b.png'), fullPage: true });
    await page.evaluate(() => { const t = document.getElementById('__mf-freeze'); if (t) t.remove(); });

    // Stop the scroll-reveal observer so interaction-probe clicks below cannot
    // pollute the reveal mutation log.
    await page.evaluate(() => { if (window.__mfObs) window.__mfObs.disconnect(); });

    // Interaction probe runs LAST so its synthetic clicks cannot pollute the
    // ground-truth screenshots above. Driver-side circuit breaker on top of the
    // in-page budget, in case a probed click wedges the page entirely.
    let interaction;
    let probeTimedOut = false;
    let probeError = null;
    interaction = await Promise.race([
      page.evaluate(inPageInteractionProbe,
        { PROPS, budgetMs: cfg.probeBudgetMs, maxCandidates: cfg.maxCandidates,
          ambientIds, reasons: REASONS }).catch((e) => { probeError = e && e.message; return null; }),
      new Promise(r => setTimeout(() => { probeTimedOut = true; r(null); },
        cfg.probeBudgetMs + 30000)),
    ]);
    if (!interaction) {
      interaction = { probes: [], candidateIds: [],
        skippedProbes: [{ trigger: 'all',
          reason: probeTimedOut ? REASONS.TIME_BUDGET_EXCEEDED : REASONS.PROBE_ERROR,
          detail: probeError || undefined }] };
    }

    // Virtual mouse agent: JS-driven hover recovery + cursor-follower fit.
    let hoverProbes = [];
    try {
      hoverProbes = await Promise.race([
        page.evaluate(inPageHoverProbe,
          { PROPS, budgetMs: cfg.hoverBudgetMs, maxCandidates: cfg.maxCandidates, ambientIds }),
        new Promise(r => setTimeout(() => r([]), cfg.hoverBudgetMs + 15000)),
      ]) || [];
    } catch (e) { hoverProbes = []; }

    // Keyboard agent (v0.4): JS-driven focus behavior recovery. Programmatic
    // focus/blur per candidate, class + style diffs, page state restored.
    let focusProbes = [];
    try {
      focusProbes = await Promise.race([
        page.evaluate(inPageFocusProbe,
          { PROPS, budgetMs: cfg.focusBudgetMs, maxCandidates: cfg.maxCandidates, ambientIds }),
        new Promise(r => setTimeout(() => r([]), cfg.focusBudgetMs + 15000)),
      ]) || [];
    } catch (e) { focusProbes = []; }

    // Pointer choreography: sample the page's transforms over a 3x3 grid of
    // mouse positions (per-position settle lets lag-smoothed followers reach
    // their target), fit each node's matrix components as planes over the
    // pointer, then measure smoothing time constants from a step response.
    const cursorSamples = [];
    const gridF = [0.15, 0.5, 0.85];
    const pts = [];
    for (const fy of gridF) for (const fx of gridF) pts.push([fx, fy]);
    for (const [fx, fy] of pts.slice(0, cfg.cursorSamples)) {
      const mx = Math.round(width * fx), my = Math.round(height * fy);
      try {
        await page.mouse.move(mx, my, { steps: 4 });
        await page.waitForTimeout(cfg.cursorSettleMs);
        const snap = await page.evaluate(() => {
          const out = {};
          document.querySelectorAll('[data-mf-id]').forEach(el => {
            out[el.getAttribute('data-mf-id')] = getComputedStyle(el).transform;
          });
          return out;
        });
        cursorSamples.push({ mx, my, snap });
      } catch (e) { break; }
    }
    const cursor = fitPointerFields(cursorSamples);

    // Smoothing/lag: park the pointer, start a per-frame in-page sampler over
    // the recovered field nodes, jump the pointer across the viewport, and
    // estimate each node's exponential time constant from its step response.
    if (cursor.fields.length) {
      try {
        await page.mouse.move(Math.round(width * 0.2), Math.round(height * 0.25), { steps: 2 });
        await page.waitForTimeout(Math.max(600, cfg.cursorSettleMs));
        const fieldIds = cursor.fields.map(f => f.id);
        const samplerP = page.evaluate(({ ids, durationMs }) => new Promise((resolve) => {
          const els = ids.map(id => [id, document.querySelector(`[data-mf-id="${id}"]`)]);
          const out = {};
          for (const [id] of els) out[id] = [];
          const t0 = performance.now();
          (function tick() {
            const t = performance.now() - t0;
            for (const [id, el] of els) {
              if (el) out[id].push({ t, transform: getComputedStyle(el).transform });
            }
            if (t < durationMs) requestAnimationFrame(tick);
            else resolve(out);
          })();
        }), { ids: fieldIds, durationMs: cfg.pointerLagMs });
        await page.waitForTimeout(80);
        await page.mouse.move(Math.round(width * 0.8), Math.round(height * 0.75), { steps: 1 });
        const responses = await samplerP;
        for (const f of cursor.fields) {
          // Trim leading pre-jump frames: motion starts where the value first
          // deviates measurably from the parked state.
          const r = responses[f.id] || [];
          let start = 0;
          while (start < r.length - 1 && r[start + 1].transform === r[0].transform) start++;
          f.tauMs = estimateTau(r.slice(start), f);
        }
      } catch (e) { /* lag recovery is best-effort; fields stay tau 0 */ }
    }

    // Ground-truth pointer-state shots: the convergence step replays the same
    // pointer positions on the reconstruction and diffs against these.
    const pointerShots = [];
    if (cursor.fields.length) {
      const maxTau = Math.max(0, ...cursor.fields.map(f => f.tauMs || 0));
      const settle = Math.min(3000, Math.max(800, 5 * maxTau));
      for (let i = 0; i < (cfg.pointerCheckpoints || []).length; i++) {
        const [fx, fy] = cfg.pointerCheckpoints[i];
        const mx = Math.round(width * fx), my = Math.round(height * fy);
        try {
          await page.mouse.move(mx, my, { steps: 6 });
          await page.waitForTimeout(settle);
          const shot = `original-pointer-${i}.png`;
          await page.screenshot({ path: path.join(outDir, shot) });
          // Second exposure a beat later: pixels that differ are time-driven
          // (ambient loops, video), not pointer-driven — masked by the verifier.
          const shotB = `original-pointer-${i}-b.png`;
          await page.waitForTimeout(350);
          await page.screenshot({ path: path.join(outDir, shotB) });
          pointerShots.push({ mx, my, shot, shotB });
        } catch (e) { break; }
      }
    }
    await page.mouse.move(0, 0).catch(() => {});
    await page.waitForTimeout(cursor.fields.length ? Math.min(3000,
      Math.max(400, 5 * Math.max(0, ...cursor.fields.map(f => f.tauMs || 0)))) : 300);

    // Ground-truth focus-state shots (v0.4): REAL Tab key presses walk the
    // page's own tab order — the same presses trigger :focus-visible exactly
    // as a keyboard user would. The convergence step replays the same number
    // of Tabs on the reconstruction and diffs against these. Only taken when
    // there is recovered focus styling/behavior to verify.
    const focusShots = [];
    if (focusRules.length || focusProbes.length) {
      try {
        await page.evaluate(() => {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(200);
        for (let k = 1; k <= (cfg.focusCheckpoints || 3); k++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(300);
          const focusedId = await page.evaluate(() =>
            document.activeElement && document.activeElement.getAttribute &&
            document.activeElement.getAttribute('data-mf-id'));
          if (!focusedId) break;
          const shot = `original-focus-${k}.png`;
          await page.screenshot({ path: path.join(outDir, shot) });
          // Second exposure a beat later: pixels that differ are time-driven,
          // not focus-driven — masked by the verifier with the fixed reason.
          const shotB = `original-focus-${k}-b.png`;
          await page.waitForTimeout(350);
          await page.screenshot({ path: path.join(outDir, shotB) });
          focusShots.push({ tabs: k, focusedId, shot, shotB });
        }
        await page.evaluate(() => {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        });
        await page.waitForTimeout(200);
      } catch (e) { /* focus shots are best-effort; verification simply has fewer states */ }
    }

    // Ground-truth screenshot per recovered interaction state (real clicks, not
    // class injection) — the convergence step replays the same click sequence on
    // the reconstruction and diffs against these.
    if (!probeTimedOut) {
      const baseSnap = await page.evaluate(() => {
        const m = {};
        document.querySelectorAll('[data-mf-id]').forEach(el => { m[el.getAttribute('data-mf-id')] = el.className; });
        return m;
      });
      for (const p of interaction.probes) {
        const seq = p.underState ? [p.underState, p.trigger] : [p.trigger];
        try {
          for (const t of seq) {
            await page.click(`[data-mf-id="${t}"]`, { force: true, timeout: 5000 });
            await page.waitForTimeout(400);
          }
          p.clickSeq = seq;
          p.stateShot = `state-${p.trigger}.png`;
          await page.screenshot({ path: path.join(outDir, p.stateShot) });
        } catch (e) {
          p.stateShotError = REASONS.TIME_BUDGET_EXCEEDED;
        }
        await page.evaluate((snap) => {
          document.querySelectorAll('[data-mf-id]').forEach(el => {
            const w = snap[el.getAttribute('data-mf-id')];
            if (w != null && el.className !== w) el.className = w;
          });
        }, baseSnap);
        await page.waitForTimeout(150);
      }
    }

    // Responsive re-capture (v0.4): resize the SAME page to each requested
    // breakpoint width, let media queries + resize handlers settle, and
    // re-read the full tracked style set + rects of every node, plus a
    // ground-truth screenshot per width. Runs last — the resize would
    // invalidate every viewport-coordinate probe above.
    const responsive = [];
    for (const bw of (cfg.breakpoints || []).filter(w => w > 0 && w !== width)) {
      try {
        await page.setViewportSize({ width: bw, height });
        await page.waitForTimeout(cfg.breakpointSettleMs);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(250);
        const styles = await page.evaluate(inPageBreakpointSnapshot, PROPS);
        const shot = `original-bp-${bw}.png`;
        await page.screenshot({ path: path.join(outDir, shot) });
        const shotB = `original-bp-${bw}-b.png`;
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(outDir, shotB) });
        responsive.push({ width: bw, styles, shot, shotB });
      } catch (e) { break; } // best-effort per width; verification has fewer states
    }

    await browser.close();

    const bundle = { url, capturedAt: new Date().toISOString(),
                     viewport: raw.viewport, scrollHeight: raw.scrollHeight,
                     tree: raw.tree, flat: raw.flat,
                     animations: raw.animations, transitions: raw.transitions,
                     hoverRules, revealMutations: mutations,
                     probes: interaction.probes,
                     candidateIds: interaction.candidateIds,
                     fontFaces,
                     assets: store.manifest(),
                     frameTracks,
                     scrollTracks, maxScroll, scrollShots,
                     hoverProbes,
                     focusRules, focusProbes, focusShots,
                     responsive,
                     pointerFields: cursor.fields,
                     pointerShots,
                     unclassifiedPointer: cursor.unclassified,
                     scope: {
                       skips: raw.skips || [],
                       ambientIds,
                       skippedProbes: interaction.skippedProbes || [],
                       crossOriginSheets,
                       navFallback,
                       settled,
                     },
                     timings: { gotoMs, captureMs: Date.now() - t0 } };

    fs.writeFileSync(path.join(outDir, 'capture.json'), JSON.stringify(bundle, null, 2));
    return bundle;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

module.exports = { capture, DEFAULTS };
