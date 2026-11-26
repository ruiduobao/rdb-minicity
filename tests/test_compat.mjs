// MiniCity Web 第 4 轮（兼容）测试：
// - 预设 18 城与主题 8 套的完整性（M-U1 提前落地）
// - 本土层高规则按建筑类型分档
// - 不同 OSM 数据密度/形态区域的解析兼容（空、稀疏、水系-only、残缺引用）
// - 浏览器内核与移动端口径的静态核查（importmap 内核要求、viewport、
//   移动端媒体查询、无过新 API 依赖、未知主题回落）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOverpass, parseHeightTag, floorHeightFor } from "../js/osm.js";
import { THEMES, getTheme } from "../js/themes.js";
import { decodeShare } from "../js/share.js";

const appSrc = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/style.css", import.meta.url), "utf8");

function presetsFromSource() {
  const block = appSrc.match(/const PRESETS = \[([\s\S]*?)\];/)[1];
  return [...block.matchAll(/\{ name: "([^"]+)", lon: ([\d.]+), lat: ([\d.]+) \}/g)]
    .map(m => ({ name: m[1], lon: +m[2], lat: +m[3] }));
}

test("兼容：预设扩至 18 城，名称唯一、坐标在中国陆地范围内", () => {
  const presets = presetsFromSource();
  assert.equal(presets.length, 18);
  assert.equal(new Set(presets.map(p => p.name)).size, 18);
  for (const p of presets) {
    assert.ok(p.lon >= 73 && p.lon <= 135, `${p.name} 经度异常 ${p.lon}`);
    assert.ok(p.lat >= 18 && p.lat <= 54, `${p.name} 纬度异常 ${p.lat}`);
  }
  for (const name of ["南京 · 夫子庙", "拉萨 · 布达拉宫广场", "乌鲁木齐 · 大巴扎"])
    assert.ok(presets.some(p => p.name === name), "缺预设 " + name);
});

test("兼容：主题扩至 8 套，含水墨与夜市烟火，字段完整", () => {
  assert.equal(THEMES.length, 8);
  for (const id of ["shuimo", "yanhuo"]) {
    const t = getTheme(id);
    assert.equal(t.id, id);
    assert.ok(t.buildings.length >= 3);
  }
  assert.equal(getTheme("yanhuo").night, true);
  assert.equal(getTheme("shuimo").night, false);
});

test("兼容：分享链接带未知主题时回落默认主题而非崩溃", () => {
  const payload = { v: 1, lon: 104.08, lat: 30.65, s: 400, t: "no-such-theme" };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = decodeShare("#m=" + b64);
  assert.ok(decoded);
  assert.equal(getTheme(decoded.theme).id, "modern"); // getTheme 兜底 THEMES[2]
});

test("兼容：本土层高按建筑类型分档", () => {
  assert.equal(floorHeightFor({ building: "apartments" }), 3.0);
  assert.equal(floorHeightFor({ building: "residential" }), 3.0);
  assert.equal(floorHeightFor({ building: "office" }), 3.6);
  assert.equal(floorHeightFor({ building: "hotel" }), 3.6);
  assert.equal(floorHeightFor({ building: "industrial" }), 5.0);
  assert.equal(floorHeightFor({ building: "warehouse" }), 5.0);
  assert.equal(floorHeightFor({ building: "yes" }), 3.2);
  assert.equal(floorHeightFor({}), 3.2);
  assert.equal(parseHeightTag({ building: "apartments", "building:levels": "10" }, 1), 30);
  assert.equal(parseHeightTag({ building: "office", "building:levels": "10" }, 1), 36);
  assert.equal(parseHeightTag({ building: "industrial", "building:levels": "4" }, 1), 20);
  // 显式 height 标签仍优先于层高规则
  assert.equal(parseHeightTag({ building: "office", height: "50", "building:levels": "10" }, 1), 50);
});

const N = (id, lon, lat) => ({ type: "node", id, lon, lat });
const square = (base, lon0, lat0) => [N(base + 1, lon0, lat0), N(base + 2, lon0 + 0.001, lat0),
  N(base + 3, lon0 + 0.001, lat0 + 0.001), N(base + 4, lon0, lat0 + 0.001)];
const ring = base => [base + 1, base + 2, base + 3, base + 4, base + 1];

test("兼容：空数据与稀疏数据区域解析不崩", () => {
  const empty = parseOverpass({ elements: [] });
  assert.deepEqual(empty.stats, { buildings: 0, roads: 0, waters: 0, greens: 0 });
  const noKey = parseOverpass({});
  assert.equal(noKey.stats.buildings, 0);
  const sparse = parseOverpass({ elements: [
    ...square(10, 100, 30),
    { type: "way", id: 9, nodes: ring(10), tags: { building: "house" } },
  ] });
  assert.equal(sparse.stats.buildings, 1);
  assert.equal(sparse.buildings[0].heightSource, "估算");
});

test("兼容：水系/绿地-only 区域与残缺引用不崩", () => {
  const waterOnly = parseOverpass({ elements: [
    ...square(10, 100, 30),
    { type: "way", id: 9, nodes: ring(10), tags: { natural: "water" } },
    { type: "way", id: 10, nodes: [11, 12, 13], tags: { leisure: "park" } }, // 未闭合绿地不收
  ] });
  assert.equal(waterOnly.stats.waters, 1);
  assert.equal(waterOnly.stats.greens, 0);
  const broken = parseOverpass({ elements: [
    { type: "way", id: 9, nodes: [91, 92, 93, 94, 91], tags: { building: "yes" } }, // 节点全缺失
    { type: "relation", id: 5, members: [{ type: "way", ref: 999, role: "outer" }], tags: { building: "yes" } },
    { type: "way", id: 11, nodes: [91, 92], tags: { building: "yes" } }, // 未闭合建筑不收
  ] });
  assert.equal(broken.stats.buildings, 0);
});

test("兼容：浏览器内核与移动端口径静态核查", () => {
  // 移动端：viewport 与小屏媒体查询在位
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(css, /@media \(max-width: 860px\)/);
  // 内核要求如实存在：ES module + importmap（Chrome 89+/Safari 16.4+/Firefox 108+）
  assert.match(html, /type="importmap"/);
  assert.match(html, /type="module" src="js\/app\.js"/);
  // 前端模块未用过新 API（structuredClone/Object.hasOwn/Array.at/顶层 await 表达式）
  for (const f of ["osm.js", "proj.js", "share.js", "themes.js", "scene.js", "app.js"]) {
    const src = readFileSync(new URL("../js/" + f, import.meta.url), "utf8");
    for (const api of ["structuredClone", "Object.hasOwn", ".at(", "replaceAll"])
      assert.ok(!src.includes(api), `${f} 不应依赖 ${api}`);
  }
});
