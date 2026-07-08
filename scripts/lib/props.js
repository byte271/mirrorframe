// Shared list of computed-style properties Mirrorframe tracks per node.
// Used by the in-page capture probes AND by the convergence auto-correction
// pass (which re-reads these from the reconstruction), so they must agree.
const PROPS = [
  'display','position','top','right','bottom','left','flexDirection','flexWrap','justifyContent','alignItems','gap','listStyleType',
  // Per-side margins: the 'margin' shorthand computes to empty when sides
  // differ (e.g. a -800px marginTop hero overlap), silently losing layout.
  'width','height','maxWidth','minHeight','padding','margin','marginTop','marginRight','marginBottom','marginLeft',
  'color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
  'borderRadius','boxShadow','opacity','transform','transition','animation','zIndex',
  'textDecorationLine','fontStyle','textAlign','flex','cursor','border',
  // Per-side borders: the 'border' shorthand computes to empty when sides
  // differ (e.g. only border-bottom set), which silently loses 1px of layout.
  'borderTop','borderRight','borderBottom','borderLeft',
  // v0.2: visual-identity props — background imagery, media fitting, text
  // casing/wrapping, clipping. All compare stably as computed values.
  'backgroundImage','backgroundSize','backgroundPosition','backgroundRepeat',
  'objectFit','objectPosition','textTransform','whiteSpace','overflow',
  'mixBlendMode','filter','clipPath','pointerEvents','textOverflow','verticalAlign',
  // v0.2: CSS grid + multi-column layout — pages built on grid collapse to
  // stacked blocks without these; all compare stably as computed values.
  'gridTemplateColumns','gridTemplateRows','gridAutoFlow','gridColumn','gridRow',
  'rowGap','columnGap','justifySelf','alignSelf','alignContent','justifyItems',
  'aspectRatio','float','order'
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
