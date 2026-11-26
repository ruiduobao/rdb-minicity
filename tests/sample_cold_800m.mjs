// 第 2 轮验收采样：800m 冷生成连续 20 次（国内不同城市真实坐标）。
// 每次采样前按服务端缓存键规则删除该地点缓存文件，确保是真冷请求；
// 逐次记录成功/失败、耗时、命中镜像、建筑数，原始记录写 JSON 文件。
// 用法：先启动服务（python3 server.py 8771），再 node tests/sample_cold_800m.mjs
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { bboxFromCenter } from "../js/proj.js";
import { buildOverpassQuery, parseOverpass } from "../js/osm.js";

const BASE = process.env.MINICITY_BASE || "http://127.0.0.1:8771";
const PRIMARY = "https://overpass-api.de/api/interpreter"; // 与 server.OVERPASS_MIRRORS[0] 一致（缓存键口径）
const CACHE_DIR = new URL("../.cache/", import.meta.url);

const PLACES = [
  ["广州 · 广州塔", 113.3307, 23.1135],
  ["重庆 · 解放碑", 106.5773, 29.5571],
  ["武汉 · 黄鹤楼", 114.3025, 30.5446],
  ["南京 · 夫子庙", 118.7887, 32.0209],
  ["长沙 · 五一广场", 112.9756, 28.1963],
  ["青岛 · 栈桥", 120.3185, 36.0639],
  ["哈尔滨 · 中央大街", 126.6173, 45.7749],
  ["苏州 · 金鸡湖", 120.7080, 31.3200],
  ["昆明 · 翠湖", 102.7049, 25.0503],
  ["拉萨 · 布达拉宫广场", 91.1172, 29.6576],
  ["乌鲁木齐 · 大巴扎", 87.6150, 43.7778],
  ["福州 · 三坊七巷", 119.2955, 26.0868],
  ["厦门 · 中山路", 118.0789, 24.4596],
  ["天津 · 五大道", 117.2010, 39.1120],
  ["郑州 · 二七广场", 113.6669, 34.7516],
  ["合肥 · 包公园", 117.2890, 31.8590],
  ["南昌 · 滕王阁", 115.8755, 28.6847],
  ["沈阳 · 中街", 123.4580, 41.8020],
  ["石家庄 · 解放广场", 114.5149, 38.0428],
  ["太原 · 钟楼街", 112.5690, 37.8580],
];

const records = [];
for (const [name, lon, lat] of PLACES) {
  const body = "data=" + encodeURIComponent(buildOverpassQuery(bboxFromCenter(lon, lat, 800)));
  const key = createHash("sha256").update(PRIMARY + "|" + body).digest("hex");
  const cacheFile = new URL(key + ".json", CACHE_DIR);
  if (existsSync(cacheFile)) unlinkSync(cacheFile); // 保真冷：清掉该地点既有缓存
  const started = Date.now();
  const rec = { place: name, lon, lat, size: 800, ok: false, ms: null,
                http: null, cache: null, mirror: null, buildings: null, error: null };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 420000); // 服务端多镜像两轮最坏约 365s
    const res = await fetch(BASE + "/api/overpass", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body, signal: ctl.signal,
    });
    clearTimeout(timer);
    rec.http = res.status;
    rec.cache = res.headers.get("X-RDB-Cache");
    rec.mirror = res.headers.get("X-RDB-Mirror");
    const json = await res.json();
    if (res.ok && Array.isArray(json.elements)) {
      rec.ok = true;
      rec.buildings = parseOverpass(json).stats.buildings;
    } else {
      rec.error = (json && json.error) || ("HTTP " + res.status);
    }
  } catch (e) {
    rec.error = String(e && e.message || e);
  }
  rec.ms = Date.now() - started;
  records.push(rec);
  console.log(`${rec.ok ? "✓" : "✗"} ${name} ${rec.ms}ms http=${rec.http} cache=${rec.cache} mirror=${rec.mirror} buildings=${rec.buildings} ${rec.error || ""}`);
  await new Promise(r => setTimeout(r, 2000));
}
const okCount = records.filter(r => r.ok).length;
const summary = { target: "800m 冷生成 ×20", ok: okCount, total: records.length,
                  rate: +(okCount / records.length * 100).toFixed(1),
                  at: new Date().toISOString(), records };
const out = new URL("./cold-sample-800m-20261126.json", import.meta.url);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`成功 ${okCount}/${records.length}（${summary.rate}%），原始记录已写入 tests/cold-sample-800m-20261126.json`);
