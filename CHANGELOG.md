# Changelog

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
