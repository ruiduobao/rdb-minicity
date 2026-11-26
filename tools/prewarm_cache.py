#!/usr/bin/env python3
"""RDB MiniCity 缓存预热：把常用地点×范围的查询提前打进服务端磁盘缓存。

背景：数据查询上游容量不稳定、冷请求慢且间歇 502。部署后（或定时）
跑一遍本脚本，用户打开热门地点即命中缓存（服务端响应头
X-RDB-Cache: hit），冷门地点才回源。

用法：先启动服务，再在另一终端运行：
    python3 tools/prewarm_cache.py [服务地址，默认 http://127.0.0.1:8765]
        [--sizes 400,800] [--delay 5]

查询串与 bbox 计算与前端 js/osm.js、js/proj.js 逐字对齐，保证缓存键
（服务端按 URL+请求体哈希）与浏览器实际请求完全一致。
"""
import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request

EARTH_R = 6378137.0
PRESETS = [
    ("成都 · 春熙路", 104.0817, 30.6553),
    ("上海 · 陆家嘴", 121.4972, 31.2397),
    ("北京 · 故宫", 116.3974, 39.9163),
    ("西安 · 钟楼", 108.9471, 34.2613),
    ("杭州 · 西湖断桥", 120.1490, 30.2588),
    ("深圳 · 市民中心", 114.0560, 22.5455),
]


def lonlat_to_mercator(lon, lat):
    x = EARTH_R * math.radians(lon)
    clamped = max(-85.05112878, min(85.05112878, lat))
    y = EARTH_R * math.log(math.tan(math.pi / 4 + math.radians(clamped) / 2))
    return x, y


def mercator_to_lonlat(x, y):
    lon = math.degrees(x / EARTH_R)
    lat = math.degrees(2 * math.atan(math.exp(y / EARTH_R)) - math.pi / 2)
    return lon, lat


def bbox_from_center(lon, lat, size_m):
    ox, oy = lonlat_to_mercator(lon, lat)
    half = size_m / 2
    west, south = mercator_to_lonlat(ox - half, oy - half)
    east, north = mercator_to_lonlat(ox + half, oy + half)
    return {"south": south, "west": west, "north": north, "east": east}


def build_query(bbox):
    # 与 js/osm.js buildOverpassQuery 的模板逐字一致（含浮点格式差异容忍：
    # JS 数字转字符串为最短表示，Python repr 对 float 同为最短表示）
    def num(v):
        return repr(float(v))
    bb = ",".join(num(bbox[k]) for k in ("south", "west", "north", "east"))
    return f"""[out:json][timeout:60];
(
  way["building"]({bb});
  relation["building"]({bb});
  way["highway"]({bb});
  way["natural"="water"]({bb});
  way["waterway"]({bb});
  relation["natural"="water"]({bb});
  way["leisure"~"park|garden|pitch"]({bb});
  way["landuse"~"grass|meadow|forest|recreation_ground"]({bb});
  way["natural"~"wood|grassland"]({bb});
);
out body;>;out skel qt;"""


def encode_uri_component(text):
    # 对齐 JS encodeURIComponent 的不转义字符集
    return urllib.parse.quote(text, safe="-_.!~*'()")


def bodies_via_node(sizes):
    """优先用 Node 调前端原模块生成请求体，保证浮点格式与浏览器逐字一致。

    返回 {(lon, lat, size): body_bytes}；Node 不可用时返回 None，调用方
    回退到 Python 复刻（浮点末位可能差 1e-12，缓存键或对不上，仅作兜底）。
    """
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    presets_js = json.dumps([[lon, lat] for _, lon, lat in PRESETS])
    sizes_js = json.dumps(sizes)
    script = f"""
import {{ bboxFromCenter }} from "file://{root}/js/proj.js";
import {{ buildOverpassQuery }} from "file://{root}/js/osm.js";
const out = [];
for (const [lon, lat] of {presets_js}) for (const size of {sizes_js}) {{
  const q = buildOverpassQuery(bboxFromCenter(lon, lat, size));
  out.push({{ lon, lat, size, body: "data=" + encodeURIComponent(q) }});
}}
console.log(JSON.stringify(out));
"""
    try:
        proc = subprocess.run(["node", "--input-type=module", "-e", script],
                              capture_output=True, text=True, timeout=30)
        if proc.returncode != 0:
            return None
        return {(item["lon"], item["lat"], item["size"]): item["body"].encode()
                for item in json.loads(proc.stdout)}
    except Exception:
        return None


def warm_one(base, name, lon, lat, size, body=None):
    if body is None:
        query = build_query(bbox_from_center(lon, lat, size))
        body = ("data=" + encode_uri_component(query)).encode()
    req = urllib.request.Request(base.rstrip("/") + "/api/overpass", data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"},
                                 method="POST")
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=420) as resp:  # 服务端多镜像两轮最坏约 365s
            payload = resp.read()
            cache = resp.headers.get("X-RDB-Cache", "?")
            count = len(json.loads(payload).get("elements", []))
            return True, f"{resp.status} 缓存={cache} 元素={count} 用时={time.time()-started:.1f}s"
    except Exception as exc:  # 上游繁忙时如实记录，不中断其余预热
        return False, f"失败：{exc}（用时 {time.time()-started:.1f}s）"


def main():
    parser = argparse.ArgumentParser(description="RDB MiniCity 缓存预热")
    parser.add_argument("base", nargs="?", default="http://127.0.0.1:8765")
    parser.add_argument("--sizes", default="400,800")
    parser.add_argument("--delay", type=float, default=5.0,
                        help="每次请求间隔秒数，避免压垮上游")
    args = parser.parse_args()
    sizes = [int(s) for s in args.sizes.split(",") if s.strip()]
    bodies = bodies_via_node(sizes)
    if bodies is None:
        print("提示：未找到 Node，已回退 Python 复刻生成请求体（缓存键极小概率对不上）。")
    ok = fail = 0
    for name, lon, lat in PRESETS:
        for size in sizes:
            body = bodies.get((lon, lat, size)) if bodies else None
            success, detail = warm_one(args.base, name, lon, lat, size, body=body)
            print(f"{'✓' if success else '✗'} {name} {size}m：{detail}", flush=True)
            ok, fail = ok + success, fail + (not success)
            time.sleep(args.delay)
    print(f"预热完成：成功 {ok}，失败 {fail}（失败多为上游繁忙，稍后重跑即可）")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
