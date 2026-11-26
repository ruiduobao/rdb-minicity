
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lonLatToMercator, mercatorToLonLat, createLocalProjector, bboxFromCenter, validateCenterSize } from "../js/proj.js";
import { parseOverpass, parseHeightTag, buildOverpassQuery, heightSource, fetchOsmData, validateBbox, geocode } from "../js/osm.js";
import { THEMES, REQUIRED_THEME_FIELDS, getTheme } from "../js/themes.js";
import { encodeShare, decodeShare, buildShareUrl } from "../js/share.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/sample-osm.json", import.meta.url), "utf8"));

test("投影：已知点与往返一致", () => {
  // 墨卡托已知值：经度 180° 时 x = πR ≈ 20037508.34；赤道 y = 0
  const p = lonLatToMercator(180, 0);
  assert.ok(Math.abs(p.x - 20037508.342789244) < 0.01);
  assert.ok(Math.abs(p.y) < 1e-6);
  const origin = lonLatToMercator(0, 0); assert.equal(origin.x, 0); assert.ok(Math.abs(origin.y) < 1e-6);
  const rt = mercatorToLonLat(...Object.values(lonLatToMercator(104.0817, 30.6553)));
  assert.ok(Math.abs(rt.lon - 104.0817) < 1e-9); assert.ok(Math.abs(rt.lat - 30.6553) < 1e-9);
  const proj = createLocalProjector(104.0817, 30.6553);
  const c = proj.project(104.0817, 30.6553); assert.ok(Math.abs(c.x) < 1e-6 && Math.abs(c.z) < 1e-6);
  // 向东约 0.001° 在北纬 30.65° 附近，墨卡托 x 差约 111.32 米
  const e = proj.project(104.0827, 30.6553); assert.ok(Math.abs(e.x - 111.319) < 0.5, "east offset " + e.x);
  const bb = bboxFromCenter(104.0817, 30.6553, 400);
  assert.ok(bb.east > bb.west && bb.north > bb.south);
});

test("样例解析：计数正确", () => {
  const d = parseOverpass(fixture);
  assert.equal(d.stats.buildings, 3);
  assert.equal(d.stats.roads, 2);
  assert.equal(d.stats.waters, 1);
  assert.equal(d.stats.greens, 1);
  assert.equal(d.roads[0].name, "示例大道");
});

test("高度推断：标签优先且确定性", () => {
  const d = parseOverpass(fixture);
  const byId = Object.fromEntries(d.buildings.map(b => [b.id, b.height]));
  assert.equal(byId["way/101"], 36);          // height 标签
  assert.equal(byId["way/102"], 24);          // apartments 8 层 × 3.0（本土层高规则，第 4 轮）
  assert.ok(byId["way/103"] >= 7 && byId["way/103"] <= 30);
  assert.equal(parseHeightTag({}, 103), parseHeightTag({}, 103)); // 多次一致
  assert.equal(parseOverpass(fixture).buildings[2].height, byId["way/103"]); // 重解析一致
  assert.notEqual(parseHeightTag({}, 103), parseHeightTag({}, 9999)); // 不同 id 大概率不同（哈希散列）
});

test("查询构建包含四类要素", () => {
  const q = buildOverpassQuery({ south: 30.65, west: 104.08, north: 30.66, east: 104.09 });
  for (const k of ['"building"', '"highway"', '"water"', "park"]) assert.ok(q.includes(k), k);
});

test("主题配置完整：至少 5 套、国风至少 2 套", () => {
  assert.ok(THEMES.length >= 5);
  const ids = new Set();
  for (const t of THEMES) {
    for (const f of REQUIRED_THEME_FIELDS) assert.ok(t[f] !== undefined && t[f] !== "", `${t.id} 缺 ${f}`);
    assert.ok(Array.isArray(t.buildings) && t.buildings.length >= 3);
    assert.ok(!ids.has(t.id)); ids.add(t.id);
    for (const c of [...t.buildings, t.bg, t.water, t.green]) assert.match(c, /^#[0-9a-fA-F]{6}$/);
  }
  assert.ok(getTheme("qinglv").name.includes("青绿"));
  assert.ok(getTheme("xuanzhi").name.includes("宣纸"));
  assert.ok(getTheme("night").night === true);
});

test("分享链接编解码往返一致", () => {
  const s = { lon: 121.4972, lat: 31.2397, size: 800, theme: "night", name: "上海 · 陆家嘴", azimuth: 30, polar: 55, distance: 700, pro: true };
  const url = buildShareUrl("https://example.com/minicity/", s);
  const back = decodeShare(new URL(url).hash);
  assert.equal(back.lon, s.lon); assert.equal(back.lat, s.lat); assert.equal(back.size, 800);
  assert.equal(back.theme, "night"); assert.equal(back.name, s.name);
  assert.equal(back.azimuth, 30); assert.equal(back.pro, true);
  assert.equal(decodeShare(""), null); assert.equal(decodeShare("#m=!!!bad"), null);
  const again = decodeShare(encodeShare(back)); assert.deepEqual(again, back);
});

test("高度来源口径：标签/层数推算/估算三分", () => {
  assert.equal(heightSource({ height: "36" }), "标签");
  assert.equal(heightSource({ "building:levels": "8" }), "层数推算");
  assert.equal(heightSource({}), "估算");
  const d = parseOverpass(fixture);
  const byId = Object.fromEntries(d.buildings.map(b => [b.id, b.heightSource]));
  assert.equal(byId["way/101"], "标签");
  assert.equal(byId["way/102"], "层数推算");
  assert.equal(byId["way/103"], "估算");
});

test("生成阶段回调：query→parse 顺序与路数信息", async () => {
  const stages = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => fixture });
  try {
    const d = await fetchOsmData({ south: 30.65, west: 104.08, north: 30.66, east: 104.09 },
      { onStage: (s, info) => stages.push([s, info.attempt, info.total]) });
    assert.equal(d.stats.buildings, 3);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(stages, [["query", 1, 2], ["parse", undefined, undefined]]);
});

