#!/usr/bin/env node
/**
 * decorate-snake.mjs — inject a Pac-Man and a ghost into a Platane/snk SVG.
 *
 * snk renders the snake as per-segment rects driven by CSS keyframes that
 * translate along the route, one "step" (one cell) apart in time. Cloning the
 * head's keyframes shifted by N steps (N = segment count) therefore yields a
 * character that trails the tail by one cell, perfectly in sync with the loop.
 * The ghost is the same trick applied again, two steps behind Pac-Man:
 * ghost -> pacman -> snake, one endless chase.
 *
 * Usage: node decorate-snake.mjs file.svg [more.svg ...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const PAC_COLOR = "#ffd23f";
const GHOST_COLOR = "#ff2e88";
const INK = "#12161c";
const FALLBACK_STEP_PCT = 0.68; // one cell-step, as % of the loop

// Pac-Man as a pie facing +x; deg = half mouth angle (10 = closed, 50 = open)
const pacPath = (deg) => {
  const r = 7.2,
    a = (deg * Math.PI) / 180;
  const x = +(r * Math.cos(a)).toFixed(2),
    y = +(r * Math.sin(a)).toFixed(2);
  return `M0,0 L${x},${-y} A${r},${r} 0 1 0 ${x},${y} Z`;
};

const ghostPath =
  "M-7.2,0 A7.2,7.2 0 0 1 7.2,0 L7.2,6.2 L4.8,3.8 L2.4,6.2 L0,3.8 L-2.4,6.2 L-4.8,3.8 L-7.2,6.2 Z";

const lerp = (a, b, t) => a + (b - a) * t;

// keyframes of one snake segment: [{pct, x, y}, ...] sorted by pct
function parseSegment(style, name) {
  const m = style.match(
    new RegExp(`@keyframes ${name}\\{([\\s\\S]*)\\}\\.s\\.${name}\\{`),
  );
  if (!m) return null;
  const entries = [];
  const re = /((?:[\d.]+%,)*[\d.]+)%\{transform:translate\((-?[\d.]+)px,(-?[\d.]+)px\)\}/g;
  for (const g of m[1].matchAll(re))
    // g[1] is like "0%,99.32" — parseFloat drops the trailing % on each piece
    for (const p of g[1].split(",")) entries.push({ pct: parseFloat(p), x: +g[2], y: +g[3] });
  entries.sort((a, b) => a.pct - b.pct);
  return entries.length && entries[0].pct === 0 ? entries : null;
}

// cyclic piecewise-linear interpolation of the head position at pct (0-100)
function headAt(entries, pct) {
  const p = ((pct % 100) + 100) % 100;
  const last = entries[entries.length - 1];
  const wrap = (a, b, bp) => {
    const t = (p - a.pct) / (bp - a.pct);
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  };
  if (p >= last.pct) return wrap(last, entries[0], 100);
  for (let i = 0; i < entries.length - 1; i++) {
    const a = entries[i],
      b = entries[i + 1];
    if (p >= a.pct && p <= b.pct) return wrap(a, b, b.pct);
  }
  return entries[0];
}

// the follower's keyframes = head's keyframes, every pct shifted by delta
function shiftKeyframes(entries, delta) {
  const map = new Map();
  for (const e of entries) map.set(+((e.pct + delta) % 100).toFixed(3), e);
  map.set(0, headAt(entries, 100 - delta));
  map.set(100, headAt(entries, 100 - delta));
  return [...map.entries()]
    .map(([pct, v]) => ({ pct, x: v.x, y: v.y }))
    .sort((a, b) => a.pct - b.pct);
}

const cssKeyframes = (name, frames) =>
  `@keyframes ${name}{${frames
    .map((f) => `${f.pct}%{transform:translate(${(f.x + 8).toFixed(2)}px,${(f.y + 8).toFixed(2)}px)}`)
    .join("")}}`;
// (+8px puts the character's local origin on the cell center)

function decorate(file) {
  let svg = readFileSync(file, "utf8");
  if (svg.includes("pacmove")) {
    console.log(`${file}: already decorated, skipped`);
    return;
  }
  const dur = (svg.match(/animation:none (\d+)ms/) || [])[1];
  if (!dur) throw new Error(`${file}: loop duration not found`);
  const styleStart = svg.indexOf("<style>") + 7;
  const styleEnd = svg.indexOf("</style>");
  const style = svg.slice(styleStart, styleEnd);

  const head = parseSegment(style, "s0");
  if (!head) throw new Error(`${file}: snake head keyframes not found`);
  const names = [...style.matchAll(/@keyframes s(\d+)\{/g)].map((m) => +m[1]);
  const segCount = names.length ? Math.max(...names) + 1 : 1;

  // snk moves one cell per 100ms; as % of the loop that is 10000/dur
  const step = 10000 / dur || FALLBACK_STEP_PCT;

  const pac = shiftKeyframes(head, segCount * step);
  const ghost = shiftKeyframes(head, (segCount + 3) * step);

  const css =
    `.pac{animation:pacmove ${dur}ms linear infinite}` +
    `.gho{animation:ghomove ${dur}ms linear infinite}` +
    cssKeyframes("pacmove", pac) +
    cssKeyframes("ghomove", ghost);

  const closed = pacPath(10),
    open = pacPath(50);
  const actors =
    `<g class="pac"><path d="${closed}" fill="${PAC_COLOR}">` +
    `<animate attributeName="d" dur="280ms" repeatCount="indefinite" values="${closed};${open};${closed}"/>` +
    `</path><circle cx="-2" cy="-3.6" r="1.4" fill="${INK}"/></g>` +
    `<g class="gho"><path d="${ghostPath}" fill="${GHOST_COLOR}"/>` +
    `<circle cx="-2.6" cy="-1.8" r="2.1" fill="#fff"/><circle cx="2.6" cy="-1.8" r="2.1" fill="#fff"/>` +
    `<circle cx="-1.7" cy="-1.4" r="1.1" fill="${INK}"/><circle cx="3.5" cy="-1.4" r="1.1" fill="${INK}"/></g>`;

  svg = svg.slice(0, styleEnd) + css + svg.slice(styleEnd);
  svg = svg.replace("</svg>", actors + "</svg>");

  writeFileSync(file, svg);
  console.log(
    `${file}: +pacman(${segCount} steps behind head), +ghost(+3 more), loop=${dur}ms, step=${step}%`,
  );
}

for (const file of process.argv.slice(2)) decorate(file);
