
// 本地墨卡托投影与确定性哈希，全部手写实现。
export const EARTH_R = 6378137;
const DEG = Math.PI / 180;
export function lonLatToMercator(lon, lat) {
  const x = EARTH_R * lon * DEG;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const y = EARTH_R * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
  return { x, y };
}
export function mercatorToLonLat(x, y) {
  const lon = (x / EARTH_R) / DEG;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) / DEG;
  return { lon, lat };
}
// 以中心点为原点的米制平面投影：x 向东，z 向南（与三维场景地面对应）
export function createLocalProjector(centerLon, centerLat) {
  const origin = lonLatToMercator(centerLon, centerLat);
  return {
    center: { lon: centerLon, lat: centerLat },
    project(lon, lat) {
      const p = lonLatToMercator(lon, lat);
      return { x: p.x - origin.x, z: -(p.y - origin.y) };
    },
    unproject(x, z) {
      return mercatorToLonLat(origin.x + x, origin.y - z);
    },
  };
}
// 生成参数校验（第 3 轮边界）：非法经纬度/范围在本地直接给中文报错，不发无效请求。
export function validateCenterSize(centerLon, centerLat, sizeM) {
  if (!Number.isFinite(centerLon) || !Number.isFinite(centerLat))
    throw new RangeError("经纬度不合法：必须是数字。");
  if (centerLon < -180 || centerLon > 180)
    throw new RangeError(`经度不合法：${centerLon}，应在 -180 到 180 之间。`);
  if (centerLat < -90 || centerLat > 90)
    throw new RangeError(`纬度不合法：${centerLat}，应在 -90 到 90 之间。`);
  if (!Number.isFinite(sizeM) || sizeM <= 0 || sizeM > 10000)
    throw new RangeError(`范围不合法：${sizeM}，应是 1 到 10000 之间的米数。`);
}
export function bboxFromCenter(centerLon, centerLat, sizeM) {
  validateCenterSize(centerLon, centerLat, sizeM);
  const proj = createLocalProjector(centerLon, centerLat);
  const half = sizeM / 2;
  const sw = proj.unproject(-half, half);
  const ne = proj.unproject(half, -half);
  return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
}
// FNV-1a 32 位哈希，保证同一 id 每次得到同一结果
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function pseudoHeight(id, min = 7, max = 30) {
  const h = hashString(id);
  return Math.round((min + (h % 1000) / 1000 * (max - min)) * 10) / 10;
}
