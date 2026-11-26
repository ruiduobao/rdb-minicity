#!/usr/bin/env python3
"""RDB MiniCity 本地服务：托管静态文件 + 代理地理编码与开放街图数据查询，带磁盘缓存。
只用 Python 标准库。用法：python3 server.py [端口，默认 8765]
"""
import hashlib, json, sys, time, urllib.parse, urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import license as license_module

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
UA = {"User-Agent": "RDB-MiniCity/0.1 (local dev server)"}

# Overpass 多镜像轮换（第 2 轮）：单一上游间歇 502/超时是冷生成 0/4 的根因。
# 候选镜像经 2026-11-26 本机实测筛选（小查询探活 + 中国境内坐标有数据）：
# overpass-api.de 主站（间歇可用，成功 2 次/502 若干）、maps.mail.ru
# （实测 200 且有中国数据，约 11s）、z.overpass-api.de（主站同服务的另一
# 前端主机，实测 200）、overpass.kumi.systems（公共镜像，本机出口下慢，
# 列末位兜底）。overpass.osm.ch 只有瑞士区域数据、nchc.org.tw 连接失败，
# 均已剔除。
OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
MIRROR_TIMEOUT = 45  # 单镜像超时（秒）：超时即切换下一镜像，不在一棵树上吊死

# 镜像健康状态（进程内）：url -> {ok, fail, last_ms, last_error, last_ok_at}
MIRROR_STATUS = {u: {"ok": 0, "fail": 0, "last_ms": None, "last_error": None, "last_ok_at": None}
                 for u in OVERPASS_MIRRORS}

def _record_mirror(url, ok, ms, err=None):
    st = MIRROR_STATUS.setdefault(url, {"ok": 0, "fail": 0, "last_ms": None,
                                         "last_error": None, "last_ok_at": None})
    st["last_ms"] = round(ms)
    if ok:
        st["ok"] += 1; st["last_ok_at"] = int(time.time()); st["last_error"] = None
    else:
        st["fail"] += 1; st["last_error"] = str(err)[:200]

MIRROR_ROUNDS = 2      # 全部镜像失败后整轮重试的轮数（上游 502 多为分钟级抖动）
MIRROR_BACKOFF = 5     # 两轮之间等待秒数

def fetch_with_mirrors(urls, data=None, timeout=MIRROR_TIMEOUT, opener=None,
                       rounds=MIRROR_ROUNDS, backoff=MIRROR_BACKOFF, sleeper=None):
    """按序轮换请求多个镜像：单镜像超时/失败即切换下一个；整轮全灭时
    等待 backoff 秒再重试一轮（第 2 轮采样实测：失败多为上游分钟级抖动，
    单轮轮换只有 80%，整轮重试是把成功率抬向 95% 的关键一环）。

    返回 (body, used_url)；全部轮次失败时抛最后一个异常。opener/sleeper
    可注入（单元测试用），opener 签名同 urllib.request.urlopen(req, timeout=...)。
    """
    if not urls:
        raise ValueError("未配置任何上游镜像")
    open_fn = opener or urllib.request.urlopen
    sleep_fn = sleeper or time.sleep
    last = None
    for rnd in range(max(1, rounds)):
        if rnd > 0:
            sleep_fn(backoff)
        for url in urls:
            started = time.time()
            try:
                req = urllib.request.Request(url, data=data, headers=UA,
                                             method="POST" if data else "GET")
                with open_fn(req, timeout=timeout) as r:
                    body = r.read()
                _record_mirror(url, True, (time.time() - started) * 1000)
                return body, url
            except Exception as e:  # 超时/502/连接失败都切换下一镜像
                _record_mirror(url, False, (time.time() - started) * 1000, e)
                last = e
    raise last

