# Changelog

## v0.4.0

Completeness + security release — three new capture dimensions (pseudo-elements,
keyboard/focus, responsive breakpoints), each with its own verification tier,
plus hardening of the local server and asset fetcher.

**Pseudo-element capture (::before / ::after)**
- Pseudo-elements paint real pixels (badges, timeline dots, underline accents,
  decorative quote marks) but have no DOM node to walk. Capture now reads
  `getComputedStyle(el, '::before'/'::after')` for every element; a pseudo
  exists iff its computed `content` is neither `none` nor `normal`. The full
  tracked property set is captured (plus `content` and explicit width/height —
  pseudo boxes have no content to derive size from), and pseudo
  `background-image` URLs are bundled like any other asset.
- Reconstruction re-emits each captured pseudo as a per-node
  `[data-mf-id]::before/::after` rule. Pseudo pixels are part of the normal
  per-node + aggregate diff — no special-casing, they simply have to match.

**Keyboard / focus recovery (new interaction dimension + replay tier)**
- CSS `:focus`, `:focus-visible`, and `:focus-within` rules are recovered from
  the page's stylesheets verbatim (same mechanism as hover rules).
- A keyboard agent focuses every tabbable candidate programmatically (bounded
  by `focusBudgetMs`, ambient-aware, class restore after each probe) and diffs
  the tracked styles of every node: JS-driven focus styling is recovered as
  per-trigger deltas. Style-only deltas compile to CSS `:focus` rules
  (same-node or descendant); class-toggling deltas are replayed with real
  `focus`/`blur` listeners in the reconstruction.
- **Focus-state verification tier**: capture presses real Tab keys (so
  `:focus-visible` fires exactly as it does for keyboard users) and screenshots
  the first `focusCheckpoints` tab stops; convergence replays the same Tab
  sequence on the reconstruction and pixel-diffs each stop. Reported as
  `focusStates` and gated by `npm run verify`.

**Responsive breakpoints (`--breakpoints`, new replay tier)**
- `--breakpoints 480,768` re-captures the page at each extra viewport width
  (media queries + resize handlers settled) and records, per node, exactly the
  tracked properties whose computed value differs from the base-width capture.
- Reconstruction emits the overrides as real `@media` rules — `max-width`
  queries for widths below the base viewport (narrowest last, so it wins) and
  `min-width` queries above — so the clone reflows like the original instead
  of being a single-width photograph.
- **Breakpoint-state verification tier**: capture screenshots the original at
  every requested width; convergence resizes the reconstruction to the same
  widths and pixel-diffs against the ground truth. Reported as
  `breakpointStates` and gated by `npm run verify`.

**Security hardening**
- Local fixture/dir server: request paths are decoded once, resolved against
  the served root, and must remain strictly inside it (separator-aware, so
  `/dir-evil` cannot shadow `/dir`); null bytes rejected; only GET/HEAD
  answered; targets are stat'd (no directories, no dangling paths).
- Asset fetcher: SSRF guard — private/loopback/link-local addresses are
  refused unless the captured page itself lives on that origin; extension
  sanitization (`/^\.[a-z0-9]{1,5}$/i`) so a hostile URL cannot smuggle path
  fragments into bundled filenames.
- `npm audit`: 0 known vulnerabilities in the dependency tree.

**Fixtures / gate**
- New `fixtures/stress-pseudo`: timeline dots, text badges, underline accents,
  and a decorative quote mark — all `::before`/`::after` content.
- New `fixtures/stress-keyboard`: `:focus` + `:focus-visible` CSS rules plus a
  JS focus listener that highlights the containing card; verified by real Tab
  replay (3 focus states).
- New `fixtures/stress-responsive`: a 3-column menu grid that reflows at 768px
  (2 columns) and 480px (1 column, accent flips from top to left border);
  verified at both breakpoint widths (run with `--breakpoints 480,768` by the
  release gate).
- All 15 fixtures pass `npm run verify` with 0 failed nodes/states, 0 failed
  scroll/pointer/focus/breakpoint states.

## v0.3.0

Visual-effects release — sequential scroll-reveal stagger and pointer
choreography, including the smoothing/lag that produces the "ultra-smooth"
trailing feel. Everything below is recovered from the page by observation,
replayed with the original curves, and verified by a new pointer-state
replay tier.

**Sequential scroll-reveal recovery (stagger + per-element curves)**
- Reveal mutations are now timestamped (plus scroll position) by the scroll
  agent's MutationObserver: the genome recovers each element's firing offset
  within its intersection burst, so JS-timer staggers (items released one by
  one via `setTimeout`) are replayed with the observed offsets. A burst
  boundary is a >500ms silence OR a different scroll position — elements that
  simply intersected at different sweep steps are never mislabeled as stagger.
