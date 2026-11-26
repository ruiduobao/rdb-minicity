#!/usr/bin/env python3
"""第 2 轮新增：Overpass 多镜像轮换 + 第 3 轮服务端边界测试。

fetch_with_mirrors 用注入 opener 测纯轮换逻辑；cached_fetch_ex 走
monkeypatch 的 urlopen 按 URL 分发；Handler 层用真实本地 HTTP 服务
验证空请求 400 与 /api/health 的镜像状态字段。不打真实上游。
运行：python3 tests/test_mirrors.py
"""
import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

M1, M2, M3 = server.OVERPASS_MIRRORS[0], server.OVERPASS_MIRRORS[1], server.OVERPASS_MIRRORS[2]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestMirrorRotation(unittest.TestCase):
    def setUp(self):
        self.saved_status = {k: dict(v) for k, v in server.MIRROR_STATUS.items()}

    def tearDown(self):
        server.MIRROR_STATUS.clear()
        server.MIRROR_STATUS.update(self.saved_status)

    def test_at_least_three_mirrors_configured(self):
        self.assertGreaterEqual(len(server.OVERPASS_MIRRORS), 3)
        self.assertEqual(len(set(server.OVERPASS_MIRRORS)), len(server.OVERPASS_MIRRORS))

    def test_first_success_short_circuits(self):
        calls = []

        def opener(req, timeout=None):
            calls.append((req.full_url, timeout))
            return FakeResponse(b'{"elements":[]}')

        body, used = server.fetch_with_mirrors([M1, M2, M3], data=b"data=x", opener=opener)
        self.assertEqual((body, used), (b'{"elements":[]}', M1))
        self.assertEqual(calls, [(M1, server.MIRROR_TIMEOUT)])  # 只打第一个，带单镜像超时

    def test_failover_to_second_and_status_recorded(self):
        def opener(req, timeout=None):
            if req.full_url == M1:
                raise urllib.error.HTTPError(M1, 502, "Bad Gateway", None, None)
            return FakeResponse(b'{"ok":1}')

        body, used = server.fetch_with_mirrors([M1, M2, M3], data=b"data=x", opener=opener)
        self.assertEqual((body, used), (b'{"ok":1}', M2))
        self.assertEqual(server.MIRROR_STATUS[M1]["fail"], self.saved_status[M1]["fail"] + 1)
        self.assertIn("502", server.MIRROR_STATUS[M1]["last_error"])
        self.assertEqual(server.MIRROR_STATUS[M2]["ok"], self.saved_status[M2]["ok"] + 1)
        self.assertIsNotNone(server.MIRROR_STATUS[M2]["last_ms"])

    def test_all_fail_raises_last_error(self):
        def opener(req, timeout=None):
            raise urllib.error.URLError("不可达 " + req.full_url)

        with self.assertRaises(urllib.error.URLError) as cm:
            server.fetch_with_mirrors([M1, M2], data=b"data=x", opener=opener)
        self.assertIn(M2, str(cm.exception))  # 抛最后一个镜像的错误

    def test_second_round_recovers_after_full_failure(self):
        attempts = []
        sleeps = []

        def opener(req, timeout=None):
            attempts.append(req.full_url)
            if len(attempts) <= 3:  # 第一轮三个镜像全灭
                raise urllib.error.URLError("抖动（测试注入）")
            return FakeResponse(b'{"ok":2}')

        body, used = server.fetch_with_mirrors(
            [M1, M2, M3], data=b"data=x", opener=opener, sleeper=sleeps.append)
        self.assertEqual((body, used), (b'{"ok":2}', M1))  # 第二轮第一个镜像恢复
        self.assertEqual(sleeps, [server.MIRROR_BACKOFF])   # 轮间只等待一次

    def test_rounds_one_disables_retry(self):
        calls = []

        def opener(req, timeout=None):
            calls.append(req.full_url)
            raise urllib.error.URLError("不可达")

        with self.assertRaises(urllib.error.URLError):
            server.fetch_with_mirrors([M1, M2], data=b"data=x", opener=opener,
                                      rounds=1, sleeper=lambda s: None)
        self.assertEqual(calls, [M1, M2])

    def test_empty_mirror_list_rejected(self):
        with self.assertRaises(ValueError):
            server.fetch_with_mirrors([], data=b"data=x", opener=lambda req, timeout=None: None)


class TestCachedFetchMirrors(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.old_cache = server.CACHE
        server.CACHE = Path(self.tmp.name)
        self.old_urlopen = server.urllib.request.urlopen

    def tearDown(self):
        server.CACHE = self.old_cache
        server.urllib.request.urlopen = self.old_urlopen
        self.tmp.cleanup()

    def _dispatch(self, req, timeout=None):
        if req.full_url == M1:
            raise urllib.error.URLError("主镜像超时（测试注入）")
        return FakeResponse(b'{"elements":[1]}')

    def test_miss_via_second_mirror_then_hit(self):
        server.urllib.request.urlopen = self._dispatch
        body, _, state, used = server.cached_fetch_ex(M1, data=b"data=q", mirrors=server.OVERPASS_MIRRORS)
        self.assertEqual((body, state, used), (b'{"elements":[1]}', "miss", M2))
        server.urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(
            AssertionError("命中缓存不应再回源"))
        body, _, state, used = server.cached_fetch_ex(M1, data=b"data=q", mirrors=server.OVERPASS_MIRRORS)
        self.assertEqual((body, state, used), (b'{"elements":[1]}', "hit", None))

    def test_all_mirrors_down_falls_back_to_stale(self):
        server.urllib.request.urlopen = self._dispatch
        server.cached_fetch_ex(M1, data=b"data=q", mirrors=server.OVERPASS_MIRRORS)
        # 把缓存改成过期，再让全部镜像失败 → stale 降级
        for f in server.CACHE.glob("*.json"):
            old = time.time() - 8 * 24 * 3600
            os.utime(f, (old, old))
        server.urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(
            urllib.error.URLError("全镜像不可达（测试注入）"))
        body, _, state, used = server.cached_fetch_ex(M1, data=b"data=q", mirrors=server.OVERPASS_MIRRORS)
        self.assertEqual((body, state), (b'{"elements":[1]}', "stale"))

    def test_all_mirrors_down_no_cache_raises(self):
        server.urllib.request.urlopen = lambda req, timeout=None: (_ for _ in ()).throw(
            urllib.error.URLError("全镜像不可达（测试注入）"))
        with self.assertRaises(urllib.error.URLError):
            server.cached_fetch_ex(M1, data=b"data=q", mirrors=server.OVERPASS_MIRRORS)


class TestHandlerBoundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _req(self, path, data=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data,
                                     method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_health_reports_mirror_status(self):
        code, _, body = self._req("/api/health")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(len(payload["overpass_mirrors"]), 3)
        for m in payload["overpass_mirrors"]:
            self.assertIn("url", m)
            self.assertIn("ok", m)
            self.assertIn("fail", m)

    def test_overpass_empty_body_is_400_chinese(self):
        code, _, body = self._req("/api/overpass", data=b"")
        self.assertEqual(code, 400)
        self.assertIn("为空", json.loads(body)["error"])

    def test_geocode_missing_query_is_400(self):
        code, _, body = self._req("/api/geocode")
        self.assertEqual(code, 400)
        self.assertIn("error", json.loads(body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
