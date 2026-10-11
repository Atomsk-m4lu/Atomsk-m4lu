#!/usr/bin/env node
/**
 * decorate-snake.mjs v2 — 双主角对开：蛇正向、吃豆人反向，互相抢贡献格。
 *
 * snk 的 SVG 里每个贡献格自带"蛇到达时的绿色闪烁"（@keyframes cN）。
 * 本脚本：①把吃豆人放到同一条 polyline 的反向巡线上（独立行动，无幽灵）；
 *        ②给巡线上每个格子注入黄色闪烁（在吃豆人到达时刻，负延迟移相）——
 *          贡献格会被绿闪和黄闪先后各抢一次；③顶部加 SNAKE : PAC 计分板。
 *
 * Usage: node decorate-snake.mjs file.svg [more.svg ...]
 */
import { readFileSync, writeFileSync } from "node:fs";

const PAC_COLOR = "#ffd23f";
const INK = "#12161c";
const SNAKE_GREEN = "#40c463";
const FALLBACK_STEP_PCT = 0.68;
const FLASH_CENTER = 40.05; // pf 闪烁窗口中心（% of loop），配合负延迟移相

// Pac-Man as a pie facing +x; deg = half mouth angle (10 = closed, 50 = open)
const pacPath = (deg) => {
  const r = 7.2,
    a = (deg * Math.PI) / 180;
  const x = +(r * Math.cos(a)).toFixed(2),
    y = +(r * Math.sin(a)).toFixed(2);
  return `M0,0 L${x},${-y} A${r},${r} 0 1 0 ${x},${y} Z`;
};

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

const cssKeyframes = (name, frames) =>
  `@keyframes ${name}{${frames
    .map((f) => `${f.pct}%{transform:translate(${(f.x + 8).toFixed(2)}px,${(f.y + 8).toFixed(2)}px)}`)
    .join("")}}`;

// 反向巡线：位置(q) = 原头位置(100 - q)；闭环两端同点
function buildReverse(entries) {
  const map = new Map();
  for (const e of entries) map.set(+((100 - e.pct) % 100).toFixed(3), e);
  const p0 = entries[0];
  map.set(0, { pct: 0, x: p0.x, y: p0.y });
  map.set(100, { pct: 100, x: p0.x, y: p0.y });
  return [...map.entries()]
    .map(([pct, v]) => ({ pct, x: v.x, y: v.y }))
    .sort((a, b) => a.pct - b.pct);
}

