#!/usr/bin/env node
// Track B validation runner: exercises the pipeline against real, public,
// third-party pages. Validation only — nothing from these pages is bundled
// in the repo; the output is a per-page outcome table plus aggregate stats.
//
//   node scripts/batch-verify.js [--urls urls.txt] [--out mf-out/batch]
//
// Per-page outcome is one of:
//   success        — pipeline completed, per-node report produced, 0 failed nodes
//   partial        — pipeline completed but some nodes failed verification
//   skipped:<r>    — page skipped with a fixed-taxonomy reason
//   crash          — pipeline exited abnormally (this is a bug, not a skip)
// An aggregate "batch is fine" never hides a page: every row is printed.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_URLS = [
  'https://example.com/',
  'https://info.cern.ch/hypertext/WWW/TheProject.html',
  'https://danluu.com/',
  'https://sive.rs/',
  'https://www.paulgraham.com/articles.html',
  'https://motherfuckingwebsite.com/',
  'https://bettermotherfuckingwebsite.com/',
  'https://news.ycombinator.com/',
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://developer.mozilla.org/en-US/',
  'https://react.dev/',
  'https://vuejs.org/',
  'https://svelte.dev/',
  'https://nextjs.org/',
  'https://astro.build/',
  'https://web.dev/',
  'https://caniuse.com/',
  'https://httpbin.org/',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function slug(u) {
  return u.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_').replace(/_+$/, '').slice(0, 60);
}

const args = parseArgs(process.argv.slice(2));
const urls = args.urls
  ? fs.readFileSync(args.urls, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  : DEFAULT_URLS;
const outRoot = path.resolve(args.out || 'mf-out/batch');
fs.mkdirSync(outRoot, { recursive: true });

const rows = [];
for (const url of urls) {
  const out = path.join(outRoot, slug(url));
  console.log(`\n=== ${url} ===`);
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'mirrorframe.js'), 'run', '--url', url, '--out', out],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 360000 });
  let summary = null;
  try { summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'))); } catch (e) {}
  const row = { url };
  if (r.status === 0 || r.status === 3) {
    row.outcome = summary ? summary.pageStatus + (summary.reason ? ':' + summary.reason : '') : 'crash';
    if (summary && summary.perNode) {
      row.nodes = Object.entries(summary.perNode).filter(([, v]) => v)
        .map(([k, v]) => `${v} ${k}`).join(', ');
      row.skips = summary.scope && Object.keys(summary.scope.skips || {}).length
        ? Object.entries(summary.scope.skips).map(([k, v]) => `${k}\u00d7${v}`).join(', ') : '';
      row.fold = summary.similarity ? (summary.similarity.fold * 100).toFixed(2) + '%' : '';
      row.captureMs = summary.durationMs;
    }
  } else {
    row.outcome = 'crash' + (r.status != null ? `(exit ${r.status})` : '(timeout)');
  }
  rows.push(row);
}

const agg = {};
for (const r of rows) {
  const key = r.outcome.split('(')[0].split(':')[0];
  agg[key] = (agg[key] || 0) + 1;
}

console.log('\n================ TRACK B BATCH REPORT ================');
console.table(rows.map(r => ({ url: r.url, outcome: r.outcome, nodes: r.nodes || '',
                               skips: r.skips || '', fold: r.fold || '', captureMs: r.captureMs || '' })));
console.log('Aggregate:', Object.entries(agg).map(([k, v]) => `${v}/${rows.length} ${k}`).join(', '));
fs.writeFileSync(path.join(outRoot, 'batch-report.json'), JSON.stringify({ rows, aggregate: agg }, null, 2));
console.log(`Report written to ${path.join(outRoot, 'batch-report.json')}`);
