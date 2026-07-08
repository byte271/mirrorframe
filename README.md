# Mirrorframe

**This project is packaged as a Claude Skill** — an AI agent should start from
[`SKILL.md`](SKILL.md) (workflow instructions + assertive trigger description) and the
deeper docs in [`references/`](references/). This README is the human-facing overview.

Capture a live page, distill a **Design Genome**, recover its **interaction state
machines**, reconstruct it as a React app, and verify the result **per node and per
interaction state** by visual diff — built entirely on technology that exists today
(Playwright, WAAPI, MutationObserver, esbuild, pixelmatch). Deterministic, no LLM in
the loop: every output is inspectable and reproducible.

> **Why 0.1, not 1.0:** this is a first public cut. The CLI flags, the genome schema,
> and the report format may all still change. 0.x is a statement of API instability,
> not of dishonest numbers — the numbers below are reproducible from a clean clone.

## Quick start (clean clone)

Requires Node.js ≥ 18. No other machine state is assumed.

```bash
git clone <this-repo> && cd mirrorframe
npm install            # also installs the Playwright Chromium binary (postinstall)
npm run verify         # full pipeline on all 4 fixtures + results table (exit 1 on any failure)

# single fixture / your own page
node scripts/mirrorframe.js run --dir ./fixtures/tabs --out ./mf-out/tabs
node scripts/mirrorframe.js run --url https://your-site.example --out ./mf-out/yours
# options: --width 1280 --height 800 (capture viewport)
```

Open the reconstruction at `<out>/recon-app/index.html` — a self-contained React app
(`app.jsx`, `styles.css`, `bundle.js`).

## What v0.1 handles (implemented, verified by `npm run verify`)

- Static pages: flexbox layout, type / color / spacing / radius / shadow token clustering
- CSS `@keyframes` animations (via WAAPI `getAnimations()`), CSS transitions, `:hover`
  states (recovered verbatim from same-origin stylesheets)
- **Scroll reveals**: the IntersectionObserver `hidden → visible` class state machine is
  detected via a MutationObserver scroll probe; trigger and visible class names are
  *recovered from the page*, never assumed
