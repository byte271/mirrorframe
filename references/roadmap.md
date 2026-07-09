# Mirrorframe Roadmap — from v0.1 to the blueprint

v0.1 proves the loop on one narrow target class, with per-node verification and
class-toggle behavior graphing. Everything below is ordered by what must become
*technically true* before each phase is feasible. Anything labelled **research-level**
does not exist as reliable tooling today and is not claimed as buildable now.

## Done in v0.1 (was the v2 capability list; verified by `npm run verify`)

- **Behavior graphing beyond reveal**: generalized class-toggle state-machine recovery
  via a synthetic click probe — `toggle` (accordion), `exclusive` (tabs), `pair`
  (modal open/close, including in-state triggers). Recovered as states + trigger +
  transition; no per-component hardcoding.
- **Per-node verification**: every tracked node scored and statused individually
  (`pass` / `style-verified` / `corrected` / `failed` / `animated-unstable` /
  `hidden-at-capture`); aggregates reported alongside, never instead.
- **Residual auto-correction**: failed nodes get their reconstructed computed styles
  diffed against capture, a per-node CSS patch appended, and one re-verification pass.
- **Behavioral verification**: recovered states replayed with real clicks and diffed
  against ground-truth state screenshots.
- OSS hygiene: MIT license, fixture/dependency license audit, clean-clone README,
  version 0.1.0, `npm run verify` release gate.

## Done in v0.2.0 (verified by `npm run verify` + live spot-validation runs)

- **Asset bundling**: images, background-images, web fonts, SVG passthrough —
  downloaded and rewritten to local copies with bounded budgets.
- **Media bundling**: `<video>` source + poster bundled and re-emitted as a real
  element (still fallback); `<canvas>` snapshotted as a pixel-true still.
- **Chronograph frame sampler** (pulled forward from the v0.3 sampled-motion tier,
  verbatim-replay variant): rAF/JS-driven motion recorded at every animation frame
  for a bounded window and replayed as looping WAAPI animations. No curve fitting —
  the observed frames ARE the artifact.
- **Scroll choreography** (pulled forward from v0.3): scroll-position style tracks
  sampled at multiple depths, re-emitted, and verified by scroll replay.
- **Probe robustness**: per-candidate error isolation (`probe-error`) instead of
  whole-sweep aborts; JS hover probes; cursor-follower recovery.
- **Honest time-varying verification**: `time-varying-replicated` status +
  `time-varying-media` masking for content whose pixels depend on playback phase.

## Done in v0.3.0 (verified by `npm run verify`)

- **Sequential scroll-reveal stagger**: reveal mutations timestamped (with scroll
  position) during the sweep; per-element firing offsets recovered and replayed,
  with each participant's own computed transition (duration/easing/delay)
  re-emitted verbatim. CSS `nth-child` delay staggers and JS-timer staggers both
  survive the clone.
- **Pointer choreography** (pulled forward from the interactive-effects tier):
  3×3 pointer-grid sampling with per-component transform-matrix plane fitting
  (parallax, 3D tilt, magnetic offset, pointer-linked scale) plus per-node
  exponential smoothing time-constant recovery from a step response — the
  "ultra-smooth" trailing feel is measured and replayed, not approximated.
- **Pointer-state verification tier**: ground-truth pointer checkpoints re-shot
  on the reconstruction with real mouse moves and pixel-diffed, gated by
  `npm run verify`; settle-aware replay screenshots throughout.

## Done in v0.4.0 (verified by `npm run verify`)

- **Pseudo-element capture**: ::before/::after computed styles read per originating
  element and re-emitted as per-node pseudo rules; pseudo background-images bundled.
- **Keyboard/focus recovery**: :focus/:focus-visible/:focus-within CSS recovered
  verbatim; a bounded keyboard agent recovers JS-driven focus styling (style deltas
  → CSS :focus rules, class toggles → real focus/blur listeners); real-Tab
  focus-state verification tier.
- **Responsive breakpoints**: `--breakpoints` multi-viewport re-capture, per-node
  computed-style diffs emitted as real @media rules, per-width breakpoint-state
  verification tier.
- **Security hardening**: local-server path-traversal/method hardening, asset-fetcher
  SSRF guard + extension sanitization, clean `npm audit`.

## Remaining feasible-now items (engineering work)

- **Behavior graphing v1.5**: enumerate listeners via CDP `DOMDebugger.getEventListeners`;
  extend the probe to input/typing and arrow-key/shortcut machines; recover state machines
  expressed as inline-style mutation or DOM insertion/removal (currently class-toggle only).
- **Authored-threshold inference**: read the page's own @media rule conditions from
  same-origin stylesheets so recovered breakpoints land on the authored thresholds
  rather than the sampled widths.
