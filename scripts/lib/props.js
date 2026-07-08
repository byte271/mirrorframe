// Shared list of computed-style properties Mirrorframe tracks per node.
// Used by the in-page capture probes AND by the convergence auto-correction
// pass (which re-reads these from the reconstruction), so they must agree.
const PROPS = [
  'display','position','top','right','bottom','left','flexDirection','flexWrap','justifyContent','alignItems','gap','listStyleType',
  'width','height','maxWidth','minHeight','padding','margin','marginBottom','marginLeft',
  'color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
  'borderRadius','boxShadow','opacity','transform','transition','animation','zIndex',
  'textDecorationLine','fontStyle','textAlign','flex','cursor','border',
  // Per-side borders: the 'border' shorthand computes to empty when sides
  // differ (e.g. only border-bottom set), which silently loses 1px of layout.
  'borderTop','borderRight','borderBottom','borderLeft'
];

// Normalize rgb()/rgba() to hex so values compare stably across contexts.
function normColor(c) {
  const m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (!m) return c;
  const [r, g, b, a = 1] = m[1].split(',').map(s => parseFloat(s.trim()));
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
  const hex = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

module.exports = { PROPS, normColor };
