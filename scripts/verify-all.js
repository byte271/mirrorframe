#!/usr/bin/env node
// Runs the full Mirrorframe pipeline on every fixture and prints a per-node +
// per-state + aggregate results table. This is the release verification bar:
// a clean clone must reproduce these numbers via `npm install && npm run verify`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fixturesDir = path.join(root, 'fixtures');
const outRoot = path.join(root, 'mf-out');

const fixtures = fs.readdirSync(fixturesDir).filter(f =>
  fs.existsSync(path.join(fixturesDir, f, 'index.html')));

const rows = [];
let anyFailed = false;

for (const f of fixtures) {
  console.log(`\n=== ${f} ===`);
  execFileSync(process.execPath,
    [path.join(root, 'scripts', 'mirrorframe.js'), 'run',
     '--dir', path.join(fixturesDir, f), '--out', path.join(outRoot, f)],
    { stdio: 'inherit' });
  const r = JSON.parse(fs.readFileSync(path.join(outRoot, f, 'convergence.json')));
  const s = JSON.parse(fs.readFileSync(path.join(outRoot, f, 'summary.json')));
  const n = r.summary.nodes;
  const scroll = r.summary.scrollStates || { pass: 0, fail: 0 };
  const pointer = r.summary.pointerStates || { pass: 0, fail: 0 };
  if (n.failed > 0 || r.summary.states.fail > 0 || scroll.fail > 0 || pointer.fail > 0)
    anyFailed = true;
  rows.push({
    fixture: f,
    nodes: `${n.pass}P/${n.styleVerified}SV/${n.corrected}C/${n.failed}F/${n.animatedUnstable}A/${n.hiddenAtCapture}H`,
    states: `${r.summary.states.pass}P/${r.summary.states.fail}F`,
    scroll: `${scroll.pass}P/${scroll.fail}F`,
    pointer: `${pointer.pass}P/${pointer.fail}F`,
    fold: (s.similarity.fold * 100).toFixed(2) + '%',
    full: (s.similarity.full * 100).toFixed(2) + '%',
  });
}

console.log('\nLegend: P=pass SV=style-verified C=corrected F=failed A=animated-unstable H=hidden-at-capture');
console.table(rows);
if (anyFailed) { console.error('VERIFICATION FAILED'); process.exit(1); }
console.log('All fixtures verified.');
