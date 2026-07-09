import React from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;

const BEHAVIORS = [];
const TRACKS = [];
const MAX_SCROLL = 1572;
const HOVER_CLASS = [];
const POINTER_FIELDS = [];
const REVEAL_STAGGER = {"ids":{"n5":0,"n7":266,"n10":266,"n13":266,"n16":0,"n19":0,"n22":0,"n26":0,"n28":261,"n31":511,"n34":691,"n37":0},"step":261};
const FRAME_TRACKS = [];

function App() {
  return (
      h("body", { "data-mf-id": "n0" },
" ",
        h("div", { className: "hero", "data-mf-id": "n1" },
" ",
          h("h1", { "data-mf-id": "n2" },
            `Things arrive one by one, not all at once.`
          ),
" ",
          h("p", { "data-mf-id": "n3" },
            `Scroll down. Every card fades in on its own clock, with its own curve.`
          )
        ),
" ",
        h("section", { "data-mf-id": "n4" },
" ",
          h("h2", { className: "fade-item", "data-mf-id": "n5" },
            `Six tiles, CSS-delay staggered`
          ),
" ",
          h("div", { className: "grid", "data-mf-id": "n6" },
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n7" },
              h("h3", { "data-mf-id": "n8" },
                `Alpha`
              ),
              h("p", { "data-mf-id": "n9" },
                `First to land, no delay at all.`
              )
            ),
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n10" },
              h("h3", { "data-mf-id": "n11" },
                `Beta`
              ),
              h("p", { "data-mf-id": "n12" },
                `150 milliseconds behind the leader.`
              )
            ),
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n13" },
              h("h3", { "data-mf-id": "n14" },
                `Gamma`
              ),
              h("p", { "data-mf-id": "n15" },
                `Third in the queue at 300ms.`
              )
            ),
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n16" },
              h("h3", { "data-mf-id": "n17" },
                `Delta`
              ),
              h("p", { "data-mf-id": "n18" },
                `Fourth, easing in at 450ms.`
              )
            ),
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n19" },
              h("h3", { "data-mf-id": "n20" },
                `Epsilon`
              ),
              h("p", { "data-mf-id": "n21" },
                `Fifth wave, 600ms after the first.`
              )
            ),
" ",
            h("div", { className: "tile fade-item", "data-mf-id": "n22" },
              h("h3", { "data-mf-id": "n23" },
                `Zeta`
              ),
              h("p", { "data-mf-id": "n24" },
                `Last one through the door at 750ms.`
              )
            )
          )
        ),
" ",
        h("section", { "data-mf-id": "n25" },
" ",
          h("h2", { className: "fade-item", "data-mf-id": "n26" },
            `Four rows, JS-timer staggered`
          ),
" ",
          h("div", { className: "row-list", "data-mf-id": "n27" },
" ",
            h("div", { className: "row fade-item js-seq", "data-mf-id": "n28" },
              h("strong", { "data-mf-id": "n29" },
                `Step one.`
              ),
" ",
              h("span", { "data-mf-id": "n30" },
                `Released immediately on intersection.`
              )
            ),
" ",
            h("div", { className: "row fade-item js-seq", "data-mf-id": "n31" },
              h("strong", { "data-mf-id": "n32" },
                `Step two.`
              ),
" ",
              h("span", { "data-mf-id": "n33" },
                `A 180ms beat later.`
              )
            ),
" ",
            h("div", { className: "row fade-item js-seq", "data-mf-id": "n34" },
              h("strong", { "data-mf-id": "n35" },
                `Step three.`
              ),
" ",
              h("span", { "data-mf-id": "n36" },
                `Another 180ms after that.`
              )
            ),
" ",
            h("div", { className: "row fade-item js-seq", "data-mf-id": "n37" },
              h("strong", { "data-mf-id": "n38" },
                `Step four.`
              ),
" ",
              h("span", { "data-mf-id": "n39" },
                `The tail of the sequence.`
              )
            )
          )
        ),
" ",
        h("footer", { "data-mf-id": "n40" },
          `Stress fixture: sequential scroll-reveal stagger (CSS delays + JS timers).`
        )
      )
  );
}

createRoot(document.getElementById('root')).render(h(App));
