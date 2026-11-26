
// 分享链接编解码：把地点/范围/主题/视角编码进 URL hash。
export function encodeShare(state) {
  const payload = {
    v: 1, lon: +(+state.lon).toFixed(6), lat: +(+state.lat).toFixed(6),
    s: state.size || 400, t: state.theme || "modern", n: state.name || "",
    az: +(state.azimuth ?? 45).toFixed(1), pol: +(state.polar ?? 52).toFixed(1),
    d: Math.round(state.distance || 620), pro: state.pro ? 1 : 0,
  };
  const json = JSON.stringify(payload);
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "#m=" + b64;
}
export function decodeShare(hash) {
  if (!hash) return null;
  const m = String(hash).match(/m=([A-Za-z0-9\-_]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const obj = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (typeof obj.lon !== "number" || typeof obj.lat !== "number") return null;
    // 边界加固（第 3 轮）：越界经纬度的分享链接一律视为无效；范围只认三档，非法值回落 400
    if (!Number.isFinite(obj.lon) || !Number.isFinite(obj.lat)) return null;
    if (obj.lon < -180 || obj.lon > 180 || obj.lat < -90 || obj.lat > 90) return null;
    const size = [200, 400, 800].includes(obj.s) ? obj.s : 400;
    return { lon: obj.lon, lat: obj.lat, size, theme: obj.t || "modern", name: obj.n || "",
      azimuth: obj.az ?? 45, polar: obj.pol ?? 52, distance: obj.d || 620, pro: !!obj.pro };
  } catch { return null; }
}
export function buildShareUrl(baseUrl, state) { return baseUrl.split("#")[0] + encodeShare(state); }
