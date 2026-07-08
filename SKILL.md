---
name: mirrorframe
description: >-
  Clone, recreate, or reverse-engineer a live web page into working React code with
  verified visual and behavioral fidelity. Use this skill whenever the user asks to
  "clone this site", "recreate this page in React", "turn this landing page into code",
  "extract the design system / design tokens from this URL", "copy this page's look",
  or to verify how faithfully a reconstruction matches an original. Mirrorframe
  captures the page with a headless browser, distills a Design Genome (color/type/
  spacing tokens, motion, interaction state machines like accordions, tabs, modals,
  scroll reveals), generates a self-contained React app, and verifies the result
  per-node and per-interaction-state by pixel diff — reporting honest pass/fail for
  every element, never just an aggregate score.
---

# Mirrorframe — capture → genome → reconstruct → converge

Deterministic pipeline (no LLM in the loop). Everything runs from this skill directory
with Node.js ≥ 18.

## Setup (once per machine)

```bash
cd <this skill directory>
npm install     # postinstall downloads the Playwright Chromium binary
```

If `playwright install chromium` did not run (offline installs), run it manually.

## Run the whole pipeline (the normal path)

One command runs all four stages and prints the verification report:

```bash
node scripts/mirrorframe.js run --dir /path/to/page-directory --out ./mf-out/name
# or, for a live URL you have rights to:
node scripts/mirrorframe.js run --url https://example.com --out ./mf-out/name
# optional viewport: --width 1280 --height 800   (defaults shown)
```

- `--dir` expects a directory containing an `index.html`; it is served over a local
  ephemeral HTTP server automatically.
- Only run against pages the user owns or that are permissively licensed
  (see `references/limitations.md`, "Legal / provenance").

The stages, in order (all automatic within `run`):

1. **Capture** → `<out>/capture.json`. Headless Chromium walks the DOM recording
   computed styles per node, keyframe animations, transitions, hover rules; a scroll
   probe detects scroll-reveal state machines; a synthetic click probe discovers
   click-driven state machines (accordion/tabs/modal) and screenshots each recovered
   state as ground truth (`state-*.png`). Assets (images, background-images, web
   fonts, video sources/posters) are downloaded and bundled locally; canvases are
   snapshotted as stills; a frame sampler records rAF-driven motion at every
   animation frame for a bounded window (v0.2).
2. **Genome** → `<out>/genome.json`. Clusters tokens (color/type/spacing/radius/shadow),
   compiles motion DNA (animations/transitions) and interaction DNA (`interaction.
   behaviors[]` — recovered state machines typed `reveal`/`toggle`/`exclusive`/`pair`;
   see `references/behavior-patterns.md` for what each type means).
3. **Reconstruct** → `<out>/recon-app/`. Generates a self-contained React app
   (`app.jsx`, `styles.css`, `bundle.js`, `index.html`) with the recovered state
   machines re-wired as real listeners/observers. Open `recon-app/index.html` directly
   in a browser to inspect it.
4. **Converge** → `<out>/convergence.json` + `<out>/summary.json`. Re-renders the
   reconstruction at the identical viewport and verifies it (see next section).

After "Done.", the CLI prints the contents of `summary.json` as JSON — it is the same
data as the file, not an additional artifact.

## How to read the verification result

The CLI prints, and `convergence.json` contains, three levels — always read the
per-node level first; never report only the aggregate:

