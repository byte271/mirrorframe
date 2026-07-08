// Fixed skip-reason taxonomy. Every skipped node, probe, or page carries
// exactly one of these — free-text excuses are not allowed anywhere in the
// pipeline. Adding a reason here is an API change (documented in
// references/limitations.md).
const REASONS = {
  UNCLASSIFIED_BEHAVIOR: 'unclassified-behavior', // class mutations not attributable to reveal/toggle/exclusive/pair
  OUT_OF_SCOPE_MEDIUM: 'out-of-scope-medium',     // canvas/webgl/video/audio/svg/img/object/embed
  CROSS_ORIGIN_CONTENT: 'cross-origin-content',   // iframe or stylesheet whose content is origin-isolated
  NETWORK_TIMEOUT: 'network-timeout',             // navigation/asset settling exceeded its bound
  UNPARSEABLE_MARKUP: 'unparseable-markup',       // page structure could not be extracted
  UNSUPPORTED_ELEMENT: 'unsupported-element',     // element tag outside the capture set (form/table/input/...)
  TIME_BUDGET_EXCEEDED: 'time-budget-exceeded',   // a bounded phase (probe/pipeline) hit its deadline
  SCALE_CAP_EXCEEDED: 'scale-cap-exceeded',       // node or candidate count beyond the configured cap
};

// A page-level "detected, out of scope / cannot proceed" outcome. Not a crash:
// the run still exits cleanly with a summary carrying this reason.
class MfSkip extends Error {
  constructor(reason, detail) {
    super(`${reason}${detail ? ': ' + detail : ''}`);
    this.mfReason = reason;
  }
}

module.exports = { REASONS, MfSkip };
