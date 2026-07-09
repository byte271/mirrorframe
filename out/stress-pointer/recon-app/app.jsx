import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;

const BEHAVIORS = [];
const TRACKS = [];
const MAX_SCROLL = 0;
const HOVER_CLASS = [];
const POINTER_FIELDS = [{"id":"n2","kind":"matrix","comps":[{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":-0.0234375,"b":0,"c":15},{"a":0,"b":-0.0375,"c":15},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1}],"tauMs":0},{"id":"n3","kind":"matrix","comps":[{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0.04296875,"b":0,"c":-27.5},{"a":0,"b":0.06875,"c":-27.5},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1}],"tauMs":0},{"id":"n4","kind":"matrix","comps":[{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0.0703125,"b":0,"c":-45},{"a":0,"b":0.1125,"c":-45},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1}],"tauMs":0},{"id":"n5","kind":"matrix3d","comps":[{"a":0,"b":0,"c":0.999328},{"a":0,"b":0,"c":-0.00134276},{"a":-0.00008175736607142857,"b":0,"c":0.05232471428571428},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0.999328},{"a":0,"b":-0.0001308703571428572,"c":0.05234814285714287},{"a":0,"b":0,"c":0},{"a":0.0000817939732142857,"b":0,"c":-0.05234814285714285},{"a":0,"b":0.00013081178571428575,"c":-0.0523247142857143},{"a":0,"b":0,"c":0.998657},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1}],"tauMs":0},{"id":"n8","kind":"matrix","comps":[{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1},{"a":0,"b":0,"c":0},{"a":0.053567596726190485,"b":0.00029236904761905367,"c":-34.45478574603175},{"a":0.00018219229910711683,"b":0.08709279761904766,"c":-35.00887705238095},{"a":0,"b":0,"c":0},{"a":0,"b":0,"c":1}],"tauMs":211}];
const REVEAL_STAGGER = {"ids":{},"step":0};
const FRAME_TRACKS = [];

function App() {
  React.useEffect(() => {
    const nodes = POINTER_FIELDS.map(f => ({
      f, el: document.querySelector('[data-mf-id="' + f.id + '"]'),
      cur: null, target: f.comps.map(c => c.c),
    })).filter(n => n.el);
    let mx = null, my = null, raf = null, last = 0;
    const fmt = (n) => n.f.kind === 'matrix3d'
      ? 'matrix3d(' + n.cur.join(',') + ')'
      : 'matrix(' + [n.cur[0], n.cur[1], n.cur[4], n.cur[5], n.cur[12], n.cur[13]].join(',') + ')';
    const tick = (t) => {
      raf = null;
      const dt = last ? Math.min(100, t - last) : 16;
      last = t;
      let busy = false;
      for (const n of nodes) {
        n.target = n.f.comps.map(c => c.a * mx + c.b * my + c.c);
        if (!n.cur) n.cur = n.target.slice();
        const k = n.f.tauMs > 0 ? 1 - Math.exp(-dt / n.f.tauMs) : 1;
        let moving = false;
        n.cur = n.cur.map((v, i) => {
          const nv = v + (n.target[i] - v) * k;
          if (Math.abs(n.target[i] - nv) > 1e-4) moving = true;
          return nv;
        });
        if (moving) busy = true; else n.cur = n.target.slice();
        n.el.style.transform = fmt(n);
      }
      if (busy) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const onMove = (e) => {
      mx = e.clientX; my = e.clientY;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => { window.removeEventListener('mousemove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return (
      h("body", { "data-mf-id": "n0" },
" ",
        h("div", { className: "stage", "data-mf-id": "n1" },
" ",
          h("div", { className: "layer layer-back", "data-mf-id": "n2" }),
" ",
          h("div", { className: "layer layer-mid", "data-mf-id": "n3" }),
" ",
          h("div", { className: "layer layer-front", "data-mf-id": "n4" }),
" ",
          h("div", { className: "tilt-card", "data-mf-id": "n5" },
" ",
            h("h2", { "data-mf-id": "n6" },
              `Tilt toward the cursor`
            ),
" ",
            h("p", { "data-mf-id": "n7" },
              `This card rotates in 3D as the pointer crosses the viewport — a
         recovered matrix3d choreography, not a hover state.`
            )
          ),
" ",
          h("div", { className: "glide-chip", "data-mf-id": "n8" },
" ",
            h("strong", { "data-mf-id": "n9" },
              `Smooth follower`
            ),
" ",
            h("span", { "data-mf-id": "n10" },
              `Chases the pointer with a lerp — the lag is the feature.`
            )
          )
        )
      )
  );
}

createRoot(document.getElementById('root')).render(h(App));
