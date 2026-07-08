# Behavior-pattern catalog (what Mirrorframe can recover)

Mirrorframe recovers **class-toggle state machines**: interaction patterns whose visual
states are expressed by adding/removing a CSS class. Each recovered behavior in
`genome.json` (`interaction.behaviors[]`) has: `type`, `cls` (the recovered state
class), `triggers` (node ids that flip the state), `targets` (nodes that receive the
class), `styleStates` (per-property off→on deltas), and `evidence` (raw probe
observations). Nothing is hardcoded per component — the class names and triggers are
recovered from the live page by a synthetic click probe plus a scroll probe.

## `reveal` — scroll-triggered appearance

- Detection: a MutationObserver watches class mutations while the capture pass scrolls
  the page; elements that gain a class as they enter the viewport (the
  IntersectionObserver `hidden → visible` idiom) are recorded.
- Recovered as: hidden-state style (opacity/transform before the class) + visible class
  name + viewport-entry trigger.
- Reconstruction: an equivalent IntersectionObserver is wired into the generated React
  app; the hidden state is emitted as an explicit CSS rule, and state-dependent
  opacity/transform are stripped from baked base rules.

## `toggle` — reversible click state (accordion / expand-collapse)

- Detection: clicking a trigger adds class `cls` to a target; clicking the same trigger
  again removes it (reversibility test passes).
- Typical genome entry: `{ "type": "toggle", "cls": "open", triggers: [...] }`.
- Reconstruction: a click listener toggles the class; off/on styles are emitted as
  recovered state rules.

## `exclusive` — one-of-N click state (tabs / segmented controls)

- Detection: clicking trigger B moves class `cls` from sibling A to B (the class exists
  on exactly one member of a sibling group at a time).
- Typical genome entry: `{ "type": "exclusive", "cls": "active" }`.
- Reconstruction: click listeners remove the class from the sibling group and add it to
  the clicked trigger's target.

## `pair` — asymmetric open/close (modal / dialog / drawer)

- Detection: one trigger adds `cls`, a different trigger removes it — including
  triggers only reachable *inside* the open state (a modal's close button is probed
  after the modal opens).
- Typical genome entry: `{ "type": "pair", "cls": "shown" }`.
- Reconstruction: the opener adds the class, the closer removes it.

## What behavior graphing does NOT cover in this version

- Drags, JS-driven hover effects, keyboard interactions, form input state
- State expressed as inline-style mutation or DOM insertion/removal (class-toggle only)
- Physics / inertia / springs; Canvas / WebGL / shader-driven state

## Verification semantics for behaviors

Every recovered interaction state is replayed on the reconstruction with a **real
click** and pixel-diffed against a ground-truth screenshot of the original page in the
same state (`state-*.png`). Results appear in `convergence.json` under `states[]` with
per-state similarity; the pass threshold is 0.98.

Nodes that are invisible in the initial screenshot because their state machine starts
closed (collapsed panels, inactive tab panels, closed modals) are statused
`hidden-at-capture` in the per-node table — they are verified through state replay
instead of the initial pixel diff. This is expected, not a failure.

## Width/height deltas are intentionally not baked

When a state change alters an element's width/height (e.g. bold text widening an active
tab), that delta is a downstream consequence of the styled properties, not authored
state, so it is excluded from the emitted state rules — baking it would freeze the layout.
