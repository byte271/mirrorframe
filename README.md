# Mirrorframe

Clone a live web page into a **verified, self-contained React app** — capture it with a
headless browser, distill a **Design Genome** (tokens + motion + interaction state
machines), reconstruct it deterministically, and prove the result **per node and per
interaction state** by visual diff. Built entirely on technology that exists today
(Playwright, WAAPI, MutationObserver, esbuild, pixelmatch). No LLM in the loop: every
output is inspectable and reproducible.

**This project is also packaged as a Claude Skill** — an AI agent should start from
[`SKILL.md`](SKILL.md) and the deeper docs in [`references/`](references/). This README
is the human-facing overview.

> **Why 0.x:** the CLI flags, genome schema, and report format may still change. 0.x is
> a statement of API instability, not of dishonest numbers — every number below is
> reproducible from a clean clone.

## Quick start

Requires Node.js ≥ 18. No other machine state is assumed.

```bash
git clone <this-repo> && cd mirrorframe
npm install            # postinstall downloads the Playwright Chromium binary

# clone a live URL (only pages you own or that are permissively licensed):
node scripts/mirrorframe.js run --url https://your-site.example --out ./mf-out/yours

# or a local page directory containing an index.html (served automatically):
node scripts/mirrorframe.js run --dir ./fixtures/tabs --out ./mf-out/tabs

# optional capture viewport: --width 1280 --height 800   (defaults shown)
# optional responsive re-capture (new in 0.4): --breakpoints 480,768

npm run verify         # regression gate: full pipeline on all 15 bundled fixtures
```

Open the reconstruction at `<out>/recon-app/index.html` — a self-contained React app
(`app.jsx`, `styles.css`, `bundle.js`) with all assets bundled locally in `<out>/assets/`.

## How it works (4 automatic stages inside `run`)

1. **Capture** → `capture.json`: headless Chromium walks the DOM recording computed
   styles per node, plus every motion/interaction signal listed below, and downloads
   all referenced assets.
2. **Genome** → `genome.json`: clusters design tokens, compiles motion DNA and
   interaction DNA (recovered state machines), annotates the structure.
3. **Reconstruct** → `recon-app/`: deterministic React + CSS codegen with the recovered
   state machines re-wired as real listeners/observers/animations.
4. **Converge** → `convergence.json` + `summary.json`: re-renders the reconstruction at
   the identical viewport, verifies per node and per state, auto-corrects residual
   drift, and replays every recovered interaction and scroll state.

## Feature list (v0.4.0 — everything below is implemented and verified)

### Capture & assets
- Full computed-style capture per node (layout, color, type, borders, shadows,
  radii, filters, transforms) at a configurable viewport
- **Images** (`<img>`) and **CSS background-images** downloaded and rewritten to
  local bundled copies (8MB/asset, 192MB/capture budgets; misses reported, never hidden)
- **Web fonts**: every `@font-face` is downloaded, bundled, and re-declared locally
- **SVG passthrough**: inline SVG markup is preserved verbatim
- **`<video>`** (new in 0.2): source + poster bundled locally (64MB/asset budget),
  playback attributes (autoplay/loop/muted/playsinline/controls) preserved, real
  `<video>` re-emitted; degrades to poster/first-frame still if the source is
  unfetchable — never an empty box
- **`<canvas>`** (new in 0.2): the currently painted frame is snapshotted and
  re-emitted as a pixel-true still
- Same-origin iframes captured; cross-origin content masked with a fixed reason
- **Pseudo-elements** (new in 0.4): `::before`/`::after` content (badges, timeline
  dots, underline accents, decorative marks) is captured per originating element
  and re-emitted as per-node pseudo rules; pseudo background-images are bundled
- **Responsive breakpoints** (new in 0.4): `--breakpoints 480,768` re-captures the
  page at extra viewport widths and emits the per-node style differences as real
  `@media` rules — the clone reflows like the original instead of being a
  single-width photograph; each width is pixel-verified against ground truth

### Motion (the "individual frame" tier)
- CSS `@keyframes` animations and transitions (recovered via WAAPI `getAnimations()`)
- `:hover` rules recovered verbatim from same-origin stylesheets; **JS-driven hover
  effects** recovered by a synthetic hover probe
- **Pointer choreography** (new in 0.3): mouse-movement effects are recovered by
  sampling the page over a 3×3 pointer grid and fitting every transform-matrix
  component as a plane over the pointer (least squares, R² ≥ 0.85) — parallax
  layers, 3D tilt cards (`matrix3d`), magnetic offsets, pointer-linked scale.
  **Smoothing/lag is recovered too**: the exponential time constant of the
  "ultra-smooth" trailing chase is measured from a pointer-jump step response
  and replayed with the same lerp in the reconstruction. Non-planar pointer
  physics is reported as unclassified, never guessed