function undecorate(svg) {
  // v2 注入物
  svg = svg.replace(/<g class="sb">[\s\S]*?<\/g>/g, "");
  svg = svg.replace(/ style="animation-name:[^"]*"/g, "");
  svg = svg.replace(/ ?pf(?=")/g, "");
  svg = svg.replace(/\.pf\{[^}]*\}@keyframes pf\{[^@]*\}/, "");
  svg = svg.replace(/@keyframes pf\{[^@]*\}/, "");
  // v1 注入物（pac + gho）
  svg = svg.replace(/<g class="pac">[\s\S]*?<\/g>/, "");
  svg = svg.replace(/<g class="gho">[\s\S]*?<\/g>/, "");
  svg = svg.replace(/\.pac\{animation:pacmove[^@]*?@keyframes ghomove\{[^@]*?\}\}/, "");
  svg = svg.replace(/\.pac\{animation:pacmove[^@]*?@keyframes pacmove\{[^@]*?\}\}/, "");
  return svg;
}

function decorate(file) {
  let svg = readFileSync(file, "utf8");
  const hadDecor = svg.includes("pacmove") || svg.includes("class=\"sb\"");
  if (hadDecor) svg = undecorate(svg);

  const dur = (svg.match(/animation:none (\d+)ms/) || [])[1];
  if (!dur) throw new Error(`${file}: loop duration not found`);
  const styleStart = svg.indexOf("<style>") + 7;
  const styleEnd = svg.indexOf("</style>");
  const style = svg.slice(styleStart, styleEnd);

  const head = parseSegment(style, "s0");
  if (!head) throw new Error(`${file}: snake head keyframes not found`);

  // ---- 吃豆人：反向巡线 ----
  const rev = buildReverse(head);
  const css =
    `.pac{animation:pacmove ${dur}ms linear infinite}` +
    `.pf{animation-duration:${dur}ms;animation-timing-function:linear;` +
    `animation-iteration-count:infinite;animation-delay:var(--pfd,0ms)}` +
    cssKeyframes("pacmove", rev) +
    `@keyframes pf{${(FLASH_CENTER - 0.15).toFixed(2)}%{fill:${PAC_COLOR}}` +
    `${(FLASH_CENTER + 0.15).toFixed(2)}%{fill:var(--ce)}}`;

  const closed = pacPath(10),
    open = pacPath(50);
  const actors =
    `<g class="pac"><path d="${closed}" fill="${PAC_COLOR}">` +
    `<animate attributeName="d" dur="280ms" repeatCount="indefinite" values="${closed};${open};${closed}"/>` +
    `</path><circle cx="-2" cy="-3.6" r="1.4" fill="${INK}"/></g>`;

  // ---- 格子：算巡线归属 + 注入黄闪 ----
  const SAMPLES = 3000;
  const samples = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const pct = (100 * i) / SAMPLES;
    const pos = headAt(head, pct);
    samples.push({ pct, x: pos.x + 8, y: pos.y + 8 }); // +8 = 格子中心
  }

  const cellRe = /<rect class="(c(?: (c\d+))?)" x="(-?[\d.]+)" y="(-?[\d.]+)"/g;
  let routeCells = 0,
    contribCells = 0,
    maxDist = 0,
    skipped = 0;
  svg = svg.replace(cellRe, (m, cls, cn, x, y) => {
    const cx = +x + 6,
      cy = +y + 6; // 12px 格子中心
    let best = 1e9,
      bestPct = 0;
    for (const s of samples) {
      const d = (s.x - cx) ** 2 + (s.y - cy) ** 2;
      if (d < best) {
        best = d;
        bestPct = s.pct;
      }
    }
    const dist = Math.sqrt(best);
    if (dist > 8) {
      skipped++;
      return m; // 不在巡线上，不注入
    }
    if (dist > maxDist) maxDist = dist;
    routeCells++;
    const pacArr = (100 - bestPct) % 100; // 吃豆人（反向）到达时刻
    const delay = -(((pacArr - FLASH_CENTER + 100) % 100) / 100) * dur;
    if (cn) {
      contribCells++;
      // 贡献格：绿闪(cN, 蛇) + 黄闪(pf, 吃豆人) 先后易手
      return `<rect class="${cls} pf" style="animation-name:${cn},pf;--pfd:${delay.toFixed(0)}ms" x="${x}" y="${y}"`;
    }
    // 空格：只有吃豆人的黄闪
    return `<rect class="${cls} pf" style="animation-name:pf;--pfd:${delay.toFixed(0)}ms" x="${x}" y="${y}"`;
  });

  // ---- 计分板：真实数据统计 ----
  const sb =
    `<g class="sb" font-family="Consolas,monospace" font-size="13">` +
    `<text x="-12" y="-8" fill="${SNAKE_GREEN}">SNAKE ${contribCells}</text>` +
    `<text x="864" y="-8" fill="${PAC_COLOR}" text-anchor="end">PAC ${routeCells}</text>` +
    `</g>`;

  svg = svg.slice(0, styleEnd) + css + svg.slice(styleEnd);
  svg = svg.replace("</svg>", actors + sb + "</svg>");
  writeFileSync(file, svg);
  console.log(
    `${file}: pacman(reversed,独立) + ${routeCells} 格黄闪(${contribCells} 格与蛇互抢) + 计分板, ` +
      `loop=${dur}ms, maxCellDist=${maxDist.toFixed(2)}px`,
  );
}

for (const file of process.argv.slice(2)) decorate(file);