- Per-element transition curves: each reveal participant's captured computed
  `transition` (duration, easing function, and `transition-delay`) is
  re-emitted verbatim as a per-node rule — CSS-authored staggers
  (`nth-child` delays) and mixed easing curves survive the clone exactly.
  Nodes whose CSS transition already carries a delay are excluded from
  timestamp-derived stagger (no double delay).
- The reconstruction's IntersectionObserver releases a burst's elements in
  viewport order with the recovered offsets, falling back to the recovered
  median stagger step for elements the capture sweep never saw fire.

**Pointer choreography (mouse-movement effects + the smooth feel)**
- The virtual-mouse agent now samples the page over a 3×3 pointer grid (with
  per-position settle so lag-smoothed followers reach their targets) and fits
  EVERY component of each node's transform matrix as a plane over the pointer
  (`v = a·mx + b·my + c`, least squares, R² ≥ 0.85 per component). This
  recovers parallax layers (per-layer coefficients, including inverse
  movement), 3D tilt cards (`rotateX`/`rotateY` components of `matrix3d`),
  magnetic/offset elements, and pointer-linked scale — not just linear
  translation followers.
- **Smoothing time-constant recovery**: many choreographies chase the pointer
  with an exponential lerp (`cur += (target − cur) · k` per frame) — the
  source of the trailing "ultra-smooth" feel. Capture measures each field's
  step response (park the pointer, jump it, sample the dominant matrix
  component per frame) and records tau = time to cover 63.2% of the gap.
  The reconstruction replays the fields with the same exponential chase in a
  rAF loop, using the recovered per-node tau; instant responders (tau 0)
  apply directly.
- Pointer-driven nodes that fit no planar model are recorded as
  `unclassified-behavior` (kind: pointer) — surfaced in the scope report,
  never guessed.

**Pointer-state verification (new replay tier)**
- Capture takes ground-truth screenshots at fixed pointer checkpoints (settle
  time scaled to the largest recovered tau, with a second exposure to mask
  time-driven pixels); convergence replays the same real mouse moves on the
  reconstruction and pixel-diffs per checkpoint. Reported as
  `pointerStates` in `convergence.json`/`summary.json` and gated by
  `npm run verify` alongside nodes/states/scroll.
- Scroll-state and full-page replay shots are now settle-aware: verification
  waits (bounded) until two consecutive frames match, so staggered reveal
  transitions and lag-smoothed pointer effects finish before the diff.

**Fixtures / gate**
- New `fixtures/stress-stagger`: six tiles staggered by CSS `nth-child`
  transition-delays (0–750ms, expo ease-out) + four rows staggered by JS
  timers on intersection. Verifies per-element curve recovery, timestamp
  stagger, and settle-aware replay.
- New `fixtures/stress-pointer`: three parallax layers (distinct
  coefficients, one inverted), a 3D tilt card (`matrix3d`), and a smooth
  follower chip (exponential lerp, k=0.12/frame). Verifies matrix plane
  fitting, tau recovery (measured ≈211ms), and pointer-state replay
  (both checkpoints ≥99.88%).
- All 12 fixtures pass `npm run verify` with 0 failed nodes/states,
  0 failed scroll states, 0 failed pointer states.

## v0.2.0

Fidelity release — capture completeness down to the individual frame, and full
asset/media bundling. Spot-validated end-to-end against complex real-world
production pages (hundreds of nodes, heavy video/scroll/rAF motion): aggregate
similarity ≥ 99.9%, 0 crashes, videos/canvases replicated, all assets and web
fonts bundled locally. Nothing from third-party pages is bundled in this repo.

**Chronograph frame sampler (per-frame motion capture)**
- Time-driven motion with *no declared animation object* (rAF loops, JS tickers,
  WebGL-adjacent DOM choreography) is now detected by two cheap snapshots and
  then recorded at **every animation frame** for a bounded window
  (`frameSampleMs` 2400ms, ≤120 tracks/page): transform, opacity, filter,
  clip-path per frame.
- Frame tracks are replayed verbatim in the reconstruction as infinitely
  looping WAAPI animations built from the sampled offsets — the actual observed
  frames, not a fitted approximation.
- Frame-sampled (id, prop) pairs are deduplicated from scroll-track recovery:
  a "scroll track" observed on a prop that moves with zero input is time
  aliasing, not scroll choreography, and the frame track wins.

**Video / canvas bundling (media are no longer empty boxes)**
- `<video>`: source and poster are downloaded and bundled locally (own 64MB
  per-asset budget), playback attributes (autoplay/loop/muted/playsinline/
  controls) preserved, and a real `<video>` element re-emitted. If the source
  is unfetchable (or a session-local `blob:`), the reconstruction degrades to
  the poster or a first-frame snapshot — never an empty placeholder.
