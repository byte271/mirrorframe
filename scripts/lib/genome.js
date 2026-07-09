// Mirrorframe v1 — Genome Compiler.
// Distills the raw capture bundle into a Design Genome: color/type/space tokens,
// a component-ish node tree with token references, recovered motion tracks
// (declared tier only), and hover/reveal behavior. This is honest clustering,
// not the blueprint's anti-unification/idiom induction — see ROADMAP.md.

const { REASONS } = require('./reasons');

// The ambient watch reports nodes seen mutating with no input. A timer
// typically rotates a class among a peer group (carousel slides), and the
// watch window may catch only some members — expand to siblings sharing a
// class with an observed mutator: the whole group is timer-driven.
function expandAmbient(bundle) {
  const ids = new Set((bundle.scope && bundle.scope.ambientIds) || []);
  if (!ids.size) return ids;
  (function expand(node) {
    for (const k of node.children) {
      if (!ids.has(k.id)) continue;
      const cls = new Set(k.classes || []);
      for (const sib of node.children) {
        if (sib !== k && (sib.classes || []).some(c => cls.has(c))) ids.add(sib.id);
      }
    }
    for (const c of node.children) expand(c);
  })(bundle.tree);
  return ids;
}

function tally(arr) {
  const m = new Map();
  for (const v of arr) if (v != null && v !== '') m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function slug(prefix, i) { return `${prefix}-${i + 1}`; }

function buildGenome(bundle) {
  const flat = bundle.flat;

  // --- Token Crystallizer (colors) ---
  const colorVals = [];
  for (const n of flat) {
    if (n.style.color) colorVals.push(n.style.color);
    if (n.style.backgroundColor && n.style.backgroundColor !== 'rgba(0, 0, 0, 0)')
      colorVals.push(n.style.backgroundColor);
  }
  const colorRank = tally(colorVals);
  const colorTokens = {};
  const colorToVar = new Map();
  colorRank.forEach(([val], i) => {
    const name = slug('color', i);
    colorTokens[name] = val;
    colorToVar.set(val, name);
  });

  // --- Type scale ---
  const sizeRank = tally(flat.map(n => n.style.fontSize));
  const typeTokens = {};
  const sizeToVar = new Map();
  sizeRank.forEach(([val], i) => {
    const name = slug('text', i);
    typeTokens[name] = val;
    sizeToVar.set(val, name);
  });
  const families = tally(flat.map(n => n.style.fontFamily)).map(([v]) => v);

  // --- Spacing lattice (padding + gap numeric px) ---
  const spaceVals = [];
  for (const n of flat) {
    for (const k of ['padding','gap','marginBottom']) {
      const v = n.style[k];
      if (v) v.split(' ').forEach(part => {
        const px = parseFloat(part);
        if (!isNaN(px) && px > 0) spaceVals.push(Math.round(px));
      });
    }
  }
  const spaceRank = tally(spaceVals.map(String)).map(([v]) => parseInt(v)).sort((a,b)=>a-b);

  const radiusRank = tally(flat.map(n => n.style.borderRadius)).map(([v]) => v).filter(v => v && v !== '0px');
  const shadowRank = tally(flat.map(n => n.style.boxShadow)).map(([v]) => v).filter(v => v && v !== 'none');

  // --- Motion DNA (declared tier) ---
  // Keep only genuine keyframe animations (CSSAnimation / WAAPI). CSSTransition
  // objects also surface via getAnimations() but are modeled as transitions and
  // (for reveal) as the scroll-reveal state machine — not as @keyframes.
  const keyframeAnims = bundle.animations.filter(a =>
    a.type === 'CSSAnimation' || a.type === 'Animation');
  const reveal = recoverReveal(bundle);
  // Scroll tracks: per-node visual-prop samples across the scroll sweep.
  // Nodes already driven by the recovered class-based reveal machine or by
  // timer-driven (ambient) mutation are excluded — one recovered mechanism
  // per node, never two fighting drivers.
  const trackExcluded = new Set([
    ...(reveal.detected ? reveal.revealedIds : []),
    ...expandAmbient(bundle),
  ]);
  // Frame-sampled (time-driven) props vary with NO scroll input: any scroll
  // "track" observed on the same (id, prop) is time aliasing, not scroll
  // choreography — the frame track is the recovered mechanism, keep only it.
  const frameTracks = bundle.frameTracks || [];
  const frameKeys = new Set(frameTracks.map(t => `${t.id}|${t.prop}`));
  const allTracks = (bundle.scrollTracks || []).filter(t =>
    !trackExcluded.has(t.id) && !frameKeys.has(`${t.id}|${t.prop}`));
  // One-way reveals (changed during the sweep, did not revert at scroll 0):
  // their settled value IS the node's steady-state style — fold it into the
  // captured style so reconstruction renders the revealed state, and keep only
  // genuinely scroll-linked tracks for the replay runtime.
  const persistentEffects = allTracks.filter(t => t.persistent);
  const scrollTracks = allTracks.filter(t => !t.persistent);
  if (persistentEffects.length) {
    const byId = new Map();
    (function idx(n) { byId.set(n.id, n); (n.children || []).forEach(idx); })(bundle.tree);
    for (const t of persistentEffects) {
      const node = byId.get(t.id);
      if (node && node.style) node.style[t.prop] = t.value;
    }
  }
  const motion = {
    animations: keyframeAnims.map(a => ({
      target: a.targetId, classes: a.targetClasses,
      duration: a.duration, easing: a.easing, iterations: a.iterations,
      direction: a.direction, keyframes: a.keyframes,
    })),
    transitions: dedupeTransitions(bundle.transitions),
    // Reveal behavior recovered from IntersectionObserver-driven class mutations.
    reveal,
    scrollTracks,
    frameTracks,
    persistentEffects: persistentEffects.map(t => ({ id: t.id, prop: t.prop })),
    maxScroll: bundle.maxScroll || 0,
    scrollShots: bundle.scrollShots || [],
  };

  // --- Interaction DNA: hover (from CSS rules) + click-driven state machines
  //     (from the interaction probe) ---
  const hover = bundle.hoverRules.map(r => ({
    selector: r.selector, declarations: r.declarations,
  }));
  const { behaviors, unclassified } = classifyBehaviors(bundle);
  // Virtual-mouse recoveries: JS-driven hover deltas + pointer choreography
  // fields (per-matrix-component planes over the pointer, with smoothing time
  // constants). Pointer-driven nodes that fit no planar model arrive as
  // unclassified (fixed reason) from capture — surfaced, not guessed.
  const hoverJs = bundle.hoverProbes || [];
  const pointerFields = bundle.pointerFields || [];
  for (const u of bundle.unclassifiedPointer || []) unclassified.push(u);
  // Keyboard/focus DNA (v0.4): CSS :focus(-visible/-within) rules recovered
  // verbatim + JS-driven focus deltas from the keyboard agent.
  const focus = bundle.focusRules || [];
  const focusJs = bundle.focusProbes || [];

  // --- Responsive DNA (v0.4): per-breakpoint style overrides ---
  // Each re-capture width contributes, per node, exactly the tracked props
  // whose computed value differs from the base-width capture. Reconstruction
  // emits these as @media rules; the observed breakpoint states are then
  // pixel-verified against the ground-truth shots taken at each width.
  const responsive = (bundle.responsive || []).map(r => {
    const overrides = {};
    for (const n of flat) {
      const s = r.styles && r.styles[n.id];
      if (!s || !n.style || n.placeholder) continue;
      const d = {};
      for (const p of Object.keys(s.style)) {
        if (n.style[p] !== undefined && s.style[p] !== n.style[p]) d[p] = s.style[p];
      }
      if (Object.keys(d).length) overrides[n.id] = d;
    }
    return { width: r.width, shot: r.shot, shotB: r.shotB, overrides };
  });

  // --- Structure with token references ---
  function annotate(node) {
    const s = node.style;
    const tokenRefs = {};
    if (s.color && colorToVar.has(s.color)) tokenRefs.color = colorToVar.get(s.color);
    if (s.backgroundColor && colorToVar.has(s.backgroundColor)) tokenRefs.bg = colorToVar.get(s.backgroundColor);
    if (s.fontSize && sizeToVar.has(s.fontSize)) tokenRefs.text = sizeToVar.get(s.fontSize);
    return {
      id: node.id, tag: node.tag, classes: node.classes,
      text: node.text, href: node.href, rect: node.rect,
      wsBefore: node.wsBefore,
      src: node.src, alt: node.alt,
      naturalW: node.naturalW, naturalH: node.naturalH,
      svgMarkup: node.svgMarkup,
      media: node.media, poster: node.poster, frame: node.frame,
      mediaAttrs: node.mediaAttrs,
      placeholder: node.placeholder || undefined, reason: node.reason,
      style: node.style, pseudo: node.pseudo, tokenRefs,
      children: node.children.map(annotate),
    };
  }

  return {
    meta: { url: bundle.url, capturedAt: bundle.capturedAt, viewport: bundle.viewport,
            generator: 'mirrorframe-v1' },
    tokens: {
      color: colorTokens,
      text: typeTokens,
      fontFamilies: families,
      space: spaceRank,
      radius: radiusRank,
      shadow: shadowRank,
    },
    motion,
    interaction: { hover, hoverJs, pointerFields,
                   pointerShots: bundle.pointerShots || [],
                   focus, focusJs, focusShots: bundle.focusShots || [],
                   behaviors, unclassified },
    responsive,
    assets: bundle.assets || { map: {}, misses: [] },
    fontFaces: bundle.fontFaces || [],
    // Scope report: everything capture could not handle, with fixed reasons.
    // Verification uses this to mask/skip — nothing here is silently dropped.
    scope: {
      skips: (bundle.scope && bundle.scope.skips) || [],
      ambientIds: [...expandAmbient(bundle)],
      skippedProbes: (bundle.scope && bundle.scope.skippedProbes) || [],
      crossOriginSheets: (bundle.scope && bundle.scope.crossOriginSheets) || 0,
      navFallback: !!(bundle.scope && bundle.scope.navFallback),
    },
    timings: bundle.timings,
    structure: annotate(bundle.tree),
  };
}

// ---------------------------------------------------------------------------
// Behavior classification (Kinesis v1.5).
// Input: raw probe observations {trigger, m1:[{id,added,removed}], reversible,
// styleDeltas, clickSeq, stateShot}. Output: named state machines. Class names
// are recovered from the page, never assumed.
//
//   toggle    — second click reverses the first (accordion item, hamburger)
//   exclusive — one click adds a class to some nodes and removes the SAME
//               class from sibling nodes (tabs / segmented controls)
//   pair      — one trigger adds a class, a different trigger removes it
//               (modal open/close)
//
// Each behavior also carries styleStates: per affected node, the tracked props
// whose computed value differs between class-on and class-off, normalized so
// `on` is always the value WITH the class present.
// ---------------------------------------------------------------------------
function classifyBehaviors(bundle) {
  const probes = bundle.probes || [];
  const candidates = new Set(bundle.candidateIds || []);
  const behaviors = [];
  const used = new Set();

  // Normalize styleDeltas: probe direction -> class-on/class-off.
  // addedIds: nodes that GAINED the class in m1 (their delta.on is class-on);
  // removedIds: nodes that LOST it (delta is inverted). Descendant nodes take
  // the direction of their nearest changed ancestor (resolved at emission via
  // the structure tree; here we tag the probe direction per node).
  function styleStates(probe, cls) {
    const gained = new Set(), lost = new Set();
    for (const d of probe.m1) {
      if (d.added.includes(cls)) gained.add(d.id);
      if (d.removed.includes(cls)) lost.add(d.id);
    }
    const out = [];
    for (const [id, deltas] of Object.entries(probe.styleDeltas || {})) {
      const inverted = lost.has(id);
      for (const [prop, v] of Object.entries(deltas)) {
        out.push({ id, prop,
                   off: inverted ? v.on : v.off,
                   on: inverted ? v.off : v.on,
                   directionKnown: gained.has(id) || lost.has(id) });
      }
    }
    return out;
  }

  const classesOf = (m1) => {
    const s = new Set();
    for (const d of m1) { d.added.forEach(c => s.add(c)); d.removed.forEach(c => s.add(c)); }
    return [...s];
  };

  // --- exclusive groups: non-reversible probes with adds AND removes of the
  // same class on different nodes ---
  const exclusiveByCls = new Map();
  for (const p of probes) {
    if (p.reversible) continue;
    for (const cls of classesOf(p.m1)) {
      const addedTo = p.m1.filter(d => d.added.includes(cls)).map(d => d.id);
      const removedFrom = p.m1.filter(d => d.removed.includes(cls)).map(d => d.id);
      if (addedTo.length && removedFrom.length) {
        if (!exclusiveByCls.has(cls)) exclusiveByCls.set(cls, []);
        exclusiveByCls.get(cls).push({ probe: p, addedTo, removedFrom });
        used.add(p.trigger + '|' + cls);
      }
    }
  }
  for (const [cls, obs] of exclusiveByCls) {
    const entries = obs.map(o => ({ trigger: o.probe.trigger, targets: o.addedTo }));
    // Infer the initially-active entry from what the observed clicks deactivate.
    const deactivated = new Set(obs.flatMap(o => o.removedFrom));
    const known = new Set(entries.flatMap(e => e.targets));
    const initialTargets = [...deactivated].filter(id => !known.has(id));
    if (initialTargets.length) {
      const initTrigger = initialTargets.find(id => candidates.has(id));
      if (initTrigger) entries.unshift({ trigger: initTrigger, targets: initialTargets, initial: true });
    }
    behaviors.push({
      type: 'exclusive', cls, entries,
      styleStates: obs.flatMap(o => styleStates(o.probe, cls)),
      evidence: obs.map(o => ({ trigger: o.probe.trigger, stateShot: o.probe.stateShot, clickSeq: o.probe.clickSeq })),
    });
  }

  // --- pairs: trigger A adds cls to node set S, trigger B removes cls from S ---
  for (const pa of probes) {
    if (pa.reversible) continue;
    for (const cls of classesOf(pa.m1)) {
      if (used.has(pa.trigger + '|' + cls)) continue;
      const adds = pa.m1.filter(d => d.added.includes(cls)).map(d => d.id);
      const removes = pa.m1.filter(d => d.removed.includes(cls)).map(d => d.id);
      if (!adds.length || removes.length) continue;
      const closer = probes.find(pb => pb !== pa && !pb.reversible &&
        pb.m1.every(d => !d.added.length || !d.added.includes(cls)) &&
        adds.every(id => pb.m1.some(d => d.id === id && d.removed.includes(cls))));
      if (closer) {
        used.add(pa.trigger + '|' + cls); used.add(closer.trigger + '|' + cls);
        behaviors.push({
          type: 'pair', cls, open: pa.trigger, close: closer.trigger, targets: adds,
          styleStates: styleStates(pa, cls),
          evidence: [
            { trigger: pa.trigger, stateShot: pa.stateShot, clickSeq: pa.clickSeq },
            { trigger: closer.trigger, stateShot: closer.stateShot, clickSeq: closer.clickSeq },
          ],
        });
      }
    }
  }

  // --- toggles: reversible probes ---
  const toggleByCls = new Map();
  for (const p of probes) {
    if (!p.reversible) continue;
    for (const cls of classesOf(p.m1)) {
      if (used.has(p.trigger + '|' + cls)) continue;
      const targets = p.m1
        .filter(d => d.added.includes(cls) || d.removed.includes(cls))
        .map(d => d.id);
      if (!targets.length) continue;
      if (!toggleByCls.has(cls)) toggleByCls.set(cls, []);
      toggleByCls.get(cls).push({ probe: p, targets });
      used.add(p.trigger + '|' + cls);
    }
  }
  for (const [cls, obs] of toggleByCls) {
    behaviors.push({
      type: 'toggle', cls,
      triggers: obs.map(o => ({ trigger: o.probe.trigger, targets: o.targets })),
      styleStates: obs.flatMap(o => styleStates(o.probe, cls)),
      evidence: obs.map(o => ({ trigger: o.probe.trigger, stateShot: o.probe.stateShot, clickSeq: o.probe.clickSeq })),
    });
  }

  // Probes whose class mutations matched none of the recoverable state
  // machines: reported as unclassified, never silently dropped or forced into
  // the nearest pattern. Ambient (timer-driven) mutators are unclassified by
  // definition — they have no input trigger.
  const unclassified = [];
  for (const p of probes) {
    const consumed = classesOf(p.m1).some(cls => used.has(p.trigger + '|' + cls));
    if (!consumed) unclassified.push({ trigger: p.trigger, reason: REASONS.UNCLASSIFIED_BEHAVIOR, kind: 'probe' });
  }
  for (const id of expandAmbient(bundle))
    unclassified.push({ trigger: id, reason: REASONS.UNCLASSIFIED_BEHAVIOR, kind: 'ambient' });

  return { behaviors, unclassified };
}

function dedupeTransitions(transitions) {
  const seen = new Map();
  for (const t of transitions) {
    const key = t.classes.join('.') + '|' + t.property + '|' + t.duration;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

// Reveal = elements that gained a class during the scroll probe. Both the
// added ("visible") class and the shared marker ("trigger") class are
// RECOVERED from the mutation log — nothing is assumed by name.
function recoverReveal(bundle) {
  const byId = new Map(bundle.flat.map(n => [n.id, n]));
  const ambient = expandAmbient(bundle);

  // Which class was added to each mutated node, relative to its captured state?
  // Ambient (timer-driven) mutators are excluded — their class churn during
  // the scroll probe is not scroll-caused.
  const addedByNode = new Map();
  for (const m of bundle.revealMutations) {
    if (ambient.has(m.id)) continue;
    const node = byId.get(m.id);
    if (!node || !m.classes) continue;
    const orig = new Set(node.classes);
    for (const c of m.classes) {
      if (!orig.has(c)) {
        if (!addedByNode.has(m.id)) addedByNode.set(m.id, new Set());
        addedByNode.get(m.id).add(c);
      }
    }
  }
  if (addedByNode.size === 0) return { detected: false };

  // visibleClass: the most common scroll-added class.
  const counts = new Map();
  for (const set of addedByNode.values())
    for (const c of set) counts.set(c, (counts.get(c) || 0) + 1);
  const visibleClass = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const revealedIds = [...addedByNode.keys()]
    .filter(id => addedByNode.get(id).has(visibleClass));

  // triggerClass: the class shared by every reveal participant — nodes that
  // gained visibleClass during the scroll probe PLUS nodes already captured
  // with it (elements that intersected on load, before the observer ran).
  const participants = new Set(revealedIds);
  for (const n of bundle.flat)
    if (n.classes.includes(visibleClass)) participants.add(n.id);
  let shared = null;
  for (const id of participants) {
    const cs = new Set(byId.get(id).classes);
    cs.delete(visibleClass);
    shared = shared === null ? cs : new Set([...shared].filter(c => cs.has(c)));
  }
  const triggerClass = shared ? [...shared][0] : null;
  if (!triggerClass) return { detected: false };

  // Hidden-state style: sampled from a reveal element that was still hidden
  // (opacity 0) at capture time. If every reveal element was already visible
  // at capture, the hidden state is unobservable — report null (the
  // reconstruction then skips the hidden state rather than inventing one).
  const hiddenNode = bundle.flat.find(n =>
    n.classes.includes(triggerClass) && !n.classes.includes(visibleClass) &&
    parseFloat(n.style.opacity) === 0);

  // Per-element transition curves: each participant's captured computed
  // `transition` carries its own duration, easing, and delay — CSS-authored
  // stagger (per-item transition-delay) and per-element easing are replayed
  // verbatim. Zero-duration values (the 'all 0s ease 0s' default) are
  // omitted; those nodes fall back to the generic reveal transition.
  const hasDuration = (t) => (t || '').split(',').some(part => {
    const m = /(-?[\d.]+)(m?s)/.exec(part);
    return m && parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) > 0;
  });
  const transitionsByNode = {};
  for (const id of participants) {
    const t = byId.get(id).style && byId.get(id).style.transition;
    if (hasDuration(t)) transitionsByNode[id] = t;
  }

  // Stagger recovery from mutation timestamps: elements revealed in one burst
  // (a shared intersection event, staggered by JS timers) carry their firing
  // offsets relative to the burst start; the median gap seeds unobserved
  // elements at replay time. A gap > 500ms starts a new burst — that is a new
  // intersection, not stagger.
  const firedAt = new Map();
  for (const m of bundle.revealMutations) {
    if (m.t == null || firedAt.has(m.id)) continue;
    if (addedByNode.has(m.id) && (m.classes || []).includes(visibleClass) &&
        addedByNode.get(m.id).has(visibleClass)) firedAt.set(m.id, { t: m.t, y: m.y });
  }
  // A node whose own CSS transition already carries a delay staggers itself —
  // adding its mutation offset on top would double the delay.
  const hasCssDelay = (id) => {
    const t = transitionsByNode[id];
    return !!t && t.split(',').some(part => {
      const times = part.match(/(-?[\d.]+)(m?s)/g) || [];
      if (times.length < 2) return false;
      const last = /(-?[\d.]+)(m?s)/.exec(times[times.length - 1]);
      return parseFloat(last[1]) * (last[2] === 's' ? 1000 : 1) >= 30;
    });
  };
  const ordered = [...firedAt.entries()].sort((a, b) => a[1].t - b[1].t);
  const staggerMs = {};
  const gaps = [];
  let burstStart = null, prevT = null, prevY = null;
  for (const [id, { t, y }] of ordered) {
    // New burst: a long silence OR a different scroll position — elements that
    // intersected at different sweep steps are NOT staggered peers.
    if (burstStart === null || t - prevT > 500 || (y != null && y !== prevY)) burstStart = t;
    else gaps.push(t - prevT);
    staggerMs[id] = hasCssDelay(id) ? 0 : Math.min(2000, Math.round(t - burstStart));
    prevT = t; prevY = y;
  }
  const sortedGaps = gaps.filter(g => g >= 30).sort((a, b) => a - b);
  const staggerStep = sortedGaps.length >= 2
    ? Math.min(600, Math.round(sortedGaps[Math.floor(sortedGaps.length / 2)])) : 0;

  return {
    detected: true,
    triggerClass,
    visibleClass,
    threshold: 0.2, // reconstruction parameter, not a recovered value
    hiddenStyle: hiddenNode
      ? { opacity: hiddenNode.style.opacity, transform: hiddenNode.style.transform }
      : null,
    revealedIds,
    transitionsByNode,
    staggerMs,
    staggerStep,
  };
}

module.exports = { buildGenome };
