
// 数据层：查询构建、解析、高度推断。无任何第三方依赖。
import { hashString, pseudoHeight } from "./proj.js";

// 本土层高规则（M-U1）：按 building 类型分档层高，比一律 3.2m 更贴国内实际——
// 住宅约 3.0m/层、商办约 3.6m/层、厂房约 5.0m/层；未识别类型维持 3.2m/层。
const FLOOR_HEIGHT_BY_TYPE = [
  [["residential", "apartments", "house", "dormitory", "terrace", "detached",
    "semidetached_house", "bungalow", "static_caravan"], 3.0],
  [["office", "commercial", "retail", "hotel", "hospital", "school",
    "university", "public", "government"], 3.6],
  [["industrial", "warehouse", "factory", "manufacture"], 5.0],
];
export function floorHeightFor(tags = {}) {
  const kind = String(tags.building || "").toLowerCase();
  for (const [types, h] of FLOOR_HEIGHT_BY_TYPE)
    if (types.includes(kind)) return h;
  return 3.2;
}
export function parseHeightTag(tags = {}, id = "") {
  const raw = tags.height;
  if (raw) {
    const v = parseFloat(String(raw).replace(",", ".").replace(/m$/i, "").trim());
    if (Number.isFinite(v) && v > 0 && v < 1000) return Math.round(v * 10) / 10;
  }
  const levels = parseFloat(tags["building:levels"]);
  if (Number.isFinite(levels) && levels > 0)
    return Math.round(levels * floorHeightFor(tags) * 10) / 10;
  // 确定性伪随机：同一建筑每次生成高度一致
  return pseudoHeight("b:" + id, 7, 30);
}
// 高度来源口径：供界面如实告知用户这栋楼的高度可信度（标签实测/层数推算/估算）
export function heightSource(tags = {}) {
  if (tags.height && Number.isFinite(parseFloat(String(tags.height).replace(",", ".").replace(/m$/i, "").trim()))) return "标签";
  if (Number.isFinite(parseFloat(tags["building:levels"]))) return "层数推算";
  return "估算";
}
export function inferHeight(tags, id) { return parseHeightTag(tags, id); }

export function buildOverpassQuery(bbox) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `[out:json][timeout:60];
(
  way["building"](${bb});
  relation["building"](${bb});
  way["highway"](${bb});
  way["natural"="water"](${bb});
  way["waterway"](${bb});
  relation["natural"="water"](${bb});
  way["leisure"~"park|garden|pitch"](${bb});
  way["landuse"~"grass|meadow|forest|recreation_ground"](${bb});
  way["natural"~"wood|grassland"](${bb});
);
out body;>;out skel qt;`;
}

function ringFromNodes(ids, nodeMap) {
  const pts = [];
  for (const id of ids) { const n = nodeMap.get(id); if (n) pts.push([n.lon, n.lat]); }
  return pts;
}
function isClosed(ids) { return ids.length > 3 && ids[0] === ids[ids.length - 1]; }

export function parseOverpass(json) {
  const elements = json?.elements || [];
  const nodeMap = new Map();
  for (const el of elements) if (el.type === "node") nodeMap.set(el.id, el);
  const buildings = [], roads = [], waters = [], greens = [];
  const wayMap = new Map();
  for (const el of elements) if (el.type === "way") wayMap.set(el.id, el);

  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === "way") {
      const pts = ringFromNodes(el.nodes || [], nodeMap);
      if (pts.length < 2) continue;
      if (tags.building) {
        if (isClosed(el.nodes || []) && pts.length >= 4)
          buildings.push({ id: "way/" + el.id, polygon: pts, height: parseHeightTag(tags, el.id), heightSource: heightSource(tags), tags });
      } else if (tags.highway) {
        roads.push({ id: "way/" + el.id, line: pts, highway: tags.highway, name: tags.name || "", tags });
      } else if (tags.natural === "water" || tags.waterway) {
        if (isClosed(el.nodes || [])) waters.push({ id: "way/" + el.id, polygon: pts, tags });
        else waters.push({ id: "way/" + el.id, line: pts, tags });
      } else if (tags.leisure || tags.landuse || tags.natural) {
        if (isClosed(el.nodes || [])) greens.push({ id: "way/" + el.id, polygon: pts, tags });
      }
    } else if (el.type === "relation") {
      // 只处理外环成员，拼成多边形（简化处理，足够微缩模型使用）
      const outer = [];
      for (const m of el.members || []) {
        if (m.type === "way" && (m.role === "outer" || m.role === "")) {
          const way = wayMap.get(m.ref); if (way) outer.push(...ringFromNodes(way.nodes || [], nodeMap));
        }
      }
      if (outer.length >= 4) {
        if (tags.building) buildings.push({ id: "relation/" + el.id, polygon: outer, height: parseHeightTag(tags, el.id), heightSource: heightSource(tags), tags });
        else if (tags.natural === "water") waters.push({ id: "relation/" + el.id, polygon: outer, tags });
      }
    }
  }
  return { buildings, roads, waters, greens,
    stats: { buildings: buildings.length, roads: roads.length, waters: waters.length, greens: greens.length } };
}