test("边界：非法经纬度与范围在本地抛中文错误", () => {
  assert.throws(() => bboxFromCenter(181, 30, 400), /经度不合法/);
  assert.throws(() => bboxFromCenter(104, -91, 400), /纬度不合法/);
  assert.throws(() => bboxFromCenter(NaN, 30, 400), /经纬度不合法/);
  assert.throws(() => bboxFromCenter(104, 30, 0), /范围不合法/);
  assert.throws(() => bboxFromCenter(104, 30, -200), /范围不合法/);
  assert.throws(() => bboxFromCenter(104, 30, 99999), /范围不合法/);
  assert.throws(() => validateCenterSize("104", 30, 400), /经纬度不合法/);
  assert.doesNotThrow(() => bboxFromCenter(104.0817, 30.6553, 800));
});

test("边界：validateBbox 拦截非法区间", () => {
  assert.throws(() => validateBbox({ south: 31, west: 104, north: 30, east: 105 }), /纬度区间/);
  assert.throws(() => validateBbox({ south: 30, west: 105, north: 31, east: 104 }), /经度区间/);
  assert.throws(() => validateBbox({ south: 30, west: 104, north: 31 }), /不是数字/);
  assert.throws(() => validateBbox(null), /不是数字/);
  assert.doesNotThrow(() => validateBbox({ south: 30.6, west: 104.0, north: 30.7, east: 104.1 }));
});

test("边界：parseOverpass 空结果与异常输入返回全零", () => {
  for (const input of [{ elements: [] }, {}, null, undefined, { elements: null }]) {
    const d = parseOverpass(input);
    assert.deepEqual(d.stats, { buildings: 0, roads: 0, waters: 0, greens: 0 });
    assert.equal(d.buildings.length, 0);
  }
});

test("边界：分享链接越界坐标无效、非法范围回落 400", () => {
  const bad = encodeShare({ lon: 200, lat: 30, size: 400, theme: "modern" });
  assert.equal(decodeShare(bad), null);
  const badLat = encodeShare({ lon: 104, lat: -120, size: 400, theme: "modern" });
  assert.equal(decodeShare(badLat), null);
  const oddSize = encodeShare({ lon: 104, lat: 30, size: 12345, theme: "modern" });
  assert.equal(decodeShare(oddSize).size, 400);
  const okSize = encodeShare({ lon: 104, lat: 30, size: 800, theme: "modern" });
  assert.equal(decodeShare(okSize).size, 800);
});

test("边界：fetchOsmData 全部线路失败给中文友好报错", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    await assert.rejects(
      fetchOsmData({ south: 30.65, west: 104.08, north: 30.66, east: 104.09 }),
      /数据获取失败：所有数据线路都暂时不可用（最后一次错误：fetch failed）。请稍后重试/);
  } finally { globalThis.fetch = realFetch; }
});

test("边界：fetchOsmData 非法 bbox 不发请求直接报错", async () => {
  let called = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { called++; return { ok: true, json: async () => fixture }; };
  try {
    await assert.rejects(
      fetchOsmData({ south: 31, west: 104.08, north: 30.66, east: 104.09 }), /范围参数不合法/);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(called, 0);
});

test("边界：stale 缓存标记透传给界面层", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => fixture,
    headers: { get: h => (h === "X-RDB-Cache" ? "stale" : null) } });
  try {
    const d = await fetchOsmData({ south: 30.65, west: 104.08, north: 30.66, east: 104.09 });
    assert.equal(d.cacheState, "stale");
    assert.equal(d.stats.buildings, 3);
  } finally { globalThis.fetch = realFetch; }
});

test("边界：geocode 无结果返回空数组、多结果全量返回", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    assert.deepEqual(await geocode("不存在的地名", {}), []);
  } finally { globalThis.fetch = realFetch; }
  globalThis.fetch = async () => ({ ok: true, json: async () => [
    { display_name: "春熙路, 成都", lon: "104.08", lat: "30.65" },
    { display_name: "春熙路, 绵阳", lon: "104.73", lat: "31.46" },
  ] });
  try {
    const rs = await geocode("春熙路", {});
    assert.equal(rs.length, 2);
    assert.equal(rs[1].name, "春熙路, 绵阳");
    assert.equal(typeof rs[0].lon, "number");
  } finally { globalThis.fetch = realFetch; }
});

test("生成阶段回调：第一路失败时报第二路并最终抛错", async () => {
  const stages = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  try {
    await assert.rejects(
      fetchOsmData({ south: 30.65, west: 104.08, north: 30.66, east: 104.09 },
        { onStage: (s, info) => stages.push([s, info.attempt]) }),
      /数据服务返回 502/);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(stages, [["query", 1], ["query", 2]]);
});