- `<canvas>`: the currently painted frame is snapshotted via `toDataURL` and
  re-emitted as a pixel-true still.
- Media stills/posters are materialized as real files in `assets/` instead of
  inlined base64 (keeps `bundle.js` small).

**Honest verification for time-varying content**
- New per-node status `time-varying-replicated` (reason `time-varying-media`):
  bundled video/canvas and frame-sampled nodes have their *mechanism*
  reproduced, but their pixels depend on the playback instant — they are
  masked from pixel diffs with a fixed reason instead of pretending an
  arbitrary instant should match. Counted and itemized, never hidden.

**Probe robustness (bug fixes)**
- Individual interaction probes are now wrapped per-candidate: a page script
  that throws on synthetic clicks no longer aborts the whole sweep (previously
  mislabeled `unparseable-markup`); the failing candidate is recorded with the
  new fixed reason `probe-error` and the sweep continues. On real production
  pages this recovers behaviors that v0.1.x lost entirely.
- `blob:` URLs are excluded from asset fetching (they can never resolve
  outside the original session) instead of being counted as misses.

**Fixtures / gate**
- New `fixtures/stress-frames`: a rAF-driven orb (inline-style motion, no CSS
  animation object) + an animated canvas. Verifies frame-track recovery, WAAPI
  replay, canvas stills, and time-varying masking. All 10 fixtures pass
  `npm run verify` with 0 failed nodes/states.

Also documented (shipped in the v0.1.2→v0.2.0 work stream, previously
unlisted): image/background-image/web-font bundling with local rewrite,
SVG passthrough, scroll-position style tracks with scroll-state verification,
JS hover probes, and cursor-follower recovery.

## v0.1.2

Hardening release — robustness and honest scope reporting against real,
uncontrolled webpages. **No new capability** (contrast with a future v0.2
feature release): no new behavior categories, media, or output targets.

- Bounded everything: navigation fallback (`networkidle` 30s → `domcontentloaded`
  + settle), interaction-probe wall-clock budget (60s), node cap (1500),
  candidate cap (200), state-replay timeouts, 300s pipeline watchdog with a
  crash summary and distinct exit codes (0 ok / 3 page skipped / 4 crash).
- Fixed skip-reason taxonomy (`scripts/lib/reasons.js`, 8 reasons) — every
  skipped node, probe, or page carries exactly one; nothing is silently dropped.
  Skipped elements keep their layout footprint via placeholders and are masked
  from the pixel diff; per-node reports itemize them.
- Ambient watch: timer-driven class mutations (autoplay carousels, tickers) are
  detected during an input-free window, expanded to class-sharing siblings, and
  excluded from behavior recovery as `unclassified-behavior` — not mislearned.
- Tracked-property gaps found by stress fixtures fixed: per-side borders,
  `flexWrap`, `listStyleType`, abs-positioned container heights, per-node
  overrides for context-driven CSS divergence (`:has()`, `nth-child`).
- Track A: five self-authored stress fixtures bundled — `stress-scale` (230
  nodes, 120 interactive), `stress-edgecss` (container queries, `:has()`, deep
  cascades), `stress-iframe` (same-origin + sandboxed), `stress-flaky` (404/hung
  assets, nav fallback), `stress-carousel` (autoplay → skipped, not learned).
  All pass `npm run verify` with 0 failed nodes/states.
- Track B: `scripts/batch-verify.js` validated the pipeline against 18 real
  public URLs — 0 crashes, 0 hangs; 5 success / 11 partial (failed nodes
  itemized per page) / 2 `network-timeout`. Validation only; nothing bundled.
- Original four fixtures reproduce their v0.1.0 numbers (northlight fold
  improved 99.99% → 100.00% from the per-side border fix; all others exact).

## v0.1.1

- Packaged as an actual Claude Skill; no logic changes from v0.1.0.
  - `SKILL.md` (frontmatter description + agent workflow instructions)
  - `bin/` + `src/` relocated unchanged into `scripts/` (+ `scripts/lib/`)
  - Behavior-pattern catalog, limitations, and roadmap moved to `references/`
  - Verified: `npm run verify` reproduces the v0.1.0 numbers exactly after the move

## v0.1.0

- First public cut: capture → Design Genome → React reconstruction → convergence.
- Generalized behavior graphing (reveal / toggle / exclusive / pair state machines).
- Per-node verification with residual auto-correction; behavioral state replay.
- MIT license, fixture/dependency audit, clean-clone reproducibility gate.
