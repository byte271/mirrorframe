# Changelog

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