- **Click-driven state machines** (generalized behavior graphing): an interaction probe
  synthetically clicks interactive candidates, diffs class + computed-style state, tests
  reversibility, and classifies the result — nothing is hardcoded per component:
  - `toggle` — second click reverses the first (accordion / expand-collapse)
  - `exclusive` — one class moves between sibling groups (tabs / segmented controls)
  - `pair` — one trigger adds the class, another removes it (modal open / close),
    including triggers only reachable *inside* an open state (a modal's close button)
- **Per-node verification**: every tracked node gets its own similarity score and status
  (`pass` / `style-verified` / `corrected` / `failed` / `animated-unstable` /
  `hidden-at-capture`). Fold / full-page aggregates are reported **alongside** the
  per-node table, never instead of it.
- **Residual auto-correction**: a failing node's computed styles are re-read from the
  reconstruction, diffed against the capture, patched with a per-node override rule, and
  re-verified exactly once (`corrected` on success, `failed` with the reason otherwise).
- **Behavioral verification**: every recovered interaction state is replayed on the
  reconstruction with *real clicks* and pixel-diffed against a ground-truth screenshot of
  the original in that state.

## Verified results (all 4 fixtures, clean run)

Legend: P pass · SV style-verified (pixel residual, all tracked computed styles match —
sub-pixel glyph AA on tiny nodes) · C corrected · F failed · A animated-unstable
(infinite animation, phase-dependent pixels) · H hidden-at-capture (verified via state
replay instead).

| Fixture | Pattern | Per-node | States | Fold | Full |
|---|---|---|---|---|---|
| northlight | scroll reveal + keyframes + hover | 25P / 1A | — | 99.99% | 99.81% |
| accordion | toggle | 11P / 3SV / 2H | 6/6 pass | 99.99% | 99.99% |
| tabs | exclusive | 12P / 8H | 2/2 pass | 100.00% | 100.00% |
| modal | pair | 5P / 5H | 2/2 pass | 100.00% | 100.00% |

Run `npm run verify` to reproduce (exact similarity digits may vary in the last decimal
across platforms due to font rasterization; statuses should not).

## Known limitations (deliberate scope — see references/limitations.md and references/roadmap.md)

- No Canvas / WebGL / WebGPU / shader / post-processing reconstruction
- No physics, inertia, or spring recovery
- Behavior graphing covers **class-toggle** state machines driven by click and scroll
  only — no drags, hovers-with-JS, keyboard interactions, inline-style mutations, or
  DOM insertion/removal state machines
- One output target: React + plain CSS
- No images, background-images, web-font files, grid layouts, pseudo-elements,
  responsive breakpoints, or cross-origin stylesheets
- Auto-correction patches computed-style drift only; layout drift caused by untracked
  properties is reported as `failed`, not silently absorbed
- Proven on the four included fixtures (self-authored, no external assets) — "any
  website" is explicitly not claimed

## Artifacts (`--out` directory)

| File | Meaning |
|---|---|
| `capture.json` | evidence bundle: node tree, computed styles, animations, transitions, hover rules, reveal mutations, interaction probes |
| `genome.json` | Design Genome: tokens, motion DNA, interaction DNA (behaviors), annotated structure |
| `recon-app/` | generated React app (jsx + css + bundle + html) |
| `original-*.png` / `state-*.png` | ground-truth screenshots (initial + each interaction state) |
| `recon-*.png` / `diff-*.png` | reconstruction screenshots + pixelmatch residual maps |
| `convergence.json` | per-node table, correction log, state replay results, aggregates |
| `summary.json` | one-screen quantitative summary |

## Project layout

```
SKILL.md                        skill entrypoint: trigger description + agent workflow
scripts/mirrorframe.js          CLI: capture → genome → reconstruct → converge
scripts/verify-all.js           release verification: all fixtures + results table
scripts/lib/props.js            shared tracked-property list + color normalization
scripts/lib/capture.js          capture substrate: DOM/style walk, motion + interaction probes
scripts/lib/genome.js           genome compiler: tokens, reveal recovery, behavior classification
scripts/lib/reconstruct.js      deterministic React + CSS codegen (state machines re-wired)
scripts/lib/converge.js         per-node + aggregate diff, auto-correction, state replay
references/behavior-patterns.md recovered-pattern catalog (reveal/toggle/exclusive/pair)
references/limitations.md       hard scope limits + expected non-pass statuses
references/roadmap.md           v0.2–v0.4 planning, feasible-now vs research-level
fixtures/                       4 self-authored test pages (northlight, accordion, tabs, modal)
```

## Licensing

MIT (see `LICENSE`) — chosen for maximum permissiveness and zero friction for embedding
the pipeline in other tools. Compatibility audit:

- **Fixtures/assets**: all four fixtures are authored for this repo; system font stacks
  only; no external images, fonts, icons, or third-party snippets. Nothing needed replacement.
- **Runtime dependencies**: playwright (Apache-2.0), esbuild (MIT), pixelmatch (ISC),
  pngjs (MIT), react / react-dom (MIT). All permissive; no conflict with MIT.

## Honest engineering notes

- Recover constraints, not pixels: fixed `width`/`height` are never baked (neither in
  base rules, behavior state rules, nor correction patches) — bold text is *allowed* to
  widen a tab.
- Recover state machines, not frames: state classes (`open`, `active`, `shown`,
  `visible` — as observed, not assumed) are excluded from style-rule identity, and the
  off/on styles are emitted as explicit recovered state rules.
- Every claim in this README maps to a check in `npm run verify`; anything that failed
  or could not be observed is reported per node in `convergence.json` rather than
  averaged away.
