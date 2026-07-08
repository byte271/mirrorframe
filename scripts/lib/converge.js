// Mirrorframe — Convergence Loop.
// 1. Renders the reconstruction under the SAME viewport as capture and diffs
//    fold + full page (aggregate) AND every tracked node individually.
//    Aggregates are reported ALONGSIDE per-node results, never instead.
// 2. Residual auto-correction: for each failing node, the recon's computed
//    style is re-read, diffed against the captured style, and a per-node patch
//    rule is appended; the page is re-rendered and failing nodes re-verified
//    ONCE. Nodes are then marked pass / corrected / failed.
// 3. Behavioral verification: every recovered interaction state is replayed on
//    the reconstruction with real clicks and diffed against the ground-truth
//    state screenshot taken at capture time.

const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const fs = require('fs');
const path = require('path');
const { PROPS, normColor } = require('./props');
const { REASONS } = require('./reasons');

const NODE_PASS = 0.98;
const STATE_PASS = 0.98;
const DIFF_THRESHOLD = 0.12;

function loadPng(p) { return PNG.sync.read(fs.readFileSync(p)); }

function toSize(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      if (x < png.width && y < png.height) {
        const si = (y * png.width + x) * 4;
        out.data.set(png.data.subarray(si, si + 4), di);
      } else {
        out.data[di] = out.data[di+1] = out.data[di+2] = 255; out.data[di+3] = 255;
      }
    }
  }
  return out;
}

function crop(png, rect) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const w = Math.min(Math.ceil(rect.w), png.width - x);
  const h = Math.min(Math.ceil(rect.h), png.height - y);
  if (w <= 0 || h <= 0) return null;
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const si = ((y + row) * png.width + x) * 4;
    out.data.set(png.data.subarray(si, si + w * 4), row * w * 4);
  }
  return out;
}

function diffPngs(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const ao = toSize(a, w, h);
  const bo = toSize(b, w, h);
  const out = new PNG({ width: w, height: h });
  const mismatched = pixelmatch(ao.data, bo.data, out.data, w, h, { threshold: DIFF_THRESHOLD });
  return { image: out, width: w, height: h,
           mismatchedPixels: mismatched, totalPixels: w * h,
           residual: mismatched / (w * h), similarity: 1 - mismatched / (w * h) };
}

// Paint masked regions the same neutral color in BOTH images so out-of-scope
// content (iframes, media, ambient mutators) is excluded from the diff without
// biasing it. The masked area is reported — exclusion is never silent.
function applyMask(png, rects) {
  let area = 0;
  for (const r of rects || []) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.w));
    const y1 = Math.min(png.height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = png.data[i+1] = png.data[i+2] = 238; png.data[i+3] = 255;
      }
    }
    area += Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  }
  return area;
}

function diffFiles(origPath, reconPath, diffOutPath, maskRects, timeVaryingPath) {
  const a = loadPng(origPath);
  const b = loadPng(reconPath);
  const maskedArea = applyMask(a, maskRects);
  applyMask(b, maskRects);
  let timeVaryingPixels = 0;
  if (timeVaryingPath && fs.existsSync(timeVaryingPath)) {
    timeVaryingPixels = maskTimeVarying(a, b, loadPng(timeVaryingPath));
  }
  const r = diffPngs(a, b);
  fs.writeFileSync(diffOutPath, PNG.sync.write(r.image));
  const { image, ...rest } = r;
  return { ...rest, maskedPixels: maskedArea, timeVaryingPixels };
}

// Two exposures of the SAME original state taken a beat apart isolate pixels
// that are time-driven (ambient float loops, videos), not scroll- or
// layout-driven. Those pixels are unverifiable at any single instant: they
// are neutralized in both images (dilated to cover inter-shot drift) and the
// masked area is reported — exclusion is never silent.
const TV_DILATE = 12;
function maskTimeVarying(a, b, second) {
  const w = Math.min(a.width, second.width), h = Math.min(a.height, second.height);
  const moving = new Uint8Array(w * h);
  const diff = new PNG({ width: w, height: h });
  pixelmatch(toSize(a, w, h).data, toSize(second, w, h).data, diff.data, w, h,
             { threshold: DIFF_THRESHOLD });
  for (let i = 0; i < w * h; i++) {
    const d = diff.data[i * 4];
    if (d === 255 && diff.data[i * 4 + 1] === 0) moving[i] = 1;
  }
  // Dilate by row/column sweeps (cheap box dilation).
  const dil = new Uint8Array(moving);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!moving[y * w + x]) continue;
      for (let dy = -TV_DILATE; dy <= TV_DILATE; dy += 4) {
        for (let dx = -TV_DILATE; dx <= TV_DILATE; dx += 4) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) dil[yy * w + xx] = 1;
        }
      }
    }
  }
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!dil[y * w + x]) continue;
      count++;
      for (const img of [a, b]) {
        if (x < img.width && y < img.height) {
          const i = (y * img.width + x) * 4;
          img.data[i] = img.data[i+1] = img.data[i+2] = 238; img.data[i+3] = 255;
        }
      }
    }
  }
  return count;
}

