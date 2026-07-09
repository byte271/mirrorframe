# Known limitations (deliberate scope of this version)

Read this before promising results to anyone. Scope is intentionally narrow and
verified; see `roadmap.md` for what comes next and what is research-level.

- **No live Canvas / WebGL / WebGPU re-render.** Since v0.2 a `<canvas>`
  reconstructs as a pixel-true still of its captured frame (and `<video>` as a
  bundled playing element) — but the draw/shader program itself is not recovered.
- **No general physics, inertia, or spring recovery.** The v0.2 frame sampler
  replays observed motion verbatim (bounded window, looped); it does not fit
  curves or recover the generating simulation. The v0.3 pointer tier recovers
  exactly one physics primitive — an exponential smoothing time constant per
  pointer-driven node — not springs with overshoot or velocity-dependent drag.
- **Pointer choreography is a planar matrix-component model.** v0.3 recovers
  effects whose transform components respond linearly to pointer position
  (parallax, tilt, magnetic offset, pointer-linked scale), plus per-node
  exponential smoothing. Non-planar pointer physics (proximity-gated magnets
  that engage only near the element, orbiting cursors, velocity-based skew)
  is reported as `unclassified-behavior` (kind: pointer), never approximated.
  Effects on properties other than `transform` (pointer-driven gradients,
  clip-paths) are not yet fitted.
- **Stagger recovery is observational.** Sequential-reveal offsets come from
  mutation timestamps observed during the scroll sweep; elements that never
  fired during capture fall back to the recovered median stagger step. Very
  long staggers (>2s per element) are clamped.
- **Behavior graphing covers class-toggle state machines driven by click, scroll,
  hover, and focus** — no drags, arrow-key/shortcut machines, inline-style-mutation
  machines (beyond frame-sampled visual props), or DOM insertion/removal state
  machines. Focus recovery (v0.4) covers :focus/:focus-visible/:focus-within CSS
  and JS focus/blur styling; typing, `input` events, and IME behavior are out.
- **One output target: React + plain CSS.** No Vue/Svelte/etc. yet.
- **Responsive recovery is sample-based (v0.4).** `--breakpoints` re-captures at
  the widths you pass and emits @media overrides at exactly those thresholds; the
  authored breakpoint values between samples are not inferred, and viewport units/
  container queries between samples reflow only as the base CSS allows.
  Cross-origin stylesheets whose rules cannot be read stay out of scope.
- **Pseudo-elements are style snapshots (v0.4).** ::before/::after are re-emitted
  with their captured computed styles (including counters/`attr()` already
  resolved to their capture-time text); pseudo-elements with their own hover/
  animation dynamics replay only what the originating element's rules drive.
- **Auto-correction patches computed-style drift only.** Layout drift caused by
  untracked properties is reported as `failed`, not silently absorbed.
- **Proven on the included fixtures** (self-authored, no external assets) and
  spot-validated against real public pages (v0.1.2 Track B; v0.2.0 against
  complex production pages end-to-end). "Any website" is
  explicitly not claimed — treat runs against arbitrary sites as exploratory and
  read the per-node report before trusting the output.

## Graceful scope detection (v0.1.2, extended in v0.2.0)

Out-of-scope input no longer crashes or silently disappears. Every skipped node,
probe, or page carries exactly one reason from a fixed taxonomy
(`scripts/lib/reasons.js`, 10 reasons); free-text excuses are not allowed anywhere:

| Reason | Trigger |
|---|---|
| `unclassified-behavior` | interaction/mutation that matches no known pattern; includes timer-driven ("ambient") mutations such as autoplay carousels, detected by an input-free MutationObserver watch and expanded to class-sharing siblings |
| `out-of-scope-medium` | replaced media outside the bundled set (`<audio>`, `<object>`, `<embed>`, WebGL without DOM) — since v0.2, `<img>`/`<svg>`/`<video>`/`<canvas>` are captured, not skipped |
| `cross-origin-content` | iframe with inaccessible `contentDocument`; cross-origin stylesheets whose rules can't be read |
| `network-timeout` | navigation never reached `domcontentloaded` within the bound |
| `unparseable-markup` | document with no usable `<body>` |
| `unsupported-element` | renderable element outside the capture tag set |
| `time-budget-exceeded` | probe/replay/pipeline wall-clock budget exhausted (probe 60s, pipeline watchdog 300s) |
| `scale-cap-exceeded` | node cap (1500) or interaction-candidate cap (200) reached |
| `probe-error` (v0.2) | an in-page probe threw on a candidate (page-script conflict); that candidate is skipped, the sweep continues, partial results are kept |
| `time-varying-media` (v0.2) | bundled video/canvas or frame-sampled motion — the mechanism is replicated but pixels depend on the playback instant; masked from diffs, node statused `time-varying-replicated` |

Skipped elements keep their layout footprint via placeholders, are masked out of
the pixel diff, and are itemized in the per-node report — the aggregate never
hides them. Navigation falls back from `networkidle` (30s) to
`domcontentloaded` + settle when a page never goes network-quiet (reported as
`navFallback`).

## Performance bounds (stated and measured)

- **Capture** is bounded by construction: navigation ≤ 30s (+30s fallback + 3s
  settle) + ambient watch 1.5s + interaction-probe budget 60s + fixed per-phase
  timeouts. Measured on `stress-scale` (230 captured nodes, 120 interaction
  candidates): 60.3s total capture, dominated by the probe budget — ≈15× the
  <4s page load, versus ≈4–13s on ordinary pages (Track B median ≈7s).
- **Whole pipeline** ≤ 300s watchdog; exceeding it is reported as a crash with
  `time-budget-exceeded`, never a hang. `stress-scale` completes in ≈95s.
- **Memory** does not grow unbounded with DOM size: node capture caps at 1500
  nodes and probe candidates at 200 (`scale-cap-exceeded` beyond that), and
  per-node records hold only the tracked property list, not full subtrees.

## Still hard failures (not yet graceful)

- A page that crashes the browser tab itself (OOM, renderer crash).
- JS `alert()`/`confirm()` loops are auto-dismissed, but a page that navigates
  away mid-capture aborts the run.
- Infinite scroll / virtualized lists: capture sees only the initially
  materialized DOM; nothing detects that content was virtualized.
- Client-side redirects after `domcontentloaded` can yield a capture of the
  interstitial rather than the destination.

## Expected non-pass statuses (not bugs)

- `animated-unstable`: an infinite animation's pixels depend on screenshot phase; the
  node is excluded from pass/fail rather than averaged in.
- `time-varying-replicated` (v0.2): bundled video/canvas or frame-sampled motion —
  replicated mechanism, phase-dependent pixels, masked with `time-varying-media`.
- Sub-pixel text-wrap drift: a text block whose line wrapping differs by a word due
  to font-rasterization metrics can score just under threshold (`failed` with
  `style-drift-not-patchable`) even though every tracked computed style matches;
  inspect its `diff-*.png` before treating it as a real defect.
- `style-verified`: sub-pixel glyph anti-aliasing residual on tiny nodes while all
  tracked computed styles match exactly.
- `hidden-at-capture`: the node starts hidden (closed accordion/modal/inactive tab
  panel); it is verified via interaction-state replay instead of the initial diff.

## Legal / provenance

Only run against pages you own, local fixtures, or permissively-licensed sites.
Reconstruction of third-party commercial sites raises IP/ToS issues that this tool does
not resolve for you.
