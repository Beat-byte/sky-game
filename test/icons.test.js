import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import {
  BACKDROP,
  GRID,
  PALETTE,
  SIZE,
  TRANSPARENT,
  buildPng,
  buildSvg,
  toRects,
} from "../scripts/gen-icons.mjs";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 只解我们自己写得出的那种 PNG（8-bit RGBA、非隔行、filter 0），够用来做双向校验 */
function decodePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [...PNG_SIGNATURE], "PNG 签名必须逐字节正确，否则 sips 与浏览器都不认");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "位深固定 8");
      assert.equal(data[9], 6, "色彩类型固定 RGBA");
      assert.equal(data[12], 0, "不允许隔行");
    }
    if (type === "IDAT") idat.push(Buffer.from(data));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (width * 4 + 1) * height, "每扫描线前置一个 filter 字节");
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + 1 + x * 4;
      assert.equal(raw[y * stride], 0, "filter 字节必须是 0");
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

function rgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

function expectedPixel(x, y, { scale, backdrop }) {
  const key = GRID[Math.floor(y / scale)][Math.floor(x / scale)];
  if (key !== TRANSPARENT) return [...rgb(PALETTE[key]), 255];
  return backdrop ? [...rgb(backdrop), 255] : [0, 0, 0, 0];
}

function assertPixelsMatch(image, options) {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      assert.deepEqual(image.pixel(x, y), expectedPixel(x, y, options), `像素 (${x},${y}) 与矩阵不符`);
    }
  }
}

test("像素矩阵是 16×16、字符全在调色板内，且手柄各部件落位", () => {
  assert.equal(GRID.length, SIZE);
  const legal = new Set([...Object.keys(PALETTE), TRANSPARENT]);
  for (const [index, row] of GRID.entries()) {
    assert.equal(row.length, SIZE, `第 ${index} 行必须 16 个字符`);
    for (const char of row) assert.ok(legal.has(char), `第 ${index} 行出现未登记字符 ${char}`);
  }
  assert.deepEqual(GRID.map((row) => row[0]), Array(SIZE).fill(TRANSPARENT), "左边缘留白，圆角遮罩不切边");
  assert.deepEqual(GRID.map((row) => row[SIZE - 1]), Array(SIZE).fill(TRANSPARENT), "右边缘留白");
  for (const blank of [0, 1, 14, 15]) {
    assert.equal(GRID[blank], TRANSPARENT.repeat(SIZE), `第 ${blank} 行应整行留白`);
  }
  assert.equal(GRID[3], `.${"o".repeat(14)}.`, "机身上边框");
  assert.equal(GRID[10], `.${"o".repeat(14)}.`, "机身下边框");
  assert.equal(GRID[2][2] + GRID[2][3], "oo", "左肩键");
  assert.equal(GRID[2][12] + GRID[2][13], "oo", "右肩键");
  for (let y = 5; y <= 8; y++) assert.equal(GRID[y][4], "+", "十字键竖杆");
  assert.equal(GRID[6].slice(3, 6), "+++", "十字键横杆");
  assert.equal(GRID[5].slice(9, 11), "pp", "按键 A");
  assert.equal(GRID[7].slice(11, 13), "yy", "按键 B");
  assert.equal(GRID[11].slice(2, 5), "sss", "左握把");
  assert.equal(GRID[11].slice(11, 14), "sss", "右握把");
  const colored = GRID.join("").split("").filter((char) => char !== TRANSPARENT).length;
  assert.equal(colored, 140, "有色格总数变了说明图案被改动，需同步产物");
});

test("SVG 按行游程合并：矩形互不重叠且正好盖住所有有色格", () => {
  const rects = toRects();
  const covered = new Map();
  for (const rect of rects) {
    assert.ok(rect.width >= 1 && rect.width <= SIZE, `游程宽度越界：${rect.width}`);
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const spot = `${x},${rect.y}`;
      assert.ok(!covered.has(spot), `矩形在 ${spot} 重叠`);
      assert.equal(GRID[rect.y][x], rect.key, `矩形在 ${spot} 颜色与矩阵不符`);
      covered.set(spot, rect.key);
    }
  }
  const colored = GRID.join("").split("").filter((char) => char !== TRANSPARENT).length;
  assert.equal(covered.size, colored, "漏格或画到透明格上了");
  assert.ok(rects.length < colored, "游程合并必须真的省掉矩形数量");
});

test("PNG 编码结构合法：签名、IHDR 尺寸、IDAT 解压长度都对得上", () => {
  const buffer = buildPng({ scale: 3, backdrop: null });
  const image = decodePng(buffer);
  assert.equal(image.width, SIZE * 3);
  assert.equal(image.height, SIZE * 3);
  assertPixelsMatch(image, { scale: 3, backdrop: null });
  assert.equal(image.pixel(0, 0)[3], 0, "浏览器图标版的留白必须透明");
});

test("主屏图标 192×192、背景实心：iOS 会把透明区填成黑", () => {
  const buffer = buildPng({ scale: 12, backdrop: BACKDROP });
  const image = decodePng(buffer);
  assert.deepEqual([image.width, image.height], [192, 192]);
  assert.deepEqual(image.pixel(0, 0), [...rgb(BACKDROP), 255], "左上角应是实心的站点深色底");
  let minAlpha = 255;
  for (let y = 0; y < image.height; y += 3) {
    for (let x = 0; x < image.width; x += 3) minAlpha = Math.min(minAlpha, image.pixel(x, y)[3]);
  }
  assert.equal(minAlpha, 255, "主屏图标任何一格都不允许带透明度");
});

test("public 里已提交的三个产物与矩阵当前状态一致", () => {
  assert.equal(readFileSync(resolve(PUBLIC_DIR, "favicon.svg"), "utf8"), buildSvg());
  const outputs = [
    { file: "favicon.png", scale: 3, backdrop: null },
    { file: "apple-touch-icon.png", scale: 12, backdrop: BACKDROP },
  ];
  for (const output of outputs) {
    const committed = decodePng(readFileSync(resolve(PUBLIC_DIR, output.file)));
    assertPixelsMatch(committed, output);
    assert.equal(committed.width, SIZE * output.scale, `${output.file} 尺寸不是矩阵的整数倍`);
  }
});

test("SVG 保持像素硬边且不引任何外部资源", () => {
  const svg = buildSvg();
  assert.match(svg, /shape-rendering="crispEdges"/, "抗锯齿会把 1px 描边糊掉");
  assert.match(svg, /viewBox="0 0 16 16"/);
  for (const forbidden of ["<image", "xlink:href", "url(", "http://"]) {
    if (forbidden === "http://") {
      assert.equal(svg.split(forbidden).length - 1, 1, "只允许 xmlns 那一个 w3.org 声明");
      continue;
    }
    assert.ok(!svg.includes(forbidden), `SVG 里不该出现 ${forbidden}`);
  }
});