- **Scroll choreography**: scroll-position–linked style tracks are sampled at multiple
  scroll depths and re-emitted; verified by scroll-state replay at 25/50/75%
- **Sequential scroll-reveal stagger** (new in 0.3): reveal mutations are
  timestamped, so elements that fade/slide in one by one are replayed with their
  observed per-element offsets; each participant's own computed `transition`
  (duration, easing curve, `transition-delay`) is re-emitted verbatim — CSS
  `nth-child` delay staggers and JS-timer staggers both survive the clone
- **Chronograph frame sampler** (new in 0.2): time-driven motion with *no declared
  animation object* (rAF loops, JS tickers) is detected and recorded at **every
  animation frame** for a bounded window (2400ms, ≤120 tracks) — transform, opacity,
  filter, clip-path per frame — then replayed verbatim as looping WAAPI animations
  built from the sampled offsets

### Interaction state machines (behavior graphing)
Recovered from the page by synthetic probes — never assumed or hardcoded:
- `reveal` — IntersectionObserver scroll-reveal (hidden → visible class machines)
- `toggle` — second click reverses the first (accordions, expand/collapse)
- `exclusive` — one class moves between siblings (tabs, segmented controls)
- `pair` — one trigger adds the class, another removes it (modal open/close,
  including triggers only reachable *inside* the open state)
- Ambient (timer-driven) mutations such as autoplay carousels are detected during an
  input-free watch and excluded from learning rather than mislearned
- A probe that crashes on a page-script conflict records `probe-error` for that
  candidate and the sweep continues (new in 0.2)
- **Keyboard/focus recovery** (new in 0.4): CSS `:focus`/`:focus-visible`/
  `:focus-within` rules recovered verbatim; a bounded keyboard agent probes every
  tabbable element and recovers JS-driven focus styling — style deltas compile to
  CSS `:focus` rules, class toggles are re-wired as real `focus`/`blur` listeners

### Verification (honest by construction)
- **Per-node**: every tracked node gets its own similarity score and one status —
  `pass` / `style-verified` / `corrected` / `failed` / `animated-unstable` /
  `hidden-at-capture` / `time-varying-replicated` (new in 0.2) / `skipped(reason)`
- **Residual auto-correction**: failing nodes get their reconstructed computed styles
  diffed against capture, patched with a per-node override, and re-verified once
- **Layout convergence**: rendered rects measured against captured rects; drifting
  nodes get authored sizes baked in bounded passes
- **Behavioral replay**: every recovered interaction state is replayed with real
  clicks and pixel-diffed against a ground-truth screenshot of the original
- **Scroll replay**: the page is verified at multiple scroll depths, not just the fold
- **Pointer replay** (new in 0.3): ground-truth screenshots at fixed pointer
  checkpoints are re-shot on the reconstruction with the same real mouse moves
  (settle time scaled to the largest recovered smoothing tau) and pixel-diffed;
  replay shots are settle-aware, waiting until consecutive frames match so
  staggered reveals and lag-smoothed effects finish before the diff
- **Focus replay** (new in 0.4): capture screenshots the first Tab stops after
  real Tab key presses (so `:focus-visible` fires exactly as it does for keyboard
  users); convergence replays the same Tab sequence and pixel-diffs each stop
- **Breakpoint replay** (new in 0.4): the reconstruction is resized to every
  captured breakpoint width and pixel-diffed against the original at that width
- **Time-varying honesty** (new in 0.2): bundled video/canvas and frame-sampled nodes
  have their *mechanism* replicated, but pixels depend on the playback instant — they
  are masked from diffs with the fixed reason `time-varying-media`, itemized, never
  averaged in or hidden
- **Fixed skip-reason taxonomy** (`scripts/lib/reasons.js`, 10 reasons): every skipped
  node/probe/page carries exactly one reason; skipped elements keep their layout
  footprint via placeholders and are masked from the diff
- Bounded everything: navigation fallback, probe budgets, node/candidate caps, 300s
  pipeline watchdog with distinct exit codes (0 ok / 3 page skipped / 4 crash)

## Verified results (clean run, `npm run verify`)

All 15 bundled fixtures pass with **0 failed nodes, 0 failed states, 0 failed
scroll/pointer/focus/breakpoint states** — including `stress-pseudo`
(::before/::after badges, dots, underlines, new in 0.4), `stress-keyboard`
(:focus/:focus-visible + JS focus styling, real-Tab replay, new in 0.4),
`stress-responsive` (grid reflow at 768/480px, verified at both widths, new
in 0.4), `stress-stagger`
(CSS-delay + JS-timer sequential reveals, new in 0.3), `stress-pointer`
(parallax/tilt/smooth-follower pointer choreography, new in 0.3), `stress-frames`
(rAF inline-style motion + animated canvas), `stress-scale` (230 nodes / 120
interactive), `stress-edgecss` (container queries, `:has()`), `stress-iframe`,
`stress-flaky` (404/hung assets), and `stress-carousel` (autoplay → excluded,
not mislearned).

