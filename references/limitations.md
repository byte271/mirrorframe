# Known limitations (deliberate scope of this version)

Read this before promising results to anyone. Scope is intentionally narrow and
verified; see `roadmap.md` for what comes next and what is research-level.

- **No Canvas / WebGL / WebGPU / shader / post-processing reconstruction.** Pages whose
  visuals are painted into a canvas will reconstruct as an empty box.
- **No physics, inertia, or spring recovery.**
- **Behavior graphing covers class-toggle state machines driven by click and scroll
  only** — no drags, JS hover effects, keyboard interactions, inline-style mutations,
  or DOM insertion/removal state machines.
- **One output target: React + plain CSS.** No Vue/Svelte/etc. yet.
- **No images, background-images, web-font files, grid layouts, pseudo-elements,
  responsive breakpoints, or cross-origin stylesheets.** Best results on flexbox
  layouts with system font stacks.
- **Auto-correction patches computed-style drift only.** Layout drift caused by
  untracked properties is reported as `failed`, not silently absorbed.
- **Proven on the included fixtures** (self-authored, no external assets) and
  spot-validated against real public pages (v0.1.2 Track B). "Any website" is
  explicitly not claimed — treat runs against arbitrary sites as exploratory and
  read the per-node report before trusting the output.

## Graceful scope detection (v0.1.2)

Out-of-scope input no longer crashes or silently disappears. Every skipped node,
probe, or page carries exactly one reason from a fixed taxonomy
(`scripts/lib/reasons.js`); free-text excuses are not allowed anywhere:

| Reason | Trigger |
|---|---|
| `unclassified-behavior` | interaction/mutation that matches no known pattern; includes timer-driven ("ambient") mutations such as autoplay carousels, detected by an input-free MutationObserver watch and expanded to class-sharing siblings |
| `out-of-scope-medium` | `<canvas>`, `<video>`, `<img>`, `<svg>`, same-origin `<iframe>`, other replaced media |
| `cross-origin-content` | iframe with inaccessible `contentDocument`; cross-origin stylesheets whose rules can't be read |
| `network-timeout` | navigation never reached `domcontentloaded` within the bound |
| `unparseable-markup` | document with no usable `<body>` |
| `unsupported-element` | renderable element outside the capture tag set |
| `time-budget-exceeded` | probe/replay/pipeline wall-clock budget exhausted (probe 60s, pipeline watchdog 300s) |
| `scale-cap-exceeded` | node cap (1500) or interaction-candidate cap (200) reached |

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
- `style-verified`: sub-pixel glyph anti-aliasing residual on tiny nodes while all
  tracked computed styles match exactly.
- `hidden-at-capture`: the node starts hidden (closed accordion/modal/inactive tab
  panel); it is verified via interaction-state replay instead of the initial diff.

## Legal / provenance

Only run against pages you own, local fixtures, or permissively-licensed sites.
Reconstruction of third-party commercial sites raises IP/ToS issues that this tool does
not resolve for you.