def cached_fetch_ex(url, data=None, ttl=7 * 24 * 3600, mirrors=None):
    """带磁盘缓存的上游请求。返回 (body, content_type, cache_state, used_url)。

    cache_state：hit=新鲜缓存直接命中；miss=回源成功并已写缓存；
    stale=回源失败但存在过期缓存，降级返回旧数据（上游间歇 502 时
    用户至少能生成，只是数据可能不是最新——响应头 X-RDB-Cache 会
    如实标注，前端与运维可感知）。无任何缓存且回源失败时抛异常。
    mirrors 非空时回源走多镜像轮换，缓存键仍以逻辑主 URL 计算，
    保证命中的镜像不同也不影响缓存一致性。
    """
    key = hashlib.sha256(((url or "") + "|" + (data.decode() if data else "")).encode()).hexdigest()
    f = CACHE / (key + ".json")
    if f.exists() and time.time() - f.stat().st_mtime < ttl:
        return f.read_bytes(), "application/json", "hit", None
    try:
        if mirrors:
            body, used = fetch_with_mirrors(mirrors, data=data)
        else:
            req = urllib.request.Request(url, data=data, headers=UA, method="POST" if data else "GET")
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            used = url
    except Exception:
        if f.exists():
            return f.read_bytes(), "application/json", "stale", None
        raise
    f.write_bytes(body)
    return body, "application/json", "miss", used

def cached_fetch(url, data=None, ttl=7 * 24 * 3600):
    """cached_fetch_ex 的三元组兼容包装（既有调用与测试口径不变）。"""
    body, ct, state, _used = cached_fetch_ex(url, data=data, ttl=ttl)
    return body, ct, state

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw): super().__init__(*a, directory=str(ROOT), **kw)
    def _send(self, body, ctype="application/json", code=200, cache_state=None, mirror=None):
        self.send_response(code); self.send_header("Content-Type", ctype)
        if cache_state: self.send_header("X-RDB-Cache", cache_state)
        if mirror: self.send_header("X-RDB-Mirror", mirror)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/health":
            count = len(list(CACHE.glob("*.json"))) if CACHE.exists() else 0
            mirrors = [{"url": url, **MIRROR_STATUS.get(url, {})} for url in OVERPASS_MIRRORS]
            return self._send(json.dumps({"ok": True, "product": "RDB MiniCity",
                                          "cache_entries": count,
                                          "overpass_mirrors": mirrors}).encode())
        if u.path == "/api/geocode":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0]
            if not q: return self._send(json.dumps({"error": "请输入要搜索的地点"}).encode(), code=400)
            url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=zh-CN&q=" + urllib.parse.quote(q)
            try:
                body, ct, cache_state = cached_fetch(url)
                return self._send(body, ct, cache_state=cache_state)
            except Exception as e: return self._send(json.dumps({"error": str(e)}).encode(), code=502)
        return super().do_GET()
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/activate":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                req = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                return self._send(json.dumps({"ok": False, "error": "请求格式不正确"}).encode(), code=400)
            code = (req.get("code") or "").strip()
            if not code:
                return self._send(json.dumps({"ok": False, "error": "授权码为空"}).encode(), code=400)
            try:
                p = license_module.verify_license(code)
            except license_module.LicenseError as e:
                return self._send(json.dumps({"ok": False, "error": str(e)}).encode(), code=403)
            return self._send(json.dumps({"ok": True, "pro": True, "plan": p["plan"],
                                          "email": p["email"], "exp": p.get("exp")}).encode())
        if u.path == "/api/overpass":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
            if not body.strip():
                return self._send(json.dumps({"error": "请求内容为空：请提供要查询的范围数据"}).encode(), code=400)
            try:
                data, ct, cache_state, used = cached_fetch_ex(
                    OVERPASS_MIRRORS[0], data=body, mirrors=OVERPASS_MIRRORS)
                return self._send(data, ct, cache_state=cache_state, mirror=used)
            except Exception as e:
                return self._send(json.dumps({"error": "数据服务暂时不可用：所有数据线路均繁忙，请稍后重试（" + str(e) + "）"}).encode(), code=502)
        return self._send(json.dumps({"error": "接口不存在"}).encode(), code=404)
    def log_message(self, fmt, *args): sys.stderr.write("[minicity] " + fmt % args + "\n")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"RDB MiniCity 服务已启动：http://127.0.0.1:{port}/")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