The pipeline has also been spot-validated against complex real-world production pages
(hundreds of nodes; heavy video, scroll choreography, and rAF motion) with aggregate
similarities ≥ 99.9%, all scroll states passing, media and web fonts fully bundled,
and zero crashes — any sub-threshold node is itemized in the per-node report rather
than averaged away. Nothing from third-party pages is bundled in this repo.

## Reading the report

Success = zero `failed` nodes and zero failed states. `style-verified`,
`animated-unstable`, `hidden-at-capture`, `time-varying-replicated`, and
`skipped(reason)` are acceptable statuses when explained — see `SKILL.md` for the
full interpretation guide. The one-screen summary is `summary.json`; the full
per-node table is `convergence.json`; residual maps are `diff-*.png`.

## Artifacts (`--out` directory)

| File | Meaning |
|---|---|
| `capture.json` | evidence bundle: node tree, computed styles, animations, scroll/frame tracks, probes |
| `genome.json` | Design Genome: tokens, motion DNA, interaction DNA, annotated structure |
| `assets/` | locally bundled images, fonts, videos, posters, media stills |
| `recon-app/` | generated React app (jsx + css + bundle + html) |
| `original-*.png` / `state-*.png` / `scroll-*.png` / `pointer-*.png` / `focus-*.png` / `bp-*.png` | ground-truth screenshots |
| `recon-*.png` / `diff-*.png` | reconstruction screenshots + pixelmatch residual maps |
| `convergence.json` | per-node table, correction log, state/scroll replay results, aggregates |
| `summary.json` | one-screen quantitative summary |

## Project layout

```
SKILL.md                        skill entrypoint: trigger description + agent workflow
scripts/mirrorframe.js          CLI: capture → genome → reconstruct → converge
scripts/verify-all.js           release verification: all fixtures + results table
scripts/batch-verify.js         batch validation against a list of live URLs
scripts/lib/props.js            shared tracked-property list + color normalization
scripts/lib/reasons.js          fixed skip-reason taxonomy (10 reasons)
scripts/lib/assets.js           asset downloader/bundler (images, fonts, video)
scripts/lib/capture.js          capture substrate: DOM/style walk, motion + interaction probes
scripts/lib/genome.js           genome compiler: tokens, tracks, behavior classification
scripts/lib/reconstruct.js      deterministic React + CSS codegen (state machines re-wired)
scripts/lib/converge.js         per-node + aggregate diff, auto-correction, state replay
references/behavior-patterns.md recovered-pattern catalog (reveal/toggle/exclusive/pair)
references/limitations.md       hard scope limits + expected non-pass statuses
references/roadmap.md           forward planning, feasible-now vs research-level
fixtures/                       15 self-authored test pages (4 core + 11 stress)
```

## Known limitations (deliberate scope — see references/limitations.md)

- Canvas/WebGL *draw streams* are not reconstructed — a canvas becomes a pixel-true
  still of its captured frame, not a live re-render
- Pointer physics beyond a planar matrix-component model (proximity-gated magnets,
  springs with overshoot) is reported as unclassified, not approximated; recovered
  smoothing is a single exponential time constant per node
- No general physics/inertia/spring recovery; frame tracks replay observed motion verbatim
- Behavior graphing covers class-toggle machines driven by click/scroll/hover/focus —
  no drags, arrow-key/shortcut machines, or DOM insertion/removal machines
- One output target: React + plain CSS
- Responsive re-capture happens at the widths you pass via `--breakpoints`; the exact
  authored media-query thresholds between them are not inferred
- "Any website" is explicitly not claimed — read the per-node report before trusting output

## Licensing

MIT (see `LICENSE`). All fixtures are authored for this repo (system font stacks, no
external assets). Runtime dependencies: playwright (Apache-2.0), esbuild (MIT),
pixelmatch (ISC), pngjs (MIT), react / react-dom (MIT) — all permissive.

Only run against pages you own or that are permissively licensed; cloning third-party
commercial sites raises IP/ToS issues this tool does not resolve for you.

## Honest engineering notes

- Recover constraints, not pixels: fixed `width`/`height` are never baked into base
  rules — bold text is *allowed* to widen a tab (layout convergence bakes sizes only
  for measured drift, as a reported correction).
- Recover state machines, not frames — except where frames *are* the ground truth:
  the Chronograph tier replays sampled per-frame motion verbatim and says so.
- Every claim in this README maps to a check in `npm run verify`; anything that failed
  or could not be observed is reported per node in `convergence.json` rather than
  averaged away.