function flatten(node, out = []) {
  out.push(node);
  for (const c of node.children) flatten(c, out);
  return out;
}

// Ids of nodes with an infinite animation: their pixels legitimately depend on
// WHEN the screenshot fired, so a mismatch is an expected temporal residual,
// not a reconstruction error. (JSON serializes Infinity as null.)
function animatedIds(genome) {
  const s = new Set();
  for (const a of genome.motion.animations) {
    if (a.iterations == null || !isFinite(a.iterations)) s.add(a.target);
  }
  return s;
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      window.scrollTo(0, (document.body.scrollHeight * i) / steps);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

// Bounded visual settle: staggered reveals and lag-smoothed pointer effects
// keep painting after the input stops; wait until two consecutive viewport
// screenshots match before shooting ground-truth comparisons.
async function settleShot(page, extraMs = 3000) {
  let prev = await page.screenshot();
  const t0 = Date.now();
  while (Date.now() - t0 < extraMs) {
    await page.waitForTimeout(300);
    const next = await page.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

async function shoot(page, outDir, prefix) {
  await page.screenshot({ path: path.join(outDir, `${prefix}-fold.png`) });
  await scrollThrough(page);
  await settleShot(page); // staggered reveal transitions must finish first
  // The original's fullPage shot is taken with tracked nodes frozen at their
  // settled scroll-0 values (see capture.js); the replay runtime holds the
  // same scroll-0 samples here, so both sides show the same defined state.
  await page.screenshot({ path: path.join(outDir, `${prefix}-full.png`), fullPage: true });
}

// Nodes whose class state churns without input (autoplay carousels etc.):
// the node itself plus its whole subtree is pixel-unstable by nature.
function ambientSet(genome) {
  const ids = new Set((genome.scope && genome.scope.ambientIds) || []);
  // A timer typically rotates a class among a peer group (e.g. carousel
  // slides); the watch window may only catch some members mutating. Expand to
  // siblings that share a class with an observed ambient mutator — the whole
  // group is timer-driven state.
  (function expand(node) {
    const kids = node.children;
    for (const k of kids) {
      if (!ids.has(k.id)) continue;
      const cls = new Set(k.classes || []);
      for (const sib of kids) {
        if (sib === k) continue;
        if ((sib.classes || []).some(c => cls.has(c))) ids.add(sib.id);
      }
    }
    for (const c of kids) expand(c);
  })(genome.structure);
  const out = new Set();
  (function mark(node, inside) {
    const here = inside || ids.has(node.id);
    if (here) out.add(node.id);
    for (const c of node.children) mark(c, here);
  })(genome.structure, false);
  return out;
}

// Time-varying content that IS replicated (bundled video/canvas stills,
// frame-sampled motion): the reconstruction reproduces the mechanism, but no
// single screenshot instant can match — masked with a fixed reason.
function timeVaryingSet(genome) {
  const ids = new Set();
  for (const t of (genome.motion && genome.motion.frameTracks) || []) ids.add(t.id);
  (function markMedia(node) {
    if (node.media) ids.add(node.id);
    for (const c of node.children) markMedia(c);
  })(genome.structure);
  const out = new Set();
  (function mark(node, inside) {
    const here = inside || ids.has(node.id);
    if (here) out.add(node.id);
    for (const c of node.children) mark(c, here);
  })(genome.structure, false);
  return out;
}

function maskRects(genome) {
  const rects = ((genome.scope && genome.scope.skips) || []).map(s => s.rect);
  const byId = new Map(flatten(genome.structure).map(n => [n.id, n]));
  for (const id of new Set([...ambientSet(genome), ...timeVaryingSet(genome)])) {
    const n = byId.get(id);
    if (n && n.rect && n.rect.w * n.rect.h >= 1) rects.push(n.rect);
  }
  return rects.filter(r => r && r.w > 0 && r.h > 0);
}

function perNodeDiff(genome, origFull, reconFull, anims, masks, origFullB) {
  const orig = loadPng(origFull);
  const recon = loadPng(reconFull);
  applyMask(orig, masks);
  applyMask(recon, masks);
  // Time-driven pixels (autoplaying video showing through translucent panels,
  // ambient loops) are unverifiable at any single instant: isolate them via
  // the second exposure and neutralize them in both images.
  if (origFullB && fs.existsSync(origFullB)) {
    maskTimeVarying(orig, recon, loadPng(origFullB));
  }
  const ambient = ambientSet(genome);
  const timeVarying = timeVaryingSet(genome);
  const results = [];
  for (const node of flatten(genome.structure)) {
    const rect = node.rect || { w: 0, h: 0 };
    const base = { id: node.id, tag: node.tag,
                   classes: (node.classes || []).join('.') || null, rect };
    if (node.placeholder) {
      results.push({ ...base, similarity: null, status: 'skipped', reason: node.reason });
      continue;
    }
    if (ambient.has(node.id)) {
      results.push({ ...base, similarity: null, status: 'skipped',
                     reason: REASONS.UNCLASSIFIED_BEHAVIOR });
      continue;
    }
    if (timeVarying.has(node.id)) {
      results.push({ ...base, similarity: null, status: 'time-varying-replicated',
                     reason: REASONS.TIME_VARYING_MEDIA });
      continue;
    }
    if (rect.w * rect.h < 1) {
      results.push({ ...base, similarity: null, status: 'hidden-at-capture' });
      continue;
    }
    const a = crop(orig, rect);
    const b = crop(recon, rect);
    if (!a || !b) {
      results.push({ ...base, similarity: null, status: 'out-of-bounds' });
      continue;
    }
    let d = diffPngs(a, b);
    let offset = null;
    // Sub-pixel rounding can land a node's rendering 1-2 device pixels off
    // (font rasterization baselines, fractional layout). If the same crop
    // matches at a small integer offset, the content is right and only the
    // sampling grid disagrees: take the best offset and REPORT it. A shift
    // that improves but still fails is discarded — the unshifted number is
    // the honest one.
    if (!anims.has(node.id) && d.similarity < NODE_PASS) {
      let best = d, bestOff = null;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const b2 = crop(recon, { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h });
          if (!b2) continue;
          const d2 = diffPngs(a, b2);
          if (d2.similarity > best.similarity) { best = d2; bestOff = { dx, dy }; }
        }
      }
      if (bestOff && best.similarity >= NODE_PASS) { d = best; offset = bestOff; }
    }
    let status;
    if (anims.has(node.id)) status = 'animated-unstable';
    else status = d.similarity >= NODE_PASS ? 'pass' : 'fail';
    results.push({ ...base, similarity: d.similarity, status,
                   ...(offset ? { pixelOffset: offset } : {}) });
  }
  return results;
}

// Read the recon's computed styles for a set of node ids (same PROPS list as
// capture) so failures can be attributed to concrete property drift.
async function readReconStyles(page, ids) {
  return page.evaluate(({ ids, props }) => {
    const norm = (c) => {
      const m = /^rgba?\(([^)]+)\)$/.exec(c);
      if (!m) return c;
      const [r, g, b, a = 1] = m[1].split(',').map(s => parseFloat(s.trim()));
      if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
      const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    };
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-mf-id="${id}"]`);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const s = {};
      for (const p of props) {
        let v = cs[p];
        if (v == null || v === '') continue;
        if (/color/i.test(p) && v.startsWith('rgb')) v = norm(v);
        s[p] = v;
      }
      out[id] = s;
    }
    return out;
  }, { ids, props: PROPS });
}

// Props eligible for auto-correction patches. Width/height stay excluded for
// the same reason they are never baked (see reconstruct.js).
const PATCHABLE = PROPS.filter(p => !['width','height','cursor','transition','animation'].includes(p));

function buildPatch(genome, reconStyles, failedIds) {
  const byId = new Map(flatten(genome.structure).map(n => [n.id, n]));
  const rules = [];
  const patchedProps = {};
  const styleClean = new Set(); // pixel-fail but ALL tracked computed props match
  for (const id of failedIds) {
    const want = byId.get(id) && byId.get(id).style;
    const got = reconStyles[id];
    if (!want || !got) continue;
    let anyDrift = false;
    const decls = [];
    for (const p of PROPS) {
      const w = want[p] != null ? normColor(want[p]) : want[p];
      const g = got[p] != null ? normColor(got[p]) : got[p];
      // url() values legitimately differ textually (original absolute URL vs
      // bundled local asset path) — pixel diff already judges the rendering.
      if (typeof w === 'string' && w.includes('url(')) continue;
      if (typeof g === 'string' && g.includes('url(')) continue;
      if (w != null && g != null && w !== g) {
        anyDrift = true;
        if (PATCHABLE.includes(p)) {
          decls.push(`  ${p.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}: ${w} !important;`);
        }
      }
    }
    if (!anyDrift) styleClean.add(id);
    if (decls.length) {
      patchedProps[id] = decls.map(d => d.trim().split(':')[0]);
      rules.push(`[data-mf-id="${id}"] {\n${decls.join('\n')}\n}`);
    }
  }
  return { css: rules.join('\n\n'), patchedProps, styleClean };
}

// The reconstruction may legitimately reference original asset URLs that
// never resolve (unfetchable at capture, recorded as asset misses) — so
// networkidle can never settle. Same bounded fallback discipline as capture.
async function gotoBounded(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  } catch (e) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
  }
}

// Layout convergence: flow reconstruction cannot always derive sizes the
// original computed via JS, viewport units, or aspect mechanisms. Measure
// every tracked node's rendered rect against the captured rect and bake the
// captured computed width/height (authored layout, from the genome) for the
// nodes that measurably drift; iterate until the layout stops improving.
const LAYOUT_TOL = 3;      // px drift tolerated per node
const LAYOUT_PASSES = 4;   // bounded

async function measureRects(page) {
  return page.evaluate(() => {
    const out = {};
    document.querySelectorAll('[data-mf-id]').forEach(el => {
      const r = el.getBoundingClientRect();
      out[el.getAttribute('data-mf-id')] = { x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height };
    });
    return out;
  });
}

async function layoutConverge(page, genome, recon, reconUrl) {
  const byId = flatten(genome.structure).filter(n =>
    !n.placeholder && n.rect && n.rect.w * n.rect.h >= 1 && n.style);
  const cssPath = path.join(recon.appDir, 'styles.css');
  const baked = new Set();
  const info = { passes: 0, baked: 0 };
  for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
    const got = await measureRects(page);
    const rules = [];
    for (const n of byId) {
      if (baked.has(n.id)) continue;
      const g = got[n.id];
      if (!g) continue;
      const decls = [];
      if (Math.abs(g.h - n.rect.h) > LAYOUT_TOL &&
          /^[\d.]+px$/.test(n.style.height || ''))
        decls.push(`  height: ${n.style.height} !important;`);
      if (Math.abs(g.w - n.rect.w) > LAYOUT_TOL &&
          /^[\d.]+px$/.test(n.style.width || ''))
        decls.push(`  width: ${n.style.width} !important;`);
      if (decls.length) {
        baked.add(n.id);
        rules.push(`[data-mf-id="${n.id}"] {\n${decls.join('\n')}\n}`);
      }
    }
    if (!rules.length) break;
    fs.appendFileSync(cssPath,
      `\n/* layout convergence pass ${pass + 1}: captured computed sizes baked for drifted nodes */\n${rules.join('\n\n')}\n`);
    info.passes = pass + 1;
    info.baked = baked.size;
    await gotoBounded(page, reconUrl);
  }
  return info;
}

async function converge(genome, recon, outDir) {
  const browser = await chromium.launch();
  const vp = genome.meta.viewport;
  const page = await browser.newPage({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1,
  });
  const reconUrl = 'file://' + path.resolve(recon.indexHtml);
  await gotoBounded(page, reconUrl);
  const layoutInfo = await layoutConverge(page, genome, recon, reconUrl);
  await shoot(page, outDir, 'recon');

  const masks = maskRects(genome);
  const report = {};
  report.layout = layoutInfo;
  report.maskedRegions = masks.length;
  report.fold = diffFiles(
    path.join(outDir, 'original-fold.png'),
    path.join(outDir, 'recon-fold.png'),
    path.join(outDir, 'diff-fold.png'), masks);
  report.full = diffFiles(
    path.join(outDir, 'original-full.png'),
    path.join(outDir, 'recon-full.png'),
    path.join(outDir, 'diff-full.png'), masks);

  // --- per-node verification ---
  const anims = animatedIds(genome);
  let nodes = perNodeDiff(genome,
    path.join(outDir, 'original-full.png'),
    path.join(outDir, 'recon-full.png'), anims, masks,
    path.join(outDir, 'original-full-b.png'));

  // --- residual auto-correction (single pass) ---
  const failedIds = nodes.filter(n => n.status === 'fail').map(n => n.id);
  report.correction = { attempted: failedIds, patchedProps: {}, applied: false, styleVerified: [] };
  if (failedIds.length) {
    const reconStyles = await readReconStyles(page, failedIds);
    const patch = buildPatch(genome, reconStyles, failedIds);
    report.correction.patchedProps = patch.patchedProps;
    report.correction.styleVerified = [...patch.styleClean];
    // Pixel residual with EVERY tracked computed prop matching the capture:
    // typically sub-pixel crop alignment / glyph anti-aliasing on tiny nodes.
    // Reported as its own per-node status — never folded into 'pass'.
    nodes = nodes.map(n => (n.status === 'fail' && patch.styleClean.has(n.id))
      ? { ...n, status: 'style-verified' } : n);
    if (patch.css) {
      const cssPath = path.join(recon.appDir, 'styles.css');
      fs.appendFileSync(cssPath, `\n/* convergence auto-correction (pass 2) */\n${patch.css}\n`);
      report.correction.applied = true;
      await gotoBounded(page, reconUrl);
      await shoot(page, outDir, 'recon');
      report.foldAfterCorrection = diffFiles(
        path.join(outDir, 'original-fold.png'),
        path.join(outDir, 'recon-fold.png'),
        path.join(outDir, 'diff-fold.png'), masks);
      report.fullAfterCorrection = diffFiles(
        path.join(outDir, 'original-full.png'),
        path.join(outDir, 'recon-full.png'),
        path.join(outDir, 'diff-full.png'), masks);
      const after = perNodeDiff(genome,
        path.join(outDir, 'original-full.png'),
        path.join(outDir, 'recon-full.png'), anims, masks,
        path.join(outDir, 'original-full-b.png'));
      const afterById = new Map(after.map(n => [n.id, n]));
      nodes = nodes.map(n => {
        if (n.status !== 'fail') return n;
        const a = afterById.get(n.id);
        return { ...n, similarityAfter: a.similarity,
                 status: a.similarity >= NODE_PASS ? 'corrected' : 'failed' };
      });
    }
    // Style drift existed but no patchable prop covered it — honest failure.
    nodes = nodes.map(n => n.status === 'fail'
      ? { ...n, status: 'failed', note: 'style-drift-not-patchable' } : n);
  }
  report.nodes = nodes;

  // --- behavioral verification: replay recovered states with real clicks ---
  report.states = [];
  for (const b of genome.interaction.behaviors || []) {
    for (const ev of b.evidence || []) {
      if (!ev.stateShot || !fs.existsSync(path.join(outDir, ev.stateShot))) continue;
      try {
        await gotoBounded(page, reconUrl);
        for (const t of ev.clickSeq) {
          await page.click(`[data-mf-id="${t}"]`, { force: true, timeout: 5000 });
          await page.waitForTimeout(400);
        }
        const reconShot = path.join(outDir, 'recon-' + ev.stateShot);
        await page.screenshot({ path: reconShot });
        const d = diffFiles(path.join(outDir, ev.stateShot), reconShot,
                            path.join(outDir, 'diff-' + ev.stateShot), masks);
        report.states.push({
          behavior: b.type, cls: b.cls, trigger: ev.trigger, clickSeq: ev.clickSeq,
          similarity: d.similarity, status: d.similarity >= STATE_PASS ? 'pass' : 'fail',
        });
      } catch (e) {
        report.states.push({
          behavior: b.type, cls: b.cls, trigger: ev.trigger, clickSeq: ev.clickSeq,
          similarity: null, status: 'fail', reason: REASONS.TIME_BUDGET_EXCEEDED,
        });
      }
    }
  }

  // --- scroll-state verification: replay the capture-time scroll checkpoints
  //     on the reconstruction and diff against the ground-truth screenshots.
  //     Checkpoints are absolute document-coordinate positions (layout
  //     convergence drives the recon to the original's coordinates); fall
  //     back to proportional mapping only when the recon range is shorter. ---
  report.scrollStates = [];
  const shots = genome.motion.scrollShots || [];
  if (shots.length) {
    try {
      await gotoBounded(page, reconUrl);
      const reconMax = await page.evaluate(() => Math.max(0,
        document.documentElement.scrollHeight - window.innerHeight));
      for (const s of shots) {
        const y = reconMax >= s.scrollY ? s.scrollY
                                        : Math.round(s.fraction * reconMax);
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(500);
        const reconShot = path.join(outDir, 'recon-' + s.shot);
        fs.writeFileSync(reconShot, await settleShot(page));
        // Mask rects are document-coordinate; shift into this viewport.
        const vMasks = masks.map(r => ({ ...r, y: r.y - s.scrollY }));
        const d = diffFiles(path.join(outDir, s.shot), reconShot,
                            path.join(outDir, 'diff-' + s.shot), vMasks,
                            s.shotB ? path.join(outDir, s.shotB) : null);
        report.scrollStates.push({
          fraction: s.fraction, scrollY: s.scrollY, reconScrollY: y,
          similarity: d.similarity, timeVaryingPixels: d.timeVaryingPixels,
          status: d.similarity >= STATE_PASS ? 'pass' : 'fail',
        });
      }
    } catch (e) {
      report.scrollStates.push({ similarity: null, status: 'fail',
                                 reason: REASONS.TIME_BUDGET_EXCEEDED });
    }
  }

  // --- pointer-state verification: replay the capture-time pointer
  //     checkpoints (real mouse moves) on the reconstruction and diff against
  //     the ground-truth screenshots. Settle wait scales with the largest
  //     recovered smoothing time constant. ---
  report.pointerStates = [];
  const pShots = genome.interaction.pointerShots || [];
  if (pShots.length) {
    const maxTau = Math.max(0,
      ...(genome.interaction.pointerFields || []).map(f => f.tauMs || 0));
    try {
      await gotoBounded(page, reconUrl);
      for (const s of pShots) {
        await page.mouse.move(s.mx, s.my, { steps: 6 });
        await page.waitForTimeout(Math.min(3000, Math.max(800, 5 * maxTau)));
        const reconShot = path.join(outDir, 'recon-' + s.shot);
        fs.writeFileSync(reconShot, await settleShot(page, 2000));
        const d = diffFiles(path.join(outDir, s.shot), reconShot,
                            path.join(outDir, 'diff-' + s.shot), masks,
                            s.shotB ? path.join(outDir, s.shotB) : null);
        report.pointerStates.push({
          mx: s.mx, my: s.my,
          similarity: d.similarity, timeVaryingPixels: d.timeVaryingPixels,
          status: d.similarity >= STATE_PASS ? 'pass' : 'fail',
        });
      }
    } catch (e) {
      report.pointerStates.push({ similarity: null, status: 'fail',
                                  reason: REASONS.TIME_BUDGET_EXCEEDED });
    }
  }

  await browser.close();

  report.summary = {
    nodes: {
      pass: nodes.filter(n => n.status === 'pass').length,
      styleVerified: nodes.filter(n => n.status === 'style-verified').length,
      corrected: nodes.filter(n => n.status === 'corrected').length,
      failed: nodes.filter(n => n.status === 'failed').length,
      animatedUnstable: nodes.filter(n => n.status === 'animated-unstable').length,
      hiddenAtCapture: nodes.filter(n => n.status === 'hidden-at-capture').length,
      timeVaryingReplicated: nodes.filter(n => n.status === 'time-varying-replicated').length,
      skipped: nodes.filter(n => n.status === 'skipped').length,
    },
    scope: genome.scope,
    states: {
      pass: report.states.filter(s => s.status === 'pass').length,
      fail: report.states.filter(s => s.status === 'fail').length,
    },
    scrollStates: {
      pass: report.scrollStates.filter(s => s.status === 'pass').length,
      fail: report.scrollStates.filter(s => s.status === 'fail').length,
    },
    pointerStates: {
      pass: report.pointerStates.filter(s => s.status === 'pass').length,
      fail: report.pointerStates.filter(s => s.status === 'fail').length,
    },
    assets: {
      bundled: (genome.assets && genome.assets.count) || 0,
      misses: ((genome.assets && genome.assets.misses) || []).length,
      fontFaces: (genome.fontFaces || []).length,
    },
    thresholds: { nodePass: NODE_PASS, statePass: STATE_PASS, pixelmatch: DIFF_THRESHOLD },
  };

  fs.writeFileSync(path.join(outDir, 'convergence.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { converge };
