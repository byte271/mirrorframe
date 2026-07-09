// Mirrorframe — Reconstruction Compiler (single target: React + plain CSS).
// Compiles the Design Genome into a runnable React app. This is templated,
// deterministic codegen (no LLM required), which keeps output inspectable and
// reproducible. Multi-framework emission is on the ROADMAP.

const fs = require('fs');
const path = require('path');
const { rewriteCssUrls } = require('./assets');

// Note: fixed 'width'/'height' are deliberately NOT baked — block elements
// default to auto (fill) width; baking computed px causes overflow and defeats
// responsiveness. We keep maxWidth/minHeight, which carry real layout intent.
const LAYOUT_PROPS = [
  'display','position','top','right','bottom','left','flexDirection','flexWrap','justifyContent','alignItems','gap','listStyleType',
  'maxWidth','minHeight','padding','margin','marginTop','marginRight','marginBottom','marginLeft',
  'color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
  'borderRadius','boxShadow','opacity','transform','transition','textDecorationLine',
  'fontStyle','textAlign','flex','cursor','border','zIndex','animation',
  'borderTop','borderRight','borderBottom','borderLeft',
  'backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat',
  'objectFit','objectPosition','textTransform','whiteSpace','overflow',
  'mixBlendMode','filter','clipPath','textOverflow','verticalAlign',
  'gridTemplateColumns','gridTemplateRows','gridAutoFlow','gridColumn','gridRow',
  'rowGap','columnGap','justifySelf','alignSelf','alignContent','justifyItems',
  'aspectRatio','float','order'
];

// Asset-map context for the current generateCss run: url(...) references in
// emitted values are rewritten to the locally bundled copies.
let ASSET_MAP = {};
const ASSET_PREFIX = '../';
function cssValue(prop, v) {
  if (typeof v === 'string' && v.includes('url('))
    return rewriteCssUrls(v, ASSET_MAP, ASSET_PREFIX);
  return v;
}

const camelToKebab = (s) => s.replace(/[A-Z]/g, m => '-' + m.toLowerCase());

// Classes that represent recovered STATE (reveal visible-class, behavior
// toggle classes) rather than identity. They are excluded from style-rule
// signatures so that e.g. `.acc-item` and `.acc-item.open` unify, with the
// state difference expressed by the recovered behavior rules instead.
function stateClassSet(genome) {
  const s = new Set();
  const reveal = genome.motion.reveal;
  if (reveal.detected) s.add(reveal.visibleClass);
  for (const b of genome.interaction.behaviors || []) s.add(b.cls);
  return s;
}

function identityClasses(classes, stateClasses) {
  return (classes || []).filter(c => !stateClasses.has(c));
}

// Selector for a node: identity-class signature if classed, else its id.
function selOf(node, stateClasses) {
  const ident = identityClasses(node.classes, stateClasses);
  return ident.length ? '.' + ident.join('.') : `[data-mf-id="${node.id}"]`;
}

// Build a CSS rule per distinct identity-class signature (representative node).
function collectClassStyles(node, map, stateClasses) {
  const ident = identityClasses(node.classes, stateClasses);
  if (ident.length) {
    const key = ident.join('.');
    if (!map.has(key)) map.set(key, node.style);
  }
  for (const c of node.children) collectClassStyles(c, map, stateClasses);
}

// Class-less elements (h1, p, a, button, blockquote...) are styled by their
// unique node id. Keying by tag would collide when the same tag is styled
// differently by context (e.g. a hero <p> vs a card <p>) — the collision that
// the blueprint's Component Inducer resolves structurally; this version
// sidesteps it with atomic per-node rules.
function collectIdStyles(node, map, stateClasses) {
  if (node.placeholder ||
      (node.tag !== 'div' &&
       identityClasses(node.classes, stateClasses).length === 0)) {
    map.set(node.id, node);
  }
  for (const c of node.children) collectIdStyles(c, map, stateClasses);
}

function styleToCss(style, skip = []) {
  const lines = [];
  for (const p of LAYOUT_PROPS) {
    if (skip.includes(p)) continue;
    if (style[p] == null || style[p] === '') continue;
    if (p === 'animation' && (style[p] === 'none' || style[p].startsWith('none'))) continue;
    lines.push(`  ${camelToKebab(p)}: ${cssValue(p, style[p])};`);
  }
  return lines.join('\n');
}

