#!/usr/bin/env node
// Mirrorframe v1 CLI — capture → genome → reconstruct → converge.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { capture } = require('./lib/capture');
const { buildGenome } = require('./lib/genome');
const { reconstruct } = require('./lib/reconstruct');
const { converge } = require('./lib/converge');
const { MfSkip, REASONS } = require('./lib/reasons');

// Pipeline hard watchdog: no run may hang. If the whole pipeline exceeds this
// bound the process writes a crash summary and exits (code 4) — bounded, not
// wedged. Override with --watchdog <ms>.
const WATCHDOG_MS = 300000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i++; }
    else args._.push(a);
  }
  return args;
}

// Serve a local directory so file:// asset quirks don't bite; returns {url, close}.
function serve(dir) {
  const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript',
                  '.png':'image/png', '.json':'application/json' };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(dir, p);
      if (!fp.startsWith(dir) || !fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function writeOutcome(out, outcome) {
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify(outcome, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'run';
  const out = path.resolve(args.out || './mf-out');
  fs.mkdirSync(out, { recursive: true });

  const watchdogMs = args.watchdog ? parseInt(args.watchdog) : WATCHDOG_MS;
  const watchdog = setTimeout(() => {
    writeOutcome(out, { url: args.url || args.dir, pageStatus: 'crash',
                        reason: REASONS.TIME_BUDGET_EXCEEDED,
                        detail: `pipeline exceeded ${watchdogMs}ms watchdog` });
    process.exit(4);
  }, watchdogMs);
  watchdog.unref();

  let url = args.url;
  let localServer = null;
  if (args.dir) {
    localServer = await serve(path.resolve(args.dir));
    url = localServer.url + '/index.html';
  }
  if (!url) { console.error('Provide --url <url> or --dir <local-dir>'); process.exit(1); }

  const width = args.width ? parseInt(args.width) : 1280;
  const height = args.height ? parseInt(args.height) : 800;

  console.log(`[1/4] Capturing ${url} ...`);
  const captureOpts = { width, height };
  if (args['nav-timeout']) captureOpts.navTimeoutMs = parseInt(args['nav-timeout']);
  if (args['probe-budget']) captureOpts.probeBudgetMs = parseInt(args['probe-budget']);
  if (args['max-nodes']) captureOpts.maxNodes = parseInt(args['max-nodes']);
  const bundle = await capture(url, out, captureOpts);
  if (bundle.scope.navFallback)
    console.log('      note: networkidle never settled; captured after domcontentloaded fallback.');
  console.log(`      ${bundle.flat.length} nodes, ${bundle.animations.length} raw animation objects ` +
              `(incl. transitions), ${bundle.hoverRules.length} hover rules.`);

  console.log('[2/4] Compiling Design Genome ...');
  const genome = buildGenome(bundle);
  fs.writeFileSync(path.join(out, 'genome.json'), JSON.stringify(genome, null, 2));
  console.log(`      ${Object.keys(genome.tokens.color).length} color tokens, ` +
              `${Object.keys(genome.tokens.text).length} type tokens, ` +
              `${genome.tokens.space.length} spacing steps, ` +
              `${genome.motion.animations.length} keyframe animation(s), ` +
              `${genome.motion.transitions.length} transitions, reveal=${genome.motion.reveal.detected}.`);

  console.log('[3/4] Reconstructing (React + CSS) ...');
  const recon = await reconstruct(genome, out);
  console.log(`      -> ${path.relative(process.cwd(), recon.indexHtml)}`);

  console.log('[4/4] Convergence (per-node + aggregate diff, auto-correction, state replay) ...');
  const report = await converge(genome, recon, out);
  const pct = (x) => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  const ns = report.summary.nodes;
  console.log(`      per-node: ${ns.pass} pass, ${ns.styleVerified} style-verified, ` +
              `${ns.corrected} corrected, ${ns.failed} failed, ` +
              `${ns.animatedUnstable} animated-unstable, ${ns.hiddenAtCapture} hidden-at-capture` +
              (ns.timeVaryingReplicated ? `, ${ns.timeVaryingReplicated} time-varying-replicated` : ''));
  for (const n of report.nodes) {
    if (['failed', 'corrected', 'style-verified', 'animated-unstable'].includes(n.status)) {
      console.log(`        - ${n.id} <${n.tag}${n.classes ? ' .' + n.classes : ''}> ` +
                  `${n.status} (sim ${pct(n.similarity)}` +
                  (n.similarityAfter != null ? ` -> ${pct(n.similarityAfter)}` : '') + ')');
    }
  }
  if (ns.skipped) {
    const byReason = {};
    for (const n of report.nodes) if (n.status === 'skipped')
      byReason[n.reason] = (byReason[n.reason] || 0) + 1;
    console.log(`                ${ns.skipped} skipped: ` +
      Object.entries(byReason).map(([r, c]) => `${r}\u00d7${c}`).join(', '));
  }
  console.log(`      states:   ${report.summary.states.pass} pass, ${report.summary.states.fail} fail`);
  for (const s of report.states) {
    console.log(`        - [${s.behavior}/${s.cls}] trigger ${s.trigger}: ${s.status} (sim ${pct(s.similarity)})`);
  }
  if (report.scrollStates.length) {
    console.log(`      scroll:   ${report.summary.scrollStates.pass} pass, ${report.summary.scrollStates.fail} fail`);
    for (const s of report.scrollStates)
      console.log(`        - scroll ${Math.round((s.fraction || 0) * 100)}%: ${s.status} (sim ${pct(s.similarity)})`);
  }
  if (report.pointerStates && report.pointerStates.length) {
    console.log(`      pointer:  ${report.summary.pointerStates.pass} pass, ${report.summary.pointerStates.fail} fail`);
    for (const s of report.pointerStates)
      console.log(`        - pointer (${s.mx},${s.my}): ${s.status} (sim ${pct(s.similarity)})`);
  }
  const as = report.summary.assets;
  if (as.bundled || as.misses || as.fontFaces)
    console.log(`      assets:   ${as.bundled} bundled, ${as.fontFaces} font faces, ${as.misses} misses`);
  const fold = report.foldAfterCorrection || report.fold;
  const full = report.fullAfterCorrection || report.full;
  console.log(`      aggregate: fold ${pct(fold.similarity)} | full ${pct(full.similarity)}` +
              (report.foldAfterCorrection ? ' (after correction)' : '') +
              (full.maskedPixels ? ` | ${full.maskedPixels}px masked (out-of-scope regions)` : ''));

  // Scope report: everything detected but not handled, by fixed reason.
  const scope = genome.scope;
  const skipHist = {};
  for (const s of scope.skips) skipHist[s.reason] = (skipHist[s.reason] || 0) + 1;
  for (const s of scope.skippedProbes) skipHist[s.reason] = (skipHist[s.reason] || 0) + 1;
  for (const u of genome.interaction.unclassified) skipHist[u.reason] = (skipHist[u.reason] || 0) + 1;
  if (scope.crossOriginSheets) skipHist[REASONS.CROSS_ORIGIN_CONTENT] =
    (skipHist[REASONS.CROSS_ORIGIN_CONTENT] || 0) + scope.crossOriginSheets;
  if (Object.keys(skipHist).length) {
    console.log('      scope:    skipped with reason: ' +
      Object.entries(skipHist).map(([r, c]) => `${r}×${c}`).join(', '));
  }

  if (localServer) localServer.close();

  const summary = {
    url, viewport: { width, height },
    pageStatus: (report.summary.nodes.failed === 0 && report.summary.states.fail === 0 &&
                 report.summary.scrollStates.fail === 0 &&
                 report.summary.pointerStates.fail === 0)
      ? 'success' : 'partial',
    durationMs: bundle.timings.captureMs,
    nodes: bundle.flat.length,
    tokens: { color: Object.keys(genome.tokens.color).length,
              text: Object.keys(genome.tokens.text).length },
    animations: genome.motion.animations.length,
    transitions: genome.motion.transitions.length,
    hover: genome.interaction.hover.length,
    reveal: genome.motion.reveal.detected,
    behaviors: (genome.interaction.behaviors || []).map(b => ({ type: b.type, cls: b.cls })),
    perNode: report.summary.nodes,
    states: report.summary.states,
    scrollStates: report.summary.scrollStates,
    pointerStates: report.summary.pointerStates,
    scrollTracks: (genome.motion.scrollTracks || []).length,
    frameTracks: (genome.motion.frameTracks || []).length,
    hoverJs: (genome.interaction.hoverJs || []).length,
    pointerFields: (genome.interaction.pointerFields || []).length,
    revealStagger: genome.motion.reveal.detected
      ? Object.keys(genome.motion.reveal.staggerMs || {}).length : 0,
    assets: report.summary.assets,
    similarity: { fold: fold.similarity, full: full.similarity },
    scope: { skips: skipHist, maskedRegions: report.maskedRegions,
             navFallback: scope.navFallback },
  };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\nDone. Artifacts in ' + out);
  console.log(JSON.stringify(summary, null, 2));
}

// Exit contract: 0 = pipeline completed (success or partial — read
// summary.json), 3 = page skipped with a fixed reason (out of scope, not an
// error), 4 = crash (bug or watchdog). Never a hang, never a bare stack trace
// without a summary.
main().catch(e => {
  const out = path.resolve(parseArgs(process.argv.slice(2)).out || './mf-out');
  fs.mkdirSync(out, { recursive: true });
  if (e instanceof MfSkip) {
    writeOutcome(out, { pageStatus: 'skipped', reason: e.mfReason, detail: e.message });
    process.exit(3);
  }
  writeOutcome(out, { pageStatus: 'crash', reason: null, detail: e.message });
  console.error(e);
  process.exit(4);
});
