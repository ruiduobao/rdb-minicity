#!/usr/bin/env python3
"""阶段一新增：服务端缓存三态（hit/miss/stale）与 /api/health 测试。

直接以 monkeypatch 替换 server.urllib.request.urlopen，不打真实上游。
运行：python3 tests/test_cache.py
"""
import hashlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestCachedFetch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_cache = server.CACHE
        server.CACHE = Path(self.tmp.name)
        self.old_urlopen = server.urllib.request.urlopen
        self.url = "https://example.invalid/api"
        self.key = hashlib.sha256((self.url + "|").encode()).hexdigest()
        self.file = server.CACHE / (self.key + ".json")

    def tearDown(self):
        server.CACHE = self.old_cache
        server.urllib.request.urlopen = self.old_urlopen
        self.tmp.cleanup()

    def _fail(self, req, timeout=None):
        raise urllib.error.URLError("上游不可达（测试注入）")

    def test_miss_then_hit(self):
        server.urllib.request.urlopen = lambda req, timeout=None: FakeResponse(b'{"a":1}')
        body, _, state = server.cached_fetch(self.url)
        self.assertEqual((body, state), (b'{"a":1}', "miss"))
        server.urllib.request.urlopen = self._fail  # 命中新鲜缓存时不应再回源
        body, _, state = server.cached_fetch(self.url)
        self.assertEqual((body, state), (b'{"a":1}', "hit"))

    def test_stale_fallback_when_upstream_down(self):
        self.file.write_bytes(b'{"old":true}')
        old = time.time() - 8 * 24 * 3600  # 超过 7 天 TTL
        os.utime(self.file, (old, old))
        server.urllib.request.urlopen = self._fail
        body, _, state = server.cached_fetch(self.url)
        self.assertEqual((body, state), (b'{"old":true}', "stale"))

    def test_no_cache_and_upstream_down_raises(self):
        server.urllib.request.urlopen = self._fail
        with self.assertRaises(urllib.error.URLError):
            server.cached_fetch(self.url)


if __name__ == "__main__":
    unittest.main(verbosity=2)
