
import { createMiniCity } from "./scene.js";
import { fetchOsmData, geocode } from "./osm.js";
import { bboxFromCenter } from "./proj.js";
import { THEMES, getTheme } from "./themes.js";
import { encodeShare, decodeShare, buildShareUrl } from "./share.js";

const $ = s => document.querySelector(s);
const state = { lon: 104.0817, lat: 30.6553, size: 400, theme: "qinglv", name: "成都 · 春熙路", pro: false };
const PRESETS = [
  { name: "成都 · 春熙路", lon: 104.0817, lat: 30.6553 },
  { name: "上海 · 陆家嘴", lon: 121.4972, lat: 31.2397 },
  { name: "北京 · 故宫", lon: 116.3974, lat: 39.9163 },
  { name: "西安 · 钟楼", lon: 108.9471, lat: 34.2613 },
  { name: "杭州 · 西湖断桥", lon: 120.1490, lat: 30.2588 },
  { name: "深圳 · 市民中心", lon: 114.0560, lat: 22.5455 },
  { name: "南京 · 夫子庙", lon: 118.7885, lat: 32.0213 },
  { name: "武汉 · 黄鹤楼", lon: 114.3025, lat: 30.5450 },
  { name: "广州 · 广州塔", lon: 113.3306, lat: 23.1056 },
  { name: "重庆 · 解放碑", lon: 106.5730, lat: 29.5570 },
  { name: "长沙 · 五一广场", lon: 112.9755, lat: 28.1960 },
  { name: "青岛 · 栈桥", lon: 120.3186, lat: 36.0605 },
  { name: "厦门 · 鼓浪屿", lon: 118.0655, lat: 24.4470 },
  { name: "哈尔滨 · 中央大街", lon: 126.6170, lat: 45.7730 },
  { name: "苏州 · 金鸡湖", lon: 120.7050, lat: 31.3180 },
  { name: "昆明 · 翠湖", lon: 102.7040, lat: 25.0500 },
  { name: "拉萨 · 布达拉宫广场", lon: 91.1180, lat: 29.6550 },
  { name: "乌鲁木齐 · 大巴扎", lon: 87.6150, lat: 43.7800 },
];
let viewer = null, lastData = null, map = null, boxLayer = null;

// ---------- 授权（Pro） ----------
// 授权码由服务端 /api/activate 用 HMAC-SHA256 验签；前端只保存激活结果，不持有密钥。
const LS_CODE = "rdbmc_license_code";
const LS_INFO = "rdbmc_license_info";
let license = null; // { plan: "monthly"|"permanent", email, exp } 或 null（免费版）

