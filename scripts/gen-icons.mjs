/**
 * 站点图标生成器。
 *
 * 一张 16×16 像素矩阵是唯一真实来源，SVG 与两张 PNG 全部由它派生 —— public/ 里的三个图标是生成物，
 * 不要手工编辑，改图案只改下面的 GRID/PALETTE，然后 `npm run icons`。
 *
 * 为什么自己编码 PNG 而不引入依赖：本机只有 sips（不能栅格化 SVG、也不能输出 ICO），装 sharp/pngjs
 * 又要冒 npm 10.8.2 arborist 缺陷的风险，而纯色块位图用 Node 内置 zlib 编码不到一百行。
 *
 * 尺寸都取 16 的整数倍（48 = ×3、192 = ×12），最近邻放大不会产生半像素抖动。
 */

import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SIZE = 16;
export const TRANSPARENT = ".";

/**
 * `.` 透明 · `o` 描边 · `b` 机身 · `s` 握把 · `+` 十字键 · `p` 按键 A · `y` 按键 B
 * 肩键与下伸握把是轮廓的关键：只有圆角矩形的话，16px 下会被认成"窗口"而不是手柄。
 */
export const GRID = [
  "................",
  "................",
  "..oo........oo..",
  ".oooooooooooooo.",
  ".obbbbbbbbbbbbo.",
  ".obb+bbbbppbbbo.",
  ".ob+++bbbppbbbo.",
  ".ob+++bbbbbyybo.",
  ".obb+bbbbbbyybo.",
  ".obbbbbbbbbbbbo.",
  ".oooooooooooooo.",
  ".osss......ssso.",
  ".osss......ssso.",
  ".oooo......oooo.",
  "................",
  "................",
];

/** 取色与 src/styles/base.css 的 CSS 变量对齐（脚本读不到 CSS，改动要同步两边） */
export const PALETTE = {
  o: "#93a4bd", // --text-muted
  b: "#1b2536", // --panel
  s: "#131d2e", // --bg-soft
  "+": "#4ac1ff", // --accent
  p: "#7c5cff", // --accent-2
  y: "#fbbf24", // --warn
};

/** 主屏图标必须实心背景：Apple 不接受 SVG，且透明区会被填成黑 */
export const BACKDROP = "#0b1220"; // --bg

export const OUTPUTS = [
  { file: "favicon.svg", kind: "svg" },
  { file: "favicon.png", kind: "png", scale: 3, backdrop: null },
  { file: "apple-touch-icon.png", kind: "png", scale: 12, backdrop: BACKDROP },
];

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

export function cellKey(row, col) {
  if (row < 0 || row >= GRID.length) throw new Error(`行越界：${row}`);
  const line = GRID[row];
  if (col < 0 || col >= line.length) throw new Error(`列越界：${col}`);
  return line[col];
}

export function colorOf(key) {
  return key === TRANSPARENT ? null : PALETTE[key];
}

/** 同一行内相邻同色格合并成一个矩形：逐像素会产生约 130 个 rect，合并后只剩几十个 */
export function toRects() {
  const rects = [];
  for (let y = 0; y < GRID.length; y++) {
    let run = null;
    for (let x = 0; x < GRID[y].length; x++) {
      const key = GRID[y][x];
      if (key === TRANSPARENT) {
        if (run) rects.push(run);
        run = null;
        continue;
      }
      if (run && run.key === key && run.x + run.width === x) {
        run.width += 1;
        continue;
      }
      if (run) rects.push(run);
      run = { key, x, y, width: 1 };
    }
    if (run) rects.push(run);
  }
  return rects;
}

export function buildSvg() {
  const rects = toRects()
    .map((r) => `  <rect x="${r.x}" y="${r.y}" width="${r.width}" height="1" fill="${PALETTE[r.key]}"/>`)
    .join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" shape-rendering="crispEdges">`,
    "  <title>像素游戏厅</title>",
    rects,
    "</svg>",
    "",
  ].join("\n");
}

/** 每扫描线前置一个 filter 字节（0 = 无预测），这是 PNG 允许的最简写法 */
function buildScanlines({ scale, backdrop }) {
  const width = SIZE * scale;
  const height = SIZE * scale;
  const backdropRgb = backdrop ? hexToRgb(backdrop) : null;
  const lines = [];
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x++) {
      const key = cellKey(Math.floor(y / scale), Math.floor(x / scale));
      const color = colorOf(key) ?? backdrop;
      if (!color) continue; // 保持全 0（透明黑）
      const rgb = key === TRANSPARENT ? backdropRgb : hexToRgb(color);
      const offset = 1 + x * 4;
      line[offset] = rgb[0];
      line[offset + 1] = rgb[1];
      line[offset + 2] = rgb[2];
      line[offset + 3] = 255;
    }
    lines.push(line);
  }
  return { width, height, data: Buffer.concat(lines) };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/** 8-bit RGBA、非隔行、单块 IDAT —— 只够我们自己的图标，不是通用编码器 */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(data, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function buildPng({ scale, backdrop = null }) {
  return encodePng(buildScanlines({ scale, backdrop }));
}

export function buildOutput({ kind, scale, backdrop }) {
  return kind === "svg" ? buildSvg() : buildPng({ scale, backdrop });
}

async function main() {
  const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
  for (const output of OUTPUTS) {
    const body = buildOutput(output);
    await writeFile(resolve(publicDir, output.file), body);
    const size = Buffer.byteLength(body);
    console.log(`已生成 ${output.file}（${size} 字节）`);
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