- **Per node** (`nodes[]`): each tracked node gets `similarity` (0–1) and a `status`:
  - `pass` — pixel similarity ≥ 0.98 for that node's region.
  - `style-verified` — pixel residual, but every tracked computed style matches
    exactly (sub-pixel text anti-aliasing on tiny nodes). Treat as OK.
  - `corrected` — node initially failed; a per-node CSS patch was auto-applied and it
    passed re-verification. The patch is appended to `recon-app/styles.css`.
  - `failed` — node still fails after one correction attempt. This is a real fidelity
    failure; report it explicitly with its similarity, never average it away.
  - `animated-unstable` — node has an infinite animation; pixels depend on screenshot
    phase, so it is excluded from pass/fail. Expected, not a failure.
  - `time-varying-replicated` (v0.2) — bundled video/canvas or frame-sampled motion:
    the mechanism IS reproduced in the reconstruction, but the pixels depend on the
    playback instant, so the region is masked (reason `time-varying-media`).
    Expected, not a failure.
  - `hidden-at-capture` — node starts hidden (closed accordion/modal, inactive tab
    panel); verified via state replay instead. Expected, not a failure. Its
    `similarity` is `null` because no initial-screenshot pixels exist to compare.
  - `skipped` — node is out of scope, carrying one reason from the fixed taxonomy in
    `scripts/lib/reasons.js` (e.g. `cross-origin-content` for inaccessible iframes,
    `unclassified-behavior` for timer-driven mutations like autoplay carousels,
    `probe-error` for a candidate whose synthetic probe threw in page script).
    Its region is masked from the pixel diff and its layout footprint is preserved
    by a placeholder. Expected on real pages; report the reasons, never hide them.
- **Per interaction state** (`states[]`): each recovered behavior state is replayed on
  the reconstruction with a real click and diffed against the original's ground-truth
  state screenshot; pass threshold 0.98. A state `fail` means the recovered behavior
  does not visually reproduce — report it.
- **Aggregate** (`summary.similarity.fold` / `.full`): whole-viewport and full-page
  similarity. Report these *alongside* the per-node results, never instead of them.

Success = zero `failed` nodes and zero failed states. `style-verified`,
`animated-unstable`, `hidden-at-capture`, `time-varying-replicated`, and
`skipped` (with its reason) are
acceptable statuses when explained. The whole-page outcome is in `summary.json`
(`pageStatus`: `success` / `partial` / `skipped` / `crash`; exit codes 0/3/4).
A page that never loads is `skipped:network-timeout`, not a crash.

To validate against a batch of live URLs (nothing is bundled from them):
`node scripts/batch-verify.js --urls urls.txt --out mf-out/batch` — prints a
per-page outcome table plus aggregate stats; the aggregate never hides a page.

## Verify the skill itself (regression gate)

```bash
npm run verify   # runs the pipeline on all bundled fixtures; exit 1 on any failure
```

Bundled fixtures: `fixtures/northlight` (scroll reveal + keyframes + hover),
`fixtures/accordion` (toggle), `fixtures/tabs` (exclusive), `fixtures/modal` (pair),
plus stress fixtures `stress-scale` (230 nodes), `stress-edgecss` (container
queries/`:has()`), `stress-iframe` (same-origin + sandboxed), `stress-flaky`
(404/hung assets), `stress-carousel` (autoplay → skipped, not learned), and
`stress-frames` (rAF inline-style motion + animated canvas → frame tracks +
stills + time-varying masking; v0.2).

## When to consult references/

- `references/behavior-patterns.md` — what each recovered behavior type
  (reveal/toggle/exclusive/pair) means, how it is detected, its genome shape, and what
  behavior graphing does NOT cover.
- `references/limitations.md` — hard scope limits (no live canvas/WebGL re-render,
  React-only output, single viewport), expected non-pass statuses, and
  legal/provenance rules. Read before promising results on an arbitrary site.
- `references/roadmap.md` — what is planned vs. research-level; consult when a user
  asks for something out of scope.

## Failure triage

- Reconstruction looks empty → the page likely loads cross-origin styles or paints
  everything into WebGL without DOM (check `references/limitations.md`); plain
  canvases and videos reconstruct as stills/bundled media since v0.2.
- A behavior was not recovered → it probably isn't a class-toggle machine driven by
  click/scroll; check `capture.json`'s probe evidence and the pattern catalog.
- `failed` nodes → inspect `<out>/diff-*.png` residual maps and the node's entry in
  `convergence.json` (it lists the mismatched properties when known).