function licenseExpired(info) {
  if (!info || info.plan !== "monthly" || !info.exp) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return today > new Date(info.exp + "T00:00:00");
}
function applyLicense() {
  state.pro = !!license && !licenseExpired(license);
  if (license && licenseExpired(license)) license = null;
  const el = $("#planStatus");
  if (el) {
    el.textContent = state.pro
      ? (license.plan === "permanent"
          ? `当前版本：永久版 Pro（${license.email}）`
          : `当前版本：Pro 月付（${license.email}，有效期至 ${license.exp}）`)
      : "当前版本：免费版";
  }
  const b4096 = $("#export4096");
  if (b4096) {
    b4096.classList.toggle("locked", !state.pro);
    b4096.textContent = state.pro ? "导出 4096px" : "导出 4096px（Pro）";
  }
  const hint = $("#exportHint");
  if (hint) hint.textContent = state.pro
    ? "Pro 已激活：导出无水印，4096px 高清导出已解锁。"
    : "免费版：2048px 导出带品牌水印，4096px 为 Pro 专属。Pro：去水印 + 4096px 解锁。";
}
function saveLicense(code, info) {
  license = info;
  try {
    if (code && info) { localStorage.setItem(LS_CODE, code); localStorage.setItem(LS_INFO, JSON.stringify(info)); }
    else { localStorage.removeItem(LS_CODE); localStorage.removeItem(LS_INFO); }
  } catch { /* 隐私模式等场景忽略 */ }
  applyLicense();
}
async function activateWith(code) {
  const r = await fetch("api/activate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "授权码校验失败");
  return { plan: data.plan, email: data.email, exp: data.exp || null };
}
async function loadLicense() {
  let code = null, info = null;
  try {
    code = localStorage.getItem(LS_CODE);
    info = JSON.parse(localStorage.getItem(LS_INFO) || "null");
  } catch { /* 忽略 */ }
  if (!code || !info) { applyLicense(); return; }
  if (licenseExpired(info)) { saveLicense(null, null); return; }
  license = info; applyLicense();
  // 有后端时复验一次（防本地记录被篡改）；连不上后端时保留本地记录（离线宽限）
  try {
    const fresh = await activateWith(code);
    saveLicense(code, fresh);
  } catch (e) {
    if (e instanceof TypeError) return; // 网络不可达：保留本地激活状态
    saveLicense(null, null); // 服务端明确拒绝（篡改/过期）：降级免费版
  }
}

function setStatus(t) { $("#status").textContent = t; }
function currentView() { return viewer ? viewer.getView() : { azimuth: 45, polar: 52, distance: 620 }; }

let genSeq = 0;
async function generate() {
  // 并发防护：快速连点预设/搜索时多个请求会同时在飞。必须以「发起时刻」的
  // 中心点投影（数据与中心一一对应），且只有最后一次请求的结果可以上屏，
  // 否则先发后到的旧数据会以新地点为中心投影，出现空底座或地点对不上的画面。
  const seq = ++genSeq;
  const center = { lon: state.lon, lat: state.lat };
  const size = state.size;
  // 阶段提示（整改阶段一）：查询中（第几路/已等秒数）→解析中→建模中，
  // 长等待时用户能看到进度与预期，而不是一句「正在获取…」干等。
  const startedAt = Date.now();
  let stageText = "正在查询开放街图数据（第 1 路）";
  const paintStage = () => {
    if (seq !== genSeq) return;
    const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    setStatus(secs >= 3 ? `${stageText}…已等待 ${secs} 秒，数据服务繁忙时可能需要几分钟（服务会自动换线路重试）。` : `${stageText}…`);
  };
  paintStage();
  const timer = setInterval(paintStage, 1000);
  try {
    const bbox = bboxFromCenter(center.lon, center.lat, size);
    const data = await fetchOsmData(bbox, {
      onStage: (stage, info) => {
        if (stage === "query") stageText = `正在查询开放街图数据（第 ${info.attempt}/${info.total} 路）`;
        else if (stage === "parse") stageText = "数据已返回，正在解析建筑、道路、水系与绿地";
        paintStage();
      },
    });
    if (seq !== genSeq) return; // 已有更新的生成请求，丢弃过期结果
    stageText = "解析完成，正在建模（拉伸建筑、铺设道路）";
    paintStage();
    // 让「建模中」先绘制出来，再执行同步建模，避免界面冻住看不到提示
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (seq !== genSeq) return;
    lastData = data;
    viewer.build(lastData, center, size, getTheme(state.theme));
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const total = lastData.stats.buildings + lastData.stats.roads + lastData.stats.waters + lastData.stats.greens;
    if (total === 0) {
      // 空结果区域（海上/无人区/覆盖空白）：明确告诉用户不是故障，是没数据
      setStatus("已查询完成，但这个区域在开放地图里暂无建筑、道路、水系与绿地数据（可能是海上、无人区或数据覆盖空白），所以画面是空的。换个地点，或把范围改大些再试。");
    } else if (data.cacheState === "stale") {
      setStatus(`已生成（用时 ${secs} 秒）：建筑 ${lastData.stats.buildings} 栋 · 道路 ${lastData.stats.roads} 条 · 水系 ${lastData.stats.waters} 处 · 绿地 ${lastData.stats.greens} 处。提示：数据服务暂时繁忙，本次用的是上次成功缓存的数据，可能不是最新，稍后重新生成即可刷新。`);
    } else {
      setStatus(`已生成（用时 ${secs} 秒）：建筑 ${lastData.stats.buildings} 栋 · 道路 ${lastData.stats.roads} 条 · 水系 ${lastData.stats.waters} 处 · 绿地 ${lastData.stats.greens} 处。若建筑偏少，是该区域开放数据覆盖不全所致。点击任意建筑可查看名称与高度。`);
    }
    updateHash();
    drawBox();
  } catch (e) {
    if (seq !== genSeq) return; // 过期请求的失败同样不打扰当前状态
    setStatus("生成失败：" + e.message + "（可稍后重试，或换一个范围）");
  } finally {
    clearInterval(timer);
  }
}
function updateHash() {
  history.replaceState(null, "", encodeShare({ ...state, ...currentView() }));
}
function drawBox() {
  if (!map) return;
  const b = bboxFromCenter(state.lon, state.lat, state.size);
  const bounds = [[b.south, b.west], [b.north, b.east]];
  if (boxLayer) boxLayer.setBounds(bounds); else boxLayer = L.rectangle(bounds, { color: "#c0392b", weight: 2 }).addTo(map);
  map.setView([state.lat, state.lon], Math.max(map.getZoom(), 15));
}
function initMap() {
  map = L.map("minimap").setView([state.lat, state.lon], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(map);
  map.on("click", e => { state.lon = e.latlng.lng; state.lat = e.latlng.lat; state.name = "地图选点"; $("#placeName").textContent = state.name; drawBox(); });
  drawBox();
}
function initUI() {
  const sel = $("#themeSel");
  sel.innerHTML = THEMES.map(t => `<option value="${t.id}">${t.name}（${t.desc}）</option>`).join("");
  sel.value = state.theme;
  sel.onchange = () => { state.theme = sel.value; if (lastData) viewer.build(lastData, state, state.size, getTheme(state.theme), { keepView: true }); updateHash(); };
  $("#presetRow").innerHTML = PRESETS.map((p, i) => `<button class="chip" data-i="${i}">${p.name}</button>`).join("");
  $("#presetRow").onclick = e => { const b = e.target.closest("[data-i]"); if (!b) return;
    const p = PRESETS[+b.dataset.i]; Object.assign(state, { lon: p.lon, lat: p.lat, name: p.name });
    $("#placeName").textContent = p.name; generate(); };
  document.querySelectorAll("[name=size]").forEach(r => r.onchange = () => { state.size = +r.value; drawBox(); });
  $("#searchBtn").onclick = async () => {
    const q = $("#searchInput").value.trim(); if (!q) return;
    setStatus("正在搜索地点…");
    const box = $("#searchResults"); if (box) box.innerHTML = "";
    try {
      const rs = await geocode(q, {});
      if (!rs.length) { setStatus("没有找到该地点，换个说法试试（可加上城市名，如「成都春熙路」）。"); return; }
      const pick = r => {
        Object.assign(state, { lon: r.lon, lat: r.lat, name: q });
        $("#placeName").textContent = r.name.slice(0, 40);
        if (box) box.innerHTML = "";
        generate();
      };
      if (rs.length === 1) { pick(rs[0]); return; }
      // 多结果（歧义地名）：列出候选让用户点选，不擅自替用户选第一个
      setStatus(`找到 ${rs.length} 个叫「${q}」的地方，点下面任意一个生成：`);
      if (box) box.innerHTML = rs.map((r, i) =>
        `<button class="chip" data-ri="${i}">${r.name.slice(0, 42)}</button>`).join("");
      if (box) box.onclick = e => {
        const b = e.target.closest("[data-ri]"); if (b) pick(rs[+b.dataset.ri]);
      };
    } catch (e) { setStatus("搜索失败：" + e.message); }
  };
  $("#genBtn").onclick = generate;
  $("#activateBtn").onclick = async () => {
    const code = $("#licenseInput").value.trim();
    const msg = $("#activateMsg");
    if (!code) { msg.textContent = "请先粘贴授权码。"; return; }
    msg.textContent = "正在校验授权码…";
    try {
      const info = await activateWith(code);
      saveLicense(code, info);
      msg.textContent = info.plan === "permanent"
        ? "激活成功：永久版 Pro 已生效，去水印与 4096px 导出已解锁。"
        : `激活成功：Pro 月付已生效，有效期至 ${info.exp}。`;
    } catch (e) {
      msg.textContent = e instanceof TypeError
        ? "无法连接授权服务：请通过本地服务（python3 server.py）打开本页后再激活。"
        : "激活失败：" + e.message;
    }
  };
  $("#resetViewBtn").onclick = () => {
    viewer.setView({ azimuth: 45, polar: 52, distance: 620 });
    updateHash();
    setStatus("视角已重置到默认角度。");
  };
  $("#shareBtn").onclick = async () => {
    const url = buildShareUrl(location.href, { ...state, ...currentView() });
    try { await navigator.clipboard.writeText(url); setStatus("分享链接已复制，打开即可还原这个场景。"); }
    catch { prompt("复制这条分享链接：", url); }
  };
  document.querySelectorAll("[data-export]").forEach(b => b.onclick = async () => {
    const px = +b.dataset.export;
    if (px >= 4096 && !state.pro) {
      setStatus("4096px 高清导出是 Pro 功能：请在「授权与版本」区输入授权码激活 Pro（月付 10 元 / 月，永久版 100 元）。");
      return;
    }
    setStatus("正在导出高清图…");
    const { blob } = await viewer.exportPNG(px, { pro: state.pro });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    const place = (state.name || "自定义地点").replace(/[\\/:*?"<>|\s·]+/g, "-").replace(/^-+|-+$/g, "") || "自定义地点";
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    a.download = `RDB-MiniCity-${place}-${state.size}m-${px}px-${ymd}.png`; a.click();
    const sizeText = blob.size >= 1024 * 1024
      ? `${(blob.size / 1024 / 1024).toFixed(2)} MB`
      : `${Math.max(1, Math.round(blob.size / 1024))} KB`;
    setStatus(state.pro
      ? `已导出高清图（Pro 无水印），文件大小 ${sizeText}。`
      : `已导出高清图（免费版带品牌水印），文件大小 ${sizeText}。`);
  });
}
function restoreFromHash() {
  const s = decodeShare(location.hash);
  // 注意：分享链接不携带授权状态，Pro 一律以本机激活记录为准，hash 中的 pro 字段忽略。
  if (s) Object.assign(state, { lon: s.lon, lat: s.lat, size: s.size, theme: s.theme, name: s.name || "分享地点" });
}
// 点击建筑查看名称/高度：按下与抬起位移 <6px 才算点击（拖动旋转不触发）
function initBuildingPick() {
  const stage = $("#stage");
  let downAt = null;
  stage.addEventListener("pointerdown", e => { downAt = [e.clientX, e.clientY]; });
  stage.addEventListener("pointerup", e => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved >= 6 || !viewer || !lastData) return;
    const info = viewer.pickAt(e.clientX, e.clientY);
    if (!info) return;
    const name = info.name || "未命名建筑";
    const src = info.heightSource === "标签" ? "来自开放街图高度标签"
      : info.heightSource === "层数推算" ? `按 ${info.levels || "标注"} 层 × 3.2 米推算`
      : "数据无高度标注，为估算值";
    setStatus(`建筑：${name} · 高度约 ${info.height} 米（${src}）。`);
  });
}
document.addEventListener("DOMContentLoaded", () => {
  restoreFromHash();
  viewer = createMiniCity($("#stage"), {});
  initBuildingPick();
  $("#placeName").textContent = state.name;
  document.querySelector(`[name=size][value="${state.size}"]`)?.click();
  initUI(); $("#themeSel").value = state.theme;
  loadLicense();
  try { initMap(); } catch { $("#minimap").textContent = "小地图加载失败，不影响生成。"; }
  generate().then(() => { const s = decodeShare(location.hash); if (s) viewer.setView(s); });
});