// bbox 合法性校验（第 3 轮边界）：经纬度有限、在界内且方向正确，否则本地中文报错。
export function validateBbox(bbox) {
  const { south, west, north, east } = bbox || {};
  for (const [k, v] of Object.entries({ south, west, north, east }))
    if (!Number.isFinite(v)) throw new RangeError(`范围参数不合法：${k} 不是数字。`);
  if (west < -180 || east > 180 || west >= east)
    throw new RangeError("范围参数不合法：经度区间应在 -180 到 180 之间且西界小于东界。");
  if (south < -90 || north > 90 || south >= north)
    throw new RangeError("范围参数不合法：纬度区间应在 -90 到 90 之间且南界小于北界。");
  return bbox;
}

export const OVERPASS_DIRECT = "https://overpass-api.de/api/interpreter";
export async function fetchOsmData(bbox, opts = {}) {
  validateBbox(bbox);
  // opts.onStage(stage, info)：阶段回调，供界面显示「查询中→解析中→建模中」
  // 的进度与等待预期。stage ∈ query（info.attempt 从 1 起、info.total 路数）/ parse。
  const onStage = typeof opts.onStage === "function" ? opts.onStage : null;
  const query = buildOverpassQuery(bbox);
  const endpoints = [];
  if (opts.proxyBase !== null) endpoints.push((opts.proxyBase ?? "") + "api/overpass");
  endpoints.push(OVERPASS_DIRECT);
  let lastErr;
  for (let i = 0; i < endpoints.length; i++) {
    const url = endpoints[i];
    try {
      if (onStage) onStage("query", { attempt: i + 1, total: endpoints.length });
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query) });
      if (!res.ok) throw new Error("数据服务返回 " + res.status);
      const json = await res.json();
      if (onStage) onStage("parse", {});
      const parsed = parseOverpass(json);
      // 服务端三态缓存口径透传：stale 时界面要如实提示「用的是缓存旧数据」
      const cacheState = res.headers && typeof res.headers.get === "function"
        ? res.headers.get("X-RDB-Cache") : null;
      if (cacheState) parsed.cacheState = cacheState;
      return parsed;
    } catch (e) { lastErr = e; }
  }
  // 全部线路失败：给用户能看懂的中文报错，并保留最后一次原始错误便于排查
  const detail = lastErr ? `（最后一次错误：${lastErr.message}）` : "";
  throw new Error("数据获取失败：所有数据线路都暂时不可用" + detail + "。请稍后重试，或换一个地点、范围再试。");
}
export async function geocode(query, opts = {}) {
  const urls = [];
  if (opts.proxyBase !== null) urls.push((opts.proxyBase ?? "") + "api/geocode?q=" + encodeURIComponent(query));
  urls.push("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=zh-CN&q=" + encodeURIComponent(query));
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url); if (!res.ok) throw new Error("搜索服务返回 " + res.status);
      const arr = await res.json();
      return arr.map(r => ({ name: r.display_name, lon: +r.lon, lat: +r.lat }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("地点搜索失败");
}
export { hashString };
