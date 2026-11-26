// 技能版第 1 轮：① SKILL.md 与共享内核（主题表/范围档位/编码字段/授权口径）
// 逐项核对；② example-prompt.md 三个示例用 Web 版原模块实跑 share.js，
// 验证链接可构造、可还原、与 Web 版同参数结果一致。
// 预设清单从 js/app.js 源码解析（不复制一份清单，防分叉）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEMES } from "../js/themes.js";
import { encodeShare, decodeShare, buildShareUrl } from "../js/share.js";

const skillMd = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
const exampleMd = readFileSync(new URL("../skill/example-prompt.md", import.meta.url), "utf8");
const appSrc = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

const presets = [...appSrc.matchAll(/\{ name: "([^"]+)", lon: ([\d.]+), lat: ([\d.]+) \}/g)]
  .map(m => ({ name: m[1], lon: +m[2], lat: +m[3] }));
const preset = name => presets.find(p => p.name === name);

test("技能版基线：预设清单可从 Web 版源码解析（≥6 个）", () => {
  assert.ok(presets.length >= 6, "解析到预设 " + presets.length);
  assert.ok(preset("成都 · 春熙路"));
  assert.ok(preset("上海 · 陆家嘴"));
});

test("文档一致性：SKILL.md 主题表与 Web 版 THEMES 逐项对齐", () => {
  for (const t of THEMES) {
    assert.ok(skillMd.includes("`" + t.id + "`"), `SKILL.md 缺主题 id ${t.id}`);
    assert.ok(skillMd.includes(t.name), `SKILL.md 缺主题名 ${t.name}`);
  }
});

test("文档一致性：SKILL.md 编码字段与范围档位与 share.js 对齐", () => {
  for (const f of ["lon/lat", "s", "t", "az/pol/d"]) assert.ok(skillMd.includes(f), "缺字段说明 " + f);
  assert.ok(skillMd.includes("200/400/800"), "范围档位应为 200/400/800");
  assert.ok(skillMd.includes("encodeShare"), "应引用 encodeShare 作为唯一编码实现");
  assert.ok(skillMd.includes("#m="), "应写明链接格式 #m=");
});

test("文档一致性：SKILL.md 授权口径与现行版本一致", () => {
  assert.ok(skillMd.includes("RDBMC-"), "授权码前缀 RDBMC-");
  assert.ok(skillMd.includes("2048"), "免费导出 2048");
  assert.ok(skillMd.includes("4096"), "Pro 导出 4096");
  assert.ok(skillMd.includes("水印"), "免费版带水印口径");
  assert.ok(skillMd.includes("10 元"), "Pro 月付 10 元");
  assert.ok(skillMd.includes("100 元"), "永久版 100 元");
  assert.ok(skillMd.includes("caaschengrui@163.com"), "售后邮箱");
});

function roundtrip(state) {
  const url = buildShareUrl("http://127.0.0.1:8765/", state);
  const back = decodeShare(new URL(url).hash);
  assert.ok(back, "链接应可还原: " + url);
  assert.equal(back.lon, +(+state.lon).toFixed(6));
  assert.equal(back.lat, +(+state.lat).toFixed(6));
  assert.equal(back.size, state.size);
  assert.equal(back.theme, state.theme);
  return url;
}

test("示例实测 1：春熙路青绿山水 400 米链接可构造可还原", () => {
  assert.ok(exampleMd.includes("春熙路") && exampleMd.includes("青绿山水"));
  const p = preset("成都 · 春熙路");
  roundtrip({ lon: p.lon, lat: p.lat, size: 400, theme: "qinglv", name: p.name });
});

test("示例实测 2：陆家嘴 800 米双主题链接只差主题字段", () => {
  assert.ok(exampleMd.includes("陆家嘴") && exampleMd.includes("800"));
  const p = preset("上海 · 陆家嘴");
  const night = roundtrip({ lon: p.lon, lat: p.lat, size: 800, theme: "night", name: p.name });
  const paper = roundtrip({ lon: p.lon, lat: p.lat, size: 800, theme: "xuanzhi", name: p.name });
  assert.notEqual(night, paper);
  const a = decodeShare(new URL(night).hash), b = decodeShare(new URL(paper).hash);
  assert.equal(a.lon, b.lon); assert.equal(a.lat, b.lat); assert.equal(a.size, b.size);
});

test("示例实测 3：非预设地点（县城类）同样可构造可还原", () => {
  assert.ok(exampleMd.includes("县城"));
  // 示例 3 是任意非预设地点：用一组预设外坐标验证通用路径
  roundtrip({ lon: 116.3100, lat: 29.7050, size: 400, theme: "modern", name: "县城老街" });
});

test("文档一致性：SKILL.md 预设清单与 Web 版 PRESETS 逐名对齐", () => {
  for (const p of presets) assert.ok(skillMd.includes(p.name), `SKILL.md 缺预设 ${p.name}`);
});

test("文档一致性：SKILL.md 写明歧义地名追问与无结果口径", () => {
  assert.ok(skillMd.includes("歧义地名必须追问"));
  assert.ok(skillMd.includes("不得擅自替用户选第一个"));
  assert.ok(skillMd.includes("搜索无结果"));
});

test("示例实测 4：歧义地名确认后所选候选链接可还原", () => {
  assert.ok(exampleMd.includes("朝阳公园") && exampleMd.includes("候选"));
  // 候选之一：北京朝阳公园（预设外坐标，走通用构造路径）
  roundtrip({ lon: 116.4700, lat: 39.9440, size: 400, theme: "modern", name: "北京 · 朝阳公园" });
});

test("生成质量（第 2 轮）：全部 18 预设经技能版路径构造链接与 Web 版同参数一致", () => {
  assert.equal(presets.length, 18);
  for (const p of presets)
    roundtrip({ lon: p.lon, lat: p.lat, size: 400, theme: "modern", name: p.name });
});

test("生成质量（第 2 轮）：全部 8 主题经技能版路径可构造可还原", () => {
  const p = preset("成都 · 春熙路");
  assert.equal(THEMES.length, 8);
  for (const t of THEMES)
    roundtrip({ lon: p.lon, lat: p.lat, size: 200, theme: t.id, name: p.name });
});

test("文档一致性（第 2 轮）：SKILL.md 高度分档口径与 floorHeightFor 实现一致", async () => {
  const { floorHeightFor } = await import("../js/osm.js");
  assert.equal(floorHeightFor({ building: "apartments" }), 3.0);
  assert.equal(floorHeightFor({ building: "office" }), 3.6);
  assert.equal(floorHeightFor({ building: "industrial" }), 5.0);
  for (const frag of ["住宅约 3.0", "商办约 3.6", "厂房约 5.0", "其他 3.2"])
    assert.ok(skillMd.includes(frag), "SKILL.md 高度口径缺：" + frag);
});

test("文档一致性（第 2 轮）：SKILL.md 编码字段补齐 n 与 pro", () => {
  assert.ok(skillMd.includes("名称 n"), "应写明名称字段 n");
  assert.ok(skillMd.includes("Pro 标记 pro"), "应写明 Pro 标记 pro");
});

test("参数体验（第 2 轮）：范围口语映射与四参数一次成型口径在位", () => {
  assert.ok(skillMd.includes("四项齐了就直接构造链接"), "一次成型口径");
  assert.ok(skillMd.includes("相邻档"), "口语范围映射到相邻档");
});

test("示例实测 5：解放碑夜市烟火/水墨双主题链接可还原", () => {
  assert.ok(exampleMd.includes("夜市烟火") && exampleMd.includes("水墨"));
  const p = preset("重庆 · 解放碑");
  roundtrip({ lon: p.lon, lat: p.lat, size: 400, theme: "yanhuo", name: p.name });
  roundtrip({ lon: p.lon, lat: p.lat, size: 400, theme: "shuimo", name: p.name });
});

test("示例实测 6：拉萨预设默认参数链接可还原", () => {
  assert.ok(exampleMd.includes("拉萨布达拉宫广场"));
  const p = preset("拉萨 · 布达拉宫广场");
  const back = decodeShare(encodeShare({ lon: p.lon, lat: p.lat, size: 400, theme: "modern", name: p.name }));
  assert.equal(back.azimuth, 45); assert.equal(back.distance, 620);
});

test("示例实测：默认视角与 Web 版一致（az 45 / pol 52 / d 620）", () => {
  const p = preset("成都 · 春熙路");
  const back = decodeShare(encodeShare({ lon: p.lon, lat: p.lat, size: 400, theme: "qinglv", name: p.name }));
  assert.equal(back.azimuth, 45); assert.equal(back.polar, 52); assert.equal(back.distance, 620);
});
