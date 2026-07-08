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

const DEFAULTS = {
  navTimeoutMs: 30000,   // per navigation attempt (networkidle, then domcontentloaded fallback)
  probeBudgetMs: 60000,  // interaction-probe wall-clock budget
  maxCandidates: 200,    // interaction-probe candidate cap
  maxNodes: 1500,        // captured-node scale cap
  ambientWatchMs: 1500,  // input-free window to detect timer-driven class mutations
};

// ---------------------------------------------------------------------------
// In-page: structural + style extraction. Runs once at initial state.
// Elements outside the capture set are recorded as skips (tag + reason +
// document-coordinate rect, so verification can mask the region) — never
// silently dropped.
// ---------------------------------------------------------------------------
function inPageExtract({ PROPS, maxNodes, reasons }) {
  const CAPTURE_TAGS = ['BODY','HEADER','NAV','SECTION','DIV','SPAN','H1','H2','H3','P','A','BUTTON','BLOCKQUOTE','CITE','FOOTER','UL','LI'];
  const MEDIA_TAGS = ['CANVAS','VIDEO','AUDIO','SVG','IMG','PICTURE','OBJECT','EMBED'];
  const IGNORED_TAGS = ['SCRIPT','STYLE','LINK','META','NOSCRIPT','TEMPLATE','BR','WBR'];

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
        width: cs.width, height: cs.height, margin: cs.margin,
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

  function walk(el) {
    if (!CAPTURE_TAGS.includes(el.tagName)) return recordSkip(el);
    if (uid >= maxNodes) return recordSkip(el, reasons.SCALE_CAP_EXCEEDED);
    const rect = el.getBoundingClientRect();
    const id = 'n' + (uid++);
    el.setAttribute('data-mf-id', id);

    let ownText = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) ownText += child.textContent;
    }
    ownText = ownText.trim();

    const node = {
      id,
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      style: readStyle(el),
      text: ownText || undefined,
      href: el.getAttribute('href') || undefined,
      children: [],
    };
    for (const c of el.children) {
      const cn = walk(c);
      if (cn) {
        // Inter-element whitespace is layout-significant for inline siblings
        // (it renders as a word space); preserve it so codegen can re-emit it.
        const prev = c.previousSibling;
        if (prev && prev.nodeType === 3 && /\s/.test(prev.textContent)) cn.wsBefore = true;
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
           scrollHeight: document.body.scrollHeight };
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
// In-page: ambient-mutation watch. Observes class mutations for a fixed
// input-free window. Anything that mutates with NO input is timer/script
// driven (autoplay carousel, ticker) — not attributable to a click/scroll
// trigger, so it is out of scope for behavior recovery and must be excluded
// from probe diffs and per-node verification (reason: unclassified-behavior).
// ---------------------------------------------------------------------------
async function inPageAmbientWatch(windowMs) {
  const ids = new Set();
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const id = m.target.getAttribute && m.target.getAttribute('data-mf-id');
        if (id) ids.add(id);
      }
    }
  });
  obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
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

  async function probeOne(el) {
    const baseClasses = classSnapshot();
    const baseStyles = styleSnapshot();
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

    let raw;
    try {
      raw = await page.evaluate(inPageExtract,
        { PROPS, maxNodes: cfg.maxNodes, reasons: REASONS });
    } catch (e) {
      throw new MfSkip(REASONS.UNPARSEABLE_MARKUP, e.message);
    }
    if (!raw || raw.error) throw new MfSkip(REASONS.UNPARSEABLE_MARKUP, raw && raw.error);

    const { hoverRules, crossOriginSheets } = await page.evaluate(inPageHoverRules);

    // Ambient watch BEFORE any probing: timer-driven class churn must be known
    // so probe diffs and reveal recovery can exclude it.
    const ambientIds = await page.evaluate(inPageAmbientWatch, cfg.ambientWatchMs);

    const mutations = [];
    await page.exposeFunction('__mfMutation', (rec) => mutations.push(rec));

    // Screenshot at initial state (fold), before any probing mutates the page.
    await page.screenshot({ path: path.join(outDir, 'original-fold.png') });

    // Scroll probe: MutationObserver catches IntersectionObserver-driven class
    // toggles (scroll reveals).
    await page.evaluate(() => {
      const obs = window.__mfObs = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            window.__mfMutation({
              id: m.target.getAttribute && m.target.getAttribute('data-mf-id'),
              classes: m.target.classList ? [...m.target.classList] : [],
            });
          }
        }
      });
      obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    });
    await page.evaluate(async () => {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        window.scrollTo(0, (document.body.scrollHeight * i) / steps);
        await new Promise(r => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);

    await page.screenshot({ path: path.join(outDir, 'original-full.png'), fullPage: true });

    // Stop the scroll-reveal observer so interaction-probe clicks below cannot
    // pollute the reveal mutation log.
    await page.evaluate(() => { if (window.__mfObs) window.__mfObs.disconnect(); });

    // Interaction probe runs LAST so its synthetic clicks cannot pollute the
    // ground-truth screenshots above. Driver-side circuit breaker on top of the
    // in-page budget, in case a probed click wedges the page entirely.
    let interaction;
    let probeTimedOut = false;
    interaction = await Promise.race([
      page.evaluate(inPageInteractionProbe,
        { PROPS, budgetMs: cfg.probeBudgetMs, maxCandidates: cfg.maxCandidates,
          ambientIds, reasons: REASONS }).catch(() => null),
      new Promise(r => setTimeout(() => { probeTimedOut = true; r(null); },
        cfg.probeBudgetMs + 30000)),
    ]);
    if (!interaction) {
      interaction = { probes: [], candidateIds: [],
        skippedProbes: [{ trigger: 'all',
          reason: probeTimedOut ? REASONS.TIME_BUDGET_EXCEEDED : REASONS.UNPARSEABLE_MARKUP }] };
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

    await browser.close();

    const bundle = { url, capturedAt: new Date().toISOString(),
                     viewport: raw.viewport, scrollHeight: raw.scrollHeight,
                     tree: raw.tree, flat: raw.flat,
                     animations: raw.animations, transitions: raw.transitions,
                     hoverRules, revealMutations: mutations,
                     probes: interaction.probes,
                     candidateIds: interaction.candidateIds,
                     scope: {
                       skips: raw.skips || [],
                       ambientIds,
                       skippedProbes: interaction.skippedProbes || [],
                       crossOriginSheets,
                       navFallback,
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
