
// 配色主题定义。每套主题必须包含完整字段，测试会逐项校验。
export const THEMES = [
  {
    id: "qinglv", name: "青绿山水", desc: "青绿山水——取色千里江山，石青石绿入城",
    bg: "#dfe9dc", fog: "#dfe9dc", ground: "#b9cfae", base: "#e8e2cf", baseSide: "#cbbf9f",
    buildings: ["#3f7d6b", "#5a9a7d", "#7fb069", "#2f5d50", "#8fb996", "#487a5a"],
    roof: "#274e42", road: "#e6dfc8", roadLine: "#b7a97f", water: "#4a90a4", green: "#6aa84f",
    edge: "#1f3d33", light: "#fff6dd", ambient: 0.75, sun: 1.6, night: false,
  },
  {
    id: "xuanzhi", name: "宣纸朱砂", desc: "宣纸朱砂——宣纸为底，朱砂点城",
    bg: "#f3ead8", fog: "#f3ead8", ground: "#eadfc6", base: "#faf3e3", baseSide: "#d8c9a3",
    buildings: ["#e8dcc0", "#d9c7a0", "#c0392b", "#e5d5b0", "#b98a5e", "#ede0c4"],
    roof: "#8c2f22", road: "#fffaf0", roadLine: "#c9b48a", water: "#7aa5a0", green: "#a8b07e",
    edge: "#5a4632", light: "#fff2d8", ambient: 0.85, sun: 1.4, night: false,
  },
  {
    id: "modern", name: "现代浅色", desc: "干净明亮 · 产品图常用",
    bg: "#eef1f4", fog: "#eef1f4", ground: "#d7dde2", base: "#ffffff", baseSide: "#c3ccd3",
    buildings: ["#ffffff", "#dfe6ec", "#b9cbd9", "#eef2f5", "#cbd8e2", "#f5f7f9"],
    roof: "#8fa6b8", road: "#ffffff", roadLine: "#aebbc6", water: "#7fb3d5", green: "#9ccb86",
    edge: "#5b6b7a", light: "#ffffff", ambient: 0.9, sun: 1.5, night: false,
  },
  {
    id: "night", name: "夜景霓虹", desc: "深蓝夜幕 · 暖黄灯火",
    bg: "#0e1626", fog: "#0e1626", ground: "#16233c", base: "#1b2a47", baseSide: "#0a1220",
    buildings: ["#24365a", "#2d4470", "#1c2c4d", "#354e7d", "#283d63"],
    roof: "#f2c14e", road: "#2a3c5f", roadLine: "#f2c14e", water: "#1d4e6b", green: "#1e4d3a",
    edge: "#0a0f1c", light: "#ffe9b0", ambient: 0.45, sun: 0.9, night: true,
  },
  {
    id: "blueprint", name: "蓝图", desc: "工程蓝图 · 白线勾勒",
    bg: "#174a7c", fog: "#174a7c", ground: "#1d5a94", base: "#20619e", baseSide: "#123c66",
    buildings: ["#2b74b8", "#3583c7", "#256cae", "#3d8fd1"],
    roof: "#dbeeff", road: "#1a5288", roadLine: "#dbeeff", water: "#0f3a63", green: "#2b74b8",
    edge: "#eaf6ff", light: "#ffffff", ambient: 0.7, sun: 1.1, night: false,
  },
  {
    id: "shuimo", name: "水墨", desc: "水墨——黑白灰阶，留白入城",
    bg: "#eceae3", fog: "#eceae3", ground: "#d8d5cb", base: "#f4f2ec", baseSide: "#c4c0b2",
    buildings: ["#f7f5ef", "#e3e0d5", "#c9c5b8", "#3a3a38", "#dcd8cc", "#efede6"],
    roof: "#2e2e2c", road: "#faf8f2", roadLine: "#a9a496", water: "#9db3b5", green: "#b5bfa8",
    edge: "#454540", light: "#ffffff", ambient: 0.85, sun: 1.3, night: false,
  },
  {
    id: "yanhuo", name: "夜市烟火", desc: "夜市烟火——红灯金火，人间夜市",
    bg: "#2b1620", fog: "#2b1620", ground: "#3d1f2a", base: "#46252f", baseSide: "#200d16",
    buildings: ["#6e2f35", "#7d3a34", "#5d2a3d", "#8a4638", "#74352c"],
    roof: "#f0a13c", road: "#59313a", roadLine: "#f0a13c", water: "#274b5c", green: "#2e4d33",
    edge: "#160a10", light: "#ffd9a0", ambient: 0.5, sun: 0.95, night: true,
  },
  {
    id: "dusk", name: "暮色陶土", desc: "陶土暖调 · 黄昏",
    bg: "#f0ddd0", fog: "#f0ddd0", ground: "#dfc2ab", base: "#f7e8da", baseSide: "#cfa98c",
    buildings: ["#c96f4a", "#d98c5f", "#b85c38", "#e0a173", "#a84e32"],
    roof: "#7a341f", road: "#fbeee0", roadLine: "#c99b78", water: "#6f9aa8", green: "#8a9a5b",
    edge: "#5e2f1e", light: "#ffd9a8", ambient: 0.7, sun: 1.5, night: false,
  },
];
export const REQUIRED_THEME_FIELDS = ["id","name","bg","fog","ground","base","baseSide","buildings","roof","road","roadLine","water","green","edge","light","ambient","sun","night"];
export function getTheme(id) { return THEMES.find(t => t.id === id) || THEMES[2]; }