function buildKeyframes(genome) {
  const blocks = [];
  for (const a of genome.motion.animations) {
    if (!a.keyframes || !a.keyframes.length) continue;
    const name = 'mf-' + (a.classes[0] || 'anim');
    const steps = a.keyframes.map(k => {
      const offset = k.offset != null ? `${Math.round(k.offset * 100)}%` : '0%';
      const decls = Object.entries(k)
        .filter(([kk]) => !['offset','computedOffset','easing','composite'].includes(kk))
        .map(([kk, vv]) => `${camelToKebab(kk)}: ${vv};`).join(' ');
      return `  ${offset} { ${decls} }`;
    }).join('\n');
    blocks.push(`@keyframes ${name} {\n${steps}\n}`);
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Behavior state CSS: for every recovered state machine, emit class-off and
// class-on rules per affected node, and remember which props must be stripped
// from that node's baked base rule (they are state-dependent).
// ---------------------------------------------------------------------------
function behaviorCss(genome, stateClasses) {
  const byId = new Map();
  const parent = new Map();
  (function index(node, par) {
    byId.set(node.id, node);
    if (par) parent.set(node.id, par);
    for (const c of node.children) index(c, node);
  })(genome.structure, null);

  const rules = new Map();          // selector -> Map(prop -> value)
  const strip = new Map();          // base selector -> Set(prop)
  const addRule = (sel, prop, val) => {
    if (!rules.has(sel)) rules.set(sel, new Map());
    rules.get(sel).set(prop, val);
  };
  const markStrip = (sel, prop) => {
    if (!strip.has(sel)) strip.set(sel, new Set());
    strip.get(sel).add(prop);
  };

  for (const b of genome.interaction.behaviors || []) {
    const targets = new Set();
    if (b.type === 'toggle') b.triggers.forEach(t => t.targets.forEach(id => targets.add(id)));
    if (b.type === 'exclusive') b.entries.forEach(e => e.targets.forEach(id => targets.add(id)));
    if (b.type === 'pair') b.targets.forEach(id => targets.add(id));

    for (const s of b.styleStates || []) {
      // width/height deltas are downstream consequences (e.g. bold text gets
      // wider), not authored state — baking them would freeze the layout.
      if (!LAYOUT_PROPS.includes(s.prop)) continue;
      const node = byId.get(s.id);
      if (!node) continue;
      // nearest self-or-ancestor that carries the toggled class
      let anc = node;
      while (anc && !targets.has(anc.id)) anc = parent.get(anc.id);
      if (!anc) continue; // delta not attributable to this state machine
      const nodeSel = selOf(node, stateClasses);
      const onSel = anc.id === node.id
        ? `${nodeSel}.${b.cls}`
        : `${selOf(anc, stateClasses)}.${b.cls} ${nodeSel}`;
      addRule(nodeSel, s.prop, s.off);
      addRule(onSel, s.prop, s.on);
      markStrip(nodeSel, s.prop);
    }
  }

  const css = [...rules.entries()]
    .map(([sel, props]) =>
      `${sel} {\n` +
      [...props.entries()].map(([p, v]) => `  ${camelToKebab(p)}: ${v};`).join('\n') +
      `\n}`)
    .join('\n\n');
  return { css, strip };
}

function fontFaceCss(genome) {
  return (genome.fontFaces || []).map(f => {
    const src = f.local
      ? `url("${ASSET_PREFIX}${f.local}")${f.format ? ` format("${f.format}")` : ''}`
      : `url("${f.url}")${f.format ? ` format("${f.format}")` : ''}`;
    return `@font-face {\n  font-family: "${f.family}";\n  font-weight: ${f.weight};\n` +
           `  font-style: ${f.style};\n${f.display ? `  font-display: ${f.display};\n` : ''}` +
           `${f.unicodeRange ? `  unicode-range: ${f.unicodeRange};\n` : ''}  src: ${src};\n}`;
  }).join('\n\n');
}

function generateCss(genome) {
  ASSET_MAP = (genome.assets && genome.assets.map) || {};
  const stateClasses = stateClassSet(genome);
  const root = Object.entries(genome.tokens.color)
    .map(([k, v]) => `  --${k}: ${v};`).join('\n');

  const classMap = new Map();
  collectClassStyles(genome.structure, classMap, stateClasses);
  const idMap = new Map();
  collectIdStyles(genome.structure, idMap, stateClasses);

  const { css: behaviorRules, strip } = behaviorCss(genome, stateClasses);

  const reveal = genome.motion.reveal;
  const stripFor = (sel) => strip.has(sel) ? [...strip.get(sel)] : [];

  const idRules = [...idMap.entries()]
    .map(([id, node]) => {
      const sel = `[data-mf-id="${id}"]`;
      // Placeholders stand in for skipped out-of-scope elements: bake their
      // full footprint (incl. explicit width/height) so surrounding layout
      // is preserved even though the content is not reconstructed.
      if (node.placeholder) {
        const decls = Object.entries(node.style)
          .filter(([, v]) => v != null && v !== '')
          .map(([p, v]) => `  ${camelToKebab(p)}: ${v};`).join('\n');
        return `${sel} {\n${decls}\n}`;
      }
      return `${sel} {\n${styleToCss(node.style, stripFor(sel))}\n}`;
    }).join('\n\n');

  // <img> elements size explicitly: their captured box IS authored layout
  // (the source file's intrinsic size need not match the rendered box).
  const mediaRules = [];
  (function findMedia(node) {
    if (node.tag === 'img' || node.svgMarkup || node.media) {
      const decls = [];
      if (node.style.width) decls.push(`  width: ${node.style.width};`);
      if (node.style.height) decls.push(`  height: ${node.style.height};`);
      if ((node.tag === 'img' || node.media) && node.style.objectFit)
        decls.push(`  object-fit: ${node.style.objectFit};`);
      if (decls.length) mediaRules.push(`[data-mf-id="${node.id}"] {\n${decls.join('\n')}\n}`);
    }
    for (const c of node.children) findMedia(c);
  })(genome.structure);
  const mediaCss = mediaRules.join('\n\n');

  // Empty leaf elements (no text, no children, not media) have no content to
  // size them: a nonzero captured box IS authored CSS (shape divs drawn with
  // borders/background). Bake width/height — auto would collapse them to 0.
  const shapeRules = [];
  (function findShapes(node) {
    if (!node.children.length && !node.text && !node.placeholder &&
        !node.svgMarkup && node.tag !== 'img' && node.tag !== 'br' &&
        node.rect && node.rect.w * node.rect.h > 0 &&
        node.style && node.style.width && node.style.height &&
        node.style.width.endsWith('px') && node.style.height.endsWith('px')) {
      shapeRules.push(`[data-mf-id="${node.id}"] {\n  width: ${node.style.width};\n  height: ${node.style.height};\n}`);
    }
    for (const c of node.children) findShapes(c);
  })(genome.structure);
  const shapeCss = shapeRules.join('\n\n');

  // A container whose in-flow content is entirely absolutely-positioned
  // children has no auto height; its computed height IS authored layout and
  // must be baked or the container collapses in the reconstruction.
  const absContainers = [];
  (function findAbs(node) {
    if (node.children.length &&
        node.children.every(c => c.style && c.style.position === 'absolute') &&
        node.style && node.style.height) {
      absContainers.push(`[data-mf-id="${node.id}"] {\n  height: ${node.style.height};\n}`);
    }
    for (const c of node.children) findAbs(c);
  })(genome.structure);
  const absContainerRules = absContainers.join('\n\n');

  // Same-signature nodes can carry different computed styles (context-driven
  // CSS: :has(), nth-child, descendant selectors). The class rule holds the
  // representative; divergent nodes get a per-node override with higher
  // specificity, so no node inherits a sibling's styling by accident.
  const overrides = [];
  (function collectOverrides(node) {
    const ident = identityClasses(node.classes, stateClasses);
    if (ident.length) {
      const key = ident.join('.');
      const rep = classMap.get(key);
      if (rep && rep !== node.style) {
        const skip = new Set(stripFor('.' + key));
        const isReveal = reveal.detected && reveal.hiddenStyle &&
                         key.split('.').includes(reveal.triggerClass);
        if (isReveal) ['opacity','transform','transition'].forEach(p => skip.add(p));
        const decls = [];
        for (const p of LAYOUT_PROPS) {
          if (skip.has(p)) continue;
          const a = rep[p] == null ? '' : rep[p];
          const b = node.style[p] == null ? '' : node.style[p];
          if (a !== b) decls.push(`  ${camelToKebab(p)}: ${b === '' ? 'initial' : b};`);
        }
        if (decls.length) {
          const sel = `[data-mf-id="${node.id}"]`.repeat(3);
          overrides.push(`${sel} {\n${decls.join('\n')}\n}`);
        }
      }
    }
    for (const c of node.children) collectOverrides(c);
  })(genome.structure);
  const overrideRules = overrides.join('\n\n');

  // For reveal elements, opacity/transform/transition are STATE-dependent (the
  // element may have been captured mid-reveal), so strip them from the baked
  // per-class rule and drive them from generic reveal rules below.
  const classRules = [...classMap.entries()]
    .map(([key, style]) => {
      const skip = stripFor('.' + key).slice();
      const isReveal = reveal.detected && reveal.hiddenStyle &&
                       key.split('.').includes(reveal.triggerClass);
      if (isReveal) skip.push('opacity', 'transform', 'transition');
      return `.${key} {\n${styleToCss(style, skip)}\n}`;
    }).join('\n\n');

  // Recovered scroll-reveal state machine (hidden -> visible on intersection).
  // Only emitted when the hidden state was actually observed at capture.
  // Each participant's own captured transition (duration, easing, per-item
  // delay) is replayed verbatim via a per-node rule; the generic rule is the
  // fallback for nodes whose computed transition had no duration.
  let revealRules = '';
  if (reveal.detected && reveal.hiddenStyle) {
    const hs = reveal.hiddenStyle;
    const perNode = Object.entries(reveal.transitionsByNode || {})
      .map(([id, t]) => `[data-mf-id="${id}"].${reveal.triggerClass} { transition: ${t}; }`)
      .join('\n');
    revealRules =
      `.${reveal.triggerClass} {\n  opacity: ${hs.opacity};\n  transform: ${hs.transform};\n` +
      `  transition: opacity 0.6s ease, transform 0.6s ease;\n}\n` +
      `.${reveal.triggerClass}.${reveal.visibleClass} {\n  opacity: 1;\n  transform: none;\n}\n` +
      `/* per-element recovered transition curves */\n${perNode}`;
  }

  // Hover rules recovered verbatim from the original stylesheet.
  const hoverRules = genome.interaction.hover
    .map(h => `${h.selector} { ${h.declarations} }`).join('\n');

  // JS-driven hover with style-only deltas compiles to a CSS :hover rule
  // (same-node) or descendant rule (delta on another node under the trigger).
  const hoverJsCss = (genome.interaction.hoverJs || []).flatMap(hp =>
    Object.entries(hp.deltas).flatMap(([id, d]) => {
      const decls = Object.entries(d)
        .filter(([p]) => LAYOUT_PROPS.includes(p))
        .map(([p, v]) => `  ${camelToKebab(p)}: ${cssValue(p, v.on)};`);
      if (!decls.length) return [];
      const sel = id === hp.trigger
        ? `[data-mf-id="${id}"]:hover`
        : `[data-mf-id="${hp.trigger}"]:hover [data-mf-id="${id}"]`;
      return [`${sel} {\n${decls.join('\n')}\n}`];
    })).join('\n');

  // Pseudo-element rules (v0.4): every captured ::before/::after is re-emitted
  // as a per-node rule. Explicit width/height are kept — pseudo boxes have no
  // content to derive size from.
  const pseudoRules = [];
  (function findPseudo(node) {
    for (const pe of ['before', 'after']) {
      const ps = node.pseudo && node.pseudo[pe];
      if (!ps) continue;
      const decls = [`  content: ${ps.content};`];
      for (const p of LAYOUT_PROPS) {
        if (ps[p] == null || ps[p] === '') continue;
        if (p === 'animation' && (ps[p] === 'none' || ps[p].startsWith('none'))) continue;
        decls.push(`  ${camelToKebab(p)}: ${cssValue(p, ps[p])};`);
      }
      for (const p of ['width', 'height']) {
        if (ps[p] && ps[p] !== 'auto') decls.push(`  ${p}: ${ps[p]};`);
      }
      pseudoRules.push(`[data-mf-id="${node.id}"]::${pe} {\n${decls.join('\n')}\n}`);
    }
    for (const c of node.children) findPseudo(c);
  })(genome.structure);
  const pseudoCss = pseudoRules.join('\n\n');

  // Focus rules (v0.4) recovered verbatim from the original stylesheet, plus
  // JS-driven focus deltas with style-only changes compiled to :focus rules.
  const focusRules = (genome.interaction.focus || [])
    .map(f => `${f.selector} { ${f.declarations} }`).join('\n');
  const focusJsCss = (genome.interaction.focusJs || []).flatMap(fp =>
    Object.entries(fp.deltas).flatMap(([id, d]) => {
      const decls = Object.entries(d)
        .filter(([p]) => LAYOUT_PROPS.includes(p))
        .map(([p, v]) => `  ${camelToKebab(p)}: ${cssValue(p, v.on)};`);
      if (!decls.length) return [];
      const sel = id === fp.trigger
        ? `[data-mf-id="${id}"]:focus`
        : `[data-mf-id="${fp.trigger}"]:focus [data-mf-id="${id}"]`;
      return [`${sel} {\n${decls.join('\n')}\n}`];
    })).join('\n');

  // Responsive rules (v0.4): per-breakpoint per-node overrides recovered by
  // re-capturing at each requested width. Widths below the base viewport emit
  // max-width queries (narrower last, so the narrowest wins), widths above
  // emit min-width queries (wider last). Triple-attribute selectors match the
  // specificity of the per-node divergence overrides they must beat.
  const baseWidth = (genome.meta.viewport && genome.meta.viewport.w) || 0;
  const bps = (genome.responsive || []).slice().sort((a, b) =>
    (a.width >= baseWidth ? a.width : 1e9 - a.width) - (b.width >= baseWidth ? b.width : 1e9 - b.width));
  const responsiveCss = bps.map(r => {
    const rules = Object.entries(r.overrides || {}).map(([id, d]) => {
      const decls = Object.entries(d)
        .filter(([p]) => LAYOUT_PROPS.includes(p))
        .map(([p, v]) => `    ${camelToKebab(p)}: ${cssValue(p, v)};`);
      if (!decls.length) return null;
      return `  ${`[data-mf-id="${id}"]`.repeat(3)} {\n${decls.join('\n')}\n  }`;
    }).filter(Boolean).join('\n');
    if (!rules) return '';
    const cond = r.width < baseWidth ? `(max-width: ${r.width}px)` : `(min-width: ${r.width}px)`;
    return `@media ${cond} {\n${rules}\n}`;
  }).filter(Boolean).join('\n\n');

  const keyframes = buildKeyframes(genome);
  const fontFaces = fontFaceCss(genome);

  return `/* bundled web fonts */\n${fontFaces}\n\n:root {\n${root}\n}\n\n* { margin: 0; padding: 0; box-sizing: border-box; }\n\n` +
         `${idRules}\n\n${classRules}\n\n/* media sizing */\n${mediaCss}\n\n/* empty-leaf shape sizing */\n${shapeCss}\n\n/* abs-positioned container heights */\n${absContainerRules}\n\n` +
         `/* per-node overrides (context-driven divergence) */\n${overrideRules}\n\n` +
         `/* recovered scroll-reveal */\n${revealRules}\n\n` +
         `/* recovered interaction states */\n${behaviorRules}\n\n` +
         `/* recovered hover states */\n${hoverRules}\n\n` +
         `/* recovered JS-driven hover (compiled to CSS) */\n${hoverJsCss}\n\n` +
         `/* recovered pseudo-elements */\n${pseudoCss}\n\n` +
         `/* recovered focus states */\n${focusRules}\n\n` +
         `/* recovered JS-driven focus (compiled to CSS) */\n${focusJsCss}\n\n` +
         `/* recovered responsive breakpoints */\n${responsiveCss}\n\n` +
         `/* recovered keyframes */\n${keyframes}\n`;
}

function esc(s) { return String(s).replace(/[\\`$]/g, m => '\\' + m); }

// Emit a React element tree as createElement calls (no JSX transform needed).
function emitNode(node, indent) {
  const pad = '  '.repeat(indent);

  // Inline SVG: re-emitted verbatim (it is already vector source). The
  // wrapper contributes no box of its own.
  if (node.svgMarkup) {
    return `${pad}h("span", { style: { display: "contents" }, ` +
           `dangerouslySetInnerHTML: { __html: ${JSON.stringify(node.svgMarkup)} } })`;
  }

  const props = [];
  if (node.classes && node.classes.length) props.push(`className: "${node.classes.join(' ')}"`);
  if (node.href) props.push(`href: "${esc(node.href)}"`);
  if (node.tag === 'img') {
    const local = ASSET_MAP[node.src];
    props.push(`src: ${JSON.stringify(local ? ASSET_PREFIX + local : (node.src || ''))}`);
    if (node.alt) props.push(`alt: ${JSON.stringify(node.alt)}`);
  }

  // Bundled <video>: re-emitted as a real video with its captured playback
  // attributes; forced muted so autoplay works everywhere. If the source
  // could not be bundled or fetched, degrade to a still (poster, else the
  // snapshotted frame) — the frame-level ground truth, never an empty box.
  if (node.media === 'video') {
    const localSrc = node.src && ASSET_MAP[node.src];
    const localPoster = node.poster && ASSET_MAP[node.poster];
    const poster = localPoster ? ASSET_PREFIX + localPoster : (node.poster || node.frame || '');
    // A blob: source only existed inside the original page's session — it
    // cannot be re-emitted; degrade to the still.
    const usableSrc = localSrc || (node.src && !node.src.startsWith('blob:') ? node.src : null);
    if (usableSrc) {
      props.push(`src: ${JSON.stringify(localSrc ? ASSET_PREFIX + localSrc : node.src)}`);
      if (poster) props.push(`poster: ${JSON.stringify(poster)}`);
      const a = node.mediaAttrs || {};
      if (a.autoplay) props.push('autoPlay: true');
      props.push('muted: true');
      if (a.loop) props.push('loop: true');
      if (a.playsInline) props.push('playsInline: true');
      if (a.controls) props.push('controls: true');
      props.push(`"data-mf-id": "${node.id}"`);
      return `${pad}h("video", { ${props.join(', ')} })`;
    }
    if (poster) {
      props.push(`src: ${JSON.stringify(poster)}`);
      props.push(`"data-mf-id": "${node.id}"`);
      return `${pad}h("img", { ${props.join(', ')} })`;
    }
  }

  // Snapshotted <canvas>: re-emitted as a still of the captured frame.
  if (node.media === 'canvas' && node.frame) {
    props.push(`src: ${JSON.stringify(node.frame)}`);
    props.push(`"data-mf-id": "${node.id}"`);
    return `${pad}h("img", { ${props.join(', ')} })`;
  }
  props.push(`"data-mf-id": "${node.id}"`);
  const propStr = `{ ${props.join(', ')} }`;

  const kids = [];
  if (node.text) kids.push('`' + esc(node.text) + '`');
  for (const c of node.children) {
    // Re-emit inter-element whitespace: a word space between inline siblings
    // is layout-significant (JSX/createElement children have none by default).
    // wsBefore may carry a literal string when it holds non-collapsing
    // whitespace (nbsp runs keep their full width).
    if (c.wsBefore) kids.push(typeof c.wsBefore === 'string' ? JSON.stringify(c.wsBefore) : '" "');
    kids.push(emitNode(c, indent + 1));
  }

  const tag = `"${node.tag}"`;
  if (kids.length === 0) return `${pad}h(${tag}, ${propStr})`;
  return `${pad}h(${tag}, ${propStr},\n${kids.map(k => (k.startsWith('`') ? '  '.repeat(indent+1) + k : k)).join(',\n')}\n${pad})`;
}

function generateApp(genome) {
  ASSET_MAP = (genome.assets && genome.assets.map) || {};
  const tree = emitNode(genome.structure, 3);
  const reveal = genome.motion.reveal;
  // Sequential reveal replay: elements entering in one intersection burst are
  // released in viewport order with the recovered per-element offsets
  // (observed firing timestamps), falling back to the recovered median
  // stagger step for elements the capture sweep never saw fire.
  const revealEffect = (reveal.detected && reveal.hiddenStyle) ? `
  React.useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      const es = entries.filter(e => e.isIntersecting);
      es.sort((a, b) => {
        const ra = a.target.getBoundingClientRect(), rb = b.target.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
      });
      es.forEach((e, i) => {
        io.unobserve(e.target);
        const id = e.target.getAttribute('data-mf-id');
        const d = REVEAL_STAGGER.ids[id] != null ? REVEAL_STAGGER.ids[id] : i * REVEAL_STAGGER.step;
        if (d > 0) setTimeout(() => e.target.classList.add('${reveal.visibleClass}'), Math.min(d, 2000));
        else e.target.classList.add('${reveal.visibleClass}');
      });
    }, { threshold: ${reveal.threshold} });
    document.querySelectorAll('.${reveal.triggerClass}').forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);` : '';

  // Recovered click-driven state machines, replayed by a small generic engine.
  const behaviors = (genome.interaction.behaviors || []).map(b => {
    if (b.type === 'toggle') return { type: b.type, cls: b.cls, triggers: b.triggers };
    if (b.type === 'exclusive') return { type: b.type, cls: b.cls, entries: b.entries };
    if (b.type === 'pair') return { type: b.type, cls: b.cls, open: b.open, close: b.close, targets: b.targets };
    return null;
  }).filter(Boolean);

  const behaviorEffect = behaviors.length ? `
  React.useEffect(() => {
    const $ = (id) => document.querySelector('[data-mf-id="' + id + '"]');
    const offs = [];
    const on = (el, fn) => { if (el) { el.addEventListener('click', fn); offs.push([el, fn]); } };
    for (const b of BEHAVIORS) {
      if (b.type === 'toggle') for (const t of b.triggers)
        on($(t.trigger), () => t.targets.forEach(id => $(id) && $(id).classList.toggle(b.cls)));
      if (b.type === 'exclusive') {
        const all = b.entries.flatMap(e => e.targets);
        for (const e of b.entries)
          on($(e.trigger), () => {
            all.forEach(id => $(id) && $(id).classList.remove(b.cls));
            e.targets.forEach(id => $(id) && $(id).classList.add(b.cls));
          });
      }
      if (b.type === 'pair') {
        on($(b.open), () => b.targets.forEach(id => $(id) && $(id).classList.add(b.cls)));
        on($(b.close), () => b.targets.forEach(id => $(id) && $(id).classList.remove(b.cls)));
      }
    }
    return () => offs.forEach(([el, fn]) => el.removeEventListener('click', fn));
  }, []);` : '';

  // Recovered scroll choreography: per-node visual-prop samples across the
  // original's scroll range, replayed by interpolating between the two
  // bracketing frames (numeric lerp for opacity + matrix transforms; step for
  // everything else). Track samples are keyed on absolute document-coordinate
  // scroll positions — layout convergence drives the reconstruction to the
  // original's coordinates, so absolute mapping is exact. Rescaling by the
  // height RATIO would corrupt the mapping whenever scrollHeight diverges for
  // reasons that do not move content (e.g. negative-margin overlap overflow);
  // fall back to proportional mapping only when the recon range is SHORTER
  // than the sampled range (content would otherwise be unreachable).
  const tracks = genome.motion.scrollTracks || [];
  const scrollEffect = tracks.length ? `
  React.useEffect(() => {
    const lerp = (a, b, t) => a + (b - a) * t;
    const nums = (s) => (s.match(/-?[\\d.eE+]+/g) || []).map(Number);
    const lerpValue = (va, vb, t) => {
      if (va === vb) return va;
      const isM = (s) => /^matrix(3d)?\\(/.test(s);
      const na = va === 'none' && isM(vb) ? (vb.startsWith('matrix3d') ?
        'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)' : 'matrix(1,0,0,1,0,0)') : va;
      const nb = vb === 'none' && isM(va) ? (va.startsWith('matrix3d') ?
        'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)' : 'matrix(1,0,0,1,0,0)') : vb;
      if (isM(na) && isM(nb) && na.slice(0, 8) === nb.slice(0, 8)) {
        const A = nums(na), B = nums(nb);
        if (A.length === B.length)
          return na.slice(0, na.indexOf('(') + 1) + A.map((x, i) => lerp(x, B[i], t)).join(',') + ')';
      }
      const fa = parseFloat(na), fb = parseFloat(nb);
      if (!isNaN(fa) && !isNaN(fb) && String(fa) === na && String(fb) === nb)
        return String(lerp(fa, fb, t));
      return t < 0.5 ? na : nb;
    };
    const els = {};
    for (const tr of TRACKS) els[tr.id] = document.querySelector('[data-mf-id="' + tr.id + '"]');
    const apply = () => {
      const reconMax = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const y = reconMax >= MAX_SCROLL ? Math.min(window.scrollY, MAX_SCROLL)
                                       : (window.scrollY / reconMax) * MAX_SCROLL;
      for (const tr of TRACKS) {
        const el = els[tr.id];
        if (!el) continue;
        const s = tr.samples;
        let i = 0;
        while (i < s.length - 2 && s[i + 1][0] <= y) i++;
        const [y0, v0] = s[i], [y1, v1] = s[i + 1];
        const t = y1 === y0 ? 0 : Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
        el.style[tr.prop] = lerpValue(v0, v1, t);
      }
    };
    let raf = null;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; apply(); }); };
    window.addEventListener('scroll', onScroll, { passive: true });
    apply();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);` : '';

  // JS-driven hover that toggles classes: replayed with real listeners
  // (style-only hover deltas were compiled to CSS :hover rules instead).
  const hoverClassProbes = (genome.interaction.hoverJs || []).map(hp => ({
    trigger: hp.trigger,
    classes: Object.entries(hp.deltas)
      .filter(([, d]) => d.__class)
      .map(([id, d]) => ({ id, off: d.__class.off, on: d.__class.on })),
  })).filter(hp => hp.classes.length);
  const hoverEffect = hoverClassProbes.length ? `
  React.useEffect(() => {
    const $ = (id) => document.querySelector('[data-mf-id="' + id + '"]');
    const offs = [];
    for (const hp of HOVER_CLASS) {
      const el = $(hp.trigger);
      if (!el) continue;
      const enter = () => hp.classes.forEach(c => { const t = $(c.id); if (t) t.className = c.on; });
      const leave = () => hp.classes.forEach(c => { const t = $(c.id); if (t) t.className = c.off; });
      el.addEventListener('mouseenter', enter);
      el.addEventListener('mouseleave', leave);
      offs.push([el, enter, leave]);
    }
    return () => offs.forEach(([el, en, le]) => {
      el.removeEventListener('mouseenter', en); el.removeEventListener('mouseleave', le);
    });
  }, []);` : '';

  // JS-driven focus that toggles classes: replayed with real focus/blur
  // listeners (style-only focus deltas were compiled to :focus rules instead).
  const focusClassProbes = (genome.interaction.focusJs || []).map(fp => ({
    trigger: fp.trigger,
    classes: Object.entries(fp.deltas)
      .filter(([, d]) => d.__class)
      .map(([id, d]) => ({ id, off: d.__class.off, on: d.__class.on })),
  })).filter(fp => fp.classes.length);
  const focusEffect = focusClassProbes.length ? `
  React.useEffect(() => {
    const $ = (id) => document.querySelector('[data-mf-id="' + id + '"]');
    const offs = [];
    for (const fp of FOCUS_CLASS) {
      const el = $(fp.trigger);
      if (!el) continue;
      const on = () => fp.classes.forEach(c => { const t = $(c.id); if (t) t.className = c.on; });
      const off = () => fp.classes.forEach(c => { const t = $(c.id); if (t) t.className = c.off; });
      el.addEventListener('focus', on);
      el.addEventListener('blur', off);
      offs.push([el, on, off]);
    }
    return () => offs.forEach(([el, on, off]) => {
      el.removeEventListener('focus', on); el.removeEventListener('blur', off);
    });
  }, []);` : '';

  // Chronograph frame tracks: time-driven motion recorded frame-by-frame at
  // capture, replayed verbatim as an infinitely-looping WAAPI animation with
  // the sampled timestamps as keyframe offsets.
  const frameTracks = genome.motion.frameTracks || [];
  const frameEffect = frameTracks.length ? `
  React.useEffect(() => {
    const anims = [];
    for (const tr of FRAME_TRACKS) {
      const el = document.querySelector('[data-mf-id="' + tr.id + '"]');
      if (!el || tr.frames.length < 2) continue;
      const dur = tr.frames[tr.frames.length - 1][0] || 1;
      const kfs = tr.frames.map(([t, v]) => ({
        offset: Math.min(1, Math.max(0, t / dur)), [tr.prop]: v,
      }));
      try {
        anims.push(el.animate(kfs, { duration: dur, iterations: Infinity, easing: 'linear' }));
      } catch (e) { /* unanimatable sampled value; leave the static style */ }
    }
    return () => anims.forEach(a => a.cancel());
  }, []);` : '';

  // Pointer choreography: recovered matrix-component planes over the pointer
  // (v = a*mx + b*my + c per component), chased with each node's recovered
  // exponential smoothing time constant — the original's trailing "smooth
  // feel" — in a rAF loop that starts on the first real mousemove.
  const fields = genome.interaction.pointerFields || [];
  const pointerEffect = fields.length ? `
  React.useEffect(() => {
    const nodes = POINTER_FIELDS.map(f => ({
      f, el: document.querySelector('[data-mf-id="' + f.id + '"]'),
      cur: null, target: f.comps.map(c => c.c),
    })).filter(n => n.el);
    let mx = null, my = null, raf = null, last = 0;
    const fmt = (n) => n.f.kind === 'matrix3d'
      ? 'matrix3d(' + n.cur.join(',') + ')'
      : 'matrix(' + [n.cur[0], n.cur[1], n.cur[4], n.cur[5], n.cur[12], n.cur[13]].join(',') + ')';
    const tick = (t) => {
      raf = null;
      const dt = last ? Math.min(100, t - last) : 16;
      last = t;
      let busy = false;
      for (const n of nodes) {
        n.target = n.f.comps.map(c => c.a * mx + c.b * my + c.c);
        if (!n.cur) n.cur = n.target.slice();
        const k = n.f.tauMs > 0 ? 1 - Math.exp(-dt / n.f.tauMs) : 1;
        let moving = false;
        n.cur = n.cur.map((v, i) => {
          const nv = v + (n.target[i] - v) * k;
          if (Math.abs(n.target[i] - nv) > 1e-4) moving = true;
          return nv;
        });
        if (moving) busy = true; else n.cur = n.target.slice();
        n.el.style.transform = fmt(n);
      }
      if (busy) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const onMove = (e) => {
      mx = e.clientX; my = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => { window.removeEventListener('mousemove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);` : '';

  return `import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;

const BEHAVIORS = ${JSON.stringify(behaviors, null, 2)};
const TRACKS = ${JSON.stringify(tracks)};
const MAX_SCROLL = ${JSON.stringify(genome.motion.maxScroll || 0)};
const HOVER_CLASS = ${JSON.stringify(hoverClassProbes)};
const FOCUS_CLASS = ${JSON.stringify(focusClassProbes)};
const POINTER_FIELDS = ${JSON.stringify(fields)};
const REVEAL_STAGGER = ${JSON.stringify(reveal.detected
    ? { ids: reveal.staggerMs || {}, step: reveal.staggerStep || 0 }
    : { ids: {}, step: 0 })};
const FRAME_TRACKS = ${JSON.stringify(frameTracks)};

function App() {${revealEffect}${behaviorEffect}${scrollEffect}${hoverEffect}${focusEffect}${pointerEffect}${frameEffect}
  return (
${tree}
  );
}

createRoot(document.getElementById('root')).render(h(App));
`;
}

// Media stills (video first frame, canvas snapshot) arrive as data: URLs in
// the genome. Inlining them into app.jsx would bloat the bundle with base64;
// materialize them as real files in the shared assets dir and point the
// structure at the local paths before emission.
function materializeStills(genome, outDir) {
  const assetsDir = path.join(outDir, 'assets');
  let made = fs.existsSync(assetsDir);
  const put = (dataUrl, id, kind) => {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
    if (!m) return dataUrl;
    if (!made) { fs.mkdirSync(assetsDir, { recursive: true }); made = true; }
    const name = `still-${id}-${kind}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(assetsDir, name), Buffer.from(m[2], 'base64'));
    return ASSET_PREFIX + 'assets/' + name;
  };
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.media) {
        if (node.frame && node.frame.startsWith('data:'))
          node.frame = put(node.frame, node.id, 'frame');
        if (node.poster && node.poster.startsWith('data:'))
          node.poster = put(node.poster, node.id, 'poster');
      }
      walk(node.children);
    }
  })(Array.isArray(genome.structure) ? genome.structure : [genome.structure]);
}

async function reconstruct(genome, outDir) {
  const appDir = path.join(outDir, 'recon-app');
  fs.mkdirSync(appDir, { recursive: true });
  materializeStills(genome, outDir);

  fs.writeFileSync(path.join(appDir, 'styles.css'), generateCss(genome));
  fs.writeFileSync(path.join(appDir, 'app.jsx'), generateApp(genome));

  const esbuild = require('esbuild');
  await esbuild.build({
    entryPoints: [path.join(appDir, 'app.jsx')],
    bundle: true,
    outfile: path.join(appDir, 'bundle.js'),
    loader: { '.jsx': 'jsx' },
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mirrorframe reconstruction</title>
<link rel="stylesheet" href="styles.css">
</head><body><div id="root"></div><script src="bundle.js"></script></body></html>`;
  fs.writeFileSync(path.join(appDir, 'index.html'), html);

  return { appDir, indexHtml: path.join(appDir, 'index.html') };
}

module.exports = { reconstruct, LAYOUT_PROPS };
