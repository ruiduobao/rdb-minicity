#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RDB MiniCity 授权码测试：签发 -> /api/activate 校验、篡改拒绝、月付过期拒绝、永久通过。

运行：python3 -m unittest tests/test_license.py（在产品目录执行），或直接 python3 tests/test_license.py
测试全程使用测试密钥（环境变量 RDBMC_SECRET 注入子进程），不触碰真实密钥。
"""
import datetime as dt
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import license as lic  # noqa: E402

TEST_SECRET = "TEST-SECRET-FOR-MINICITY-UNITTESTS"
PORT = 8899
BASE = f"http://127.0.0.1:{PORT}"


def activate(code):
    req = urllib.request.Request(
        BASE + "/api/activate",
        data=json.dumps({"code": code}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def tamper(code):
    # 改动载荷区中部一个字符（避开前缀与签名区），签名必然失配
    i = len(code) // 2
    ch = code[i]
    return code[:i] + ("A" if ch != "A" else "B") + code[i + 1:]


class LicenseUnitTests(unittest.TestCase):
    def test_issue_verify_monthly(self):
        code = lic.issue_license("buyer@example.com", plan="monthly", days=30, secret=TEST_SECRET)
        self.assertTrue(code.startswith("RDBMC-"))
        p = lic.verify_license(code, secret=TEST_SECRET)
        self.assertEqual(p["email"], "buyer@example.com")
        self.assertEqual(p["plan"], "monthly")
        self.assertTrue(p["exp"])

    def test_permanent_no_exp(self):
        code = lic.issue_license("buyer@example.com", plan="permanent", secret=TEST_SECRET)
        p = lic.verify_license(code, secret=TEST_SECRET,
                               today=dt.date(2099, 1, 1))  # 远未来仍有效
        self.assertEqual(p["plan"], "permanent")
        self.assertIsNone(p["exp"])

    def test_expired_monthly_rejected(self):
        code = lic.issue_license("old@example.com", plan="monthly", days=30,
                                 secret=TEST_SECRET, today=dt.date(2020, 1, 1))
        with self.assertRaises(lic.LicenseError):
            lic.verify_license(code, secret=TEST_SECRET)  # 今天已远超 2020-01-31
        self.assertFalse(lic.is_pro(code, secret=TEST_SECRET))

    def test_tampered_rejected(self):
        code = lic.issue_license("buyer@example.com", plan="permanent", secret=TEST_SECRET)
        with self.assertRaises(lic.LicenseError):
            lic.verify_license(tamper(code), secret=TEST_SECRET)
        with self.assertRaises(lic.LicenseError):
            lic.verify_license(code, secret="WRONG-SECRET")


class ActivateApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ, RDBMC_SECRET=TEST_SECRET)
        cls.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, "server.py"), str(PORT)],
            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                with urllib.request.urlopen(BASE + "/", timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("server.py 未能在测试端口启动")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except Exception:
            cls.proc.kill()

    def test_homepage_200(self):
        with urllib.request.urlopen(BASE + "/", timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("RDB MiniCity", r.read().decode("utf-8"))

    def test_activate_monthly_ok(self):
        code = lic.issue_license("api@example.com", plan="monthly", days=30, secret=TEST_SECRET)
        status, body = activate(code)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"] and body["pro"])
        self.assertEqual(body["plan"], "monthly")
        self.assertTrue(body["exp"])

    def test_activate_permanent_ok(self):
        code = lic.issue_license("api@example.com", plan="permanent", secret=TEST_SECRET)
        status, body = activate(code)
        self.assertEqual(status, 200)
        self.assertEqual(body["plan"], "permanent")
        self.assertIsNone(body["exp"])

    def test_activate_tampered_rejected(self):
        code = lic.issue_license("api@example.com", plan="permanent", secret=TEST_SECRET)
        status, body = activate(tamper(code))
        self.assertEqual(status, 403)
        self.assertFalse(body["ok"])

    def test_activate_expired_monthly_rejected(self):
        code = lic.issue_license("api@example.com", plan="monthly", days=30,
                                 secret=TEST_SECRET, today=dt.date(2020, 1, 1))
        status, body = activate(code)
        self.assertEqual(status, 403)
        self.assertFalse(body["ok"])
        self.assertIn("到期", body["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
