// Mirrorframe — Reconstruction Compiler (single target: React + plain CSS).
// Compiles the Design Genome into a runnable React app. This is templated,
// deterministic codegen (no LLM required), which keeps output inspectable and
// reproducible. Multi-framework emission is on the ROADMAP.

const fs = require('fs');
const path = require('path');

// Note: fixed 'width'/'height' are deliberately NOT baked — block elements
// default to auto (fill) width; baking computed px causes overflow and defeats
// responsiveness. We keep maxWidth/minHeight, which carry real layout intent.
const LAYOUT_PROPS = [
  'display','position','top','right','bottom','left','flexDirection','flexWrap','justifyContent','alignItems','gap','listStyleType',
  'maxWidth','minHeight','padding','margin','marginBottom','marginLeft',
  'color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
  'borderRadius','boxShadow','opacity','transform','transition','textDecorationLine',
  'fontStyle','textAlign','flex','cursor','border','zIndex','animation',
  'borderTop','borderRight','borderBottom','borderLeft'
];

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
      (node.tag !== 'div' && node.tag !== 'span' &&
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
    lines.push(`  ${camelToKebab(p)}: ${style[p]};`);
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

function generateCss(genome) {
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
  let revealRules = '';
  if (reveal.detected && reveal.hiddenStyle) {
    const hs = reveal.hiddenStyle;
    revealRules =
      `.${reveal.triggerClass} {\n  opacity: ${hs.opacity};\n  transform: ${hs.transform};\n` +
      `  transition: opacity 0.6s ease, transform 0.6s ease;\n}\n` +
      `.${reveal.triggerClass}.${reveal.visibleClass} {\n  opacity: 1;\n  transform: none;\n}`;
  }

  // Hover rules recovered verbatim from the original stylesheet.
  const hoverRules = genome.interaction.hover
    .map(h => `${h.selector} { ${h.declarations} }`).join('\n');

  const keyframes = buildKeyframes(genome);

  return `:root {\n${root}\n}\n\n* { margin: 0; padding: 0; box-sizing: border-box; }\n\n` +
         `${idRules}\n\n${classRules}\n\n/* abs-positioned container heights */\n${absContainerRules}\n\n` +
         `/* per-node overrides (context-driven divergence) */\n${overrideRules}\n\n` +
         `/* recovered scroll-reveal */\n${revealRules}\n\n` +
         `/* recovered interaction states */\n${behaviorRules}\n\n` +
         `/* recovered hover states */\n${hoverRules}\n\n` +
         `/* recovered keyframes */\n${keyframes}\n`;
}

function esc(s) { return String(s).replace(/[\\`$]/g, m => '\\' + m); }

// Emit a React element tree as createElement calls (no JSX transform needed).
function emitNode(node, indent) {
  const pad = '  '.repeat(indent);
  const props = [];
  if (node.classes && node.classes.length) props.push(`className: "${node.classes.join(' ')}"`);
  if (node.href) props.push(`href: "${esc(node.href)}"`);
  props.push(`"data-mf-id": "${node.id}"`);
  const propStr = `{ ${props.join(', ')} }`;

  const kids = [];
  if (node.text) kids.push('`' + esc(node.text) + '`');
  for (const c of node.children) {
    // Re-emit inter-element whitespace: a word space between inline siblings
    // is layout-significant (JSX/createElement children have none by default).
    if (c.wsBefore) kids.push('" "');
    kids.push(emitNode(c, indent + 1));
  }

  const tag = `"${node.tag}"`;
  if (kids.length === 0) return `${pad}h(${tag}, ${propStr})`;
  return `${pad}h(${tag}, ${propStr},\n${kids.map(k => (k.startsWith('`') ? '  '.repeat(indent+1) + k : k)).join(',\n')}\n${pad})`;
}

function generateApp(genome) {
  const tree = emitNode(genome.structure, 3);
  const reveal = genome.motion.reveal;
  const revealEffect = (reveal.detected && reveal.hiddenStyle) ? `
  React.useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('${reveal.visibleClass}');
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

  return `import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;

const BEHAVIORS = ${JSON.stringify(behaviors, null, 2)};

function App() {${revealEffect}${behaviorEffect}
  return (
${tree}
  );
}

createRoot(document.getElementById('root')).render(h(App));
`;
}

async function reconstruct(genome, outDir) {
  const appDir = path.join(outDir, 'recon-app');
  fs.mkdirSync(appDir, { recursive: true });

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