- **Component induction**: cluster repeated subtrees (the three cards) into one
  parametrized component with props. Tree edit-distance clustering is standard engineering.
- **Correction attribution v1.5**: extend auto-correction beyond computed-style drift to
  layout drift (text metrics, box-model interactions), with bounded multi-pass re-verify.
- **Second target framework** (Vue or Svelte) to force the Genome → emitter interface to
  be genuinely framework-neutral before adding more targets.

Prereq: none — all APIs exist today (CDP, WAAPI, IntersectionObserver, esbuild).

## Next — sampled-motion curve fitting + canvas (hard engineering, some research risk)

- **Chronograph sampled tier**: rAF-driven per-frame sampling of transform/opacity for
  JS-driven animations (GSAP, scroll-linked), then least-squares fit of cubic-bezier /
  spring curves. Curve-fitting is known math; robustness across jank/GC pauses is the
  hard part.
- **Physics Echo (partial)**: recover spring constants from decay envelopes of sampled
  motion. Feasible for clean springs; **research-level** for coupled or gesture-driven physics.
- **Scroll choreography**: correlate scroll position with sampled style changes to recover
  parallax and scroll-linked timelines (`animation-timeline: scroll()` where supported).
- **Canvas 2D understanding**: hook `CanvasRenderingContext2D` to record the draw command
  stream and re-emit it — command capture is doable; semantic *understanding* of what the
  commands draw is **research-level**.
- **Multi-framework parity** (React/Next/Vue/Svelte/Solid) with a per-locus fidelity map.

Prereq: a stable per-frame sampling harness with jitter compensation; a curve-fitting
library validated against a corpus of known easings.

## v0.5+ — GPU tier + self-improving loop at scale (research-level)

- **Shader Mirror**: intercept WebGL/WebGPU via API wrapping to capture programs,
  uniforms, and draw calls. Re-executing captured shaders verbatim is feasible;
  *decompiling* minified shaders into editable semantic effect graphs requires
  program-analysis / ML breakthroughs that do not exist yet.
- **Full Physics Echo**: causal system identification of arbitrary interactive physics
  from observed trajectories — active research (system identification + program synthesis).
- **Flutter / SwiftUI / Compose targets**: needs a capability matrix + fidelity-degradation
  policy per platform; the blocker is behavioral parity testing infrastructure, not codegen.
- **Convergence Loop at scale**: multi-axis convergence (static / temporal / behavioral)
  with automatic hypothesis revision. Needs a cheap per-frame perceptual diff over aligned
  timelines to run in an inner loop.
- **One-shot Genome priors**: models that propose a likely genome from a single capture
  pass, verified by the loop. Requires a corpus of (site, verified-genome) pairs that
  only earlier phases can generate.

## Track B findings (v0.1.2 real-page validation — noted, not implemented)

Patterns that dominated `partial`/skip outcomes across 18 real public pages, in
rough order of impact, all deliberately out of scope for v0.1.2:

- **Images and background-images** — by far the most common `unsupported-element`
  / `out-of-scope-medium` source; asset capture + re-hosting policy needed (v0.2).
- **Inline SVG icons** — ubiquitous; feasible-now (serialize the SVG subtree verbatim).
- **Web-font files** — text metrics drift when a custom font falls back; needs
  font capture/subsetting with a licensing policy.
- **CSS grid layouts** — grid-template properties are untracked; feasible-now.
- **Pseudo-elements (::before/::after)** — common for decoration; feasible-now via
  `getComputedStyle(el, '::before')`.
- **Cookie/consent overlays** — occlude the fold at capture time on several sites;
  needs a detection + dismissal policy, not a new behavior category.
- **Virtualized/infinite lists** — only the materialized DOM is captured; detection
  (scroll-driven DOM insertion) is feasible, faithful recovery is not.

## Known residuals in v0.1 (reported, not hidden)

- Infinite animations are phase-dependent at screenshot time → `animated-unstable`,
  excluded from pass/fail rather than averaged in.
- Tiny glyph-bearing nodes can show sub-pixel anti-aliasing residuals with identical
  tracked computed styles → `style-verified`, not `pass`.
- Nodes hidden at capture (closed accordion panels, inactive tab panels, closed modals)
  cannot be pixel-verified in the initial screenshot → `hidden-at-capture`; they are
  verified via interaction-state replay instead.

## Explicitly not claimed

Nothing in v0.1 performs shader reconstruction, physics recovery, behavior graphing
beyond click/scroll class-toggle machines, or multi-framework emission. Where the
blueprint names a capability whose enabling technology does not exist today, it is
listed above as research-level rather than scheduled.
