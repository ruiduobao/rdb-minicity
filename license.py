#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RDB MiniCity 授权码体系（HMAC-SHA256 签名，与锐多宝其他产品同一自有方案）。

授权码格式（自有设计）::

    RDBMC-<载荷>-<签名>

载荷与签名均为 Base32 编码后按 5 字符分组、以 ``-`` 连接的可读字符串。

载荷为紧凑 JSON::

    {"email": "...", "plan": "monthly",   "exp": "YYYY-MM-DD", "v": 1}
    {"email": "...", "plan": "permanent", "exp": null,         "v": 1}

- plan=monthly：带到期日 exp，含到期日当天可用，过期拒绝；
- plan=permanent：无到期日（exp 为 null），永久有效。

签名 = HMAC-SHA256(secret, 载荷原始字节) 的前 20 字节。

安全说明：签发 / 验签密钥从环境变量 ``RDBMC_SECRET`` 读取；
未设置时使用仓库中的示例假密钥（仅供本地开发与自动化测试），
**上线前必须更换为随机长密钥并妥善保管**，切勿把真实密钥写进代码或仓库。
"""

from __future__ import annotations

import base64
import datetime as _dt
import hashlib
import hmac
import json
import os

#: 环境变量名：签发 / 验签共用密钥从这里读取。
SECRET_ENV_VAR = "RDBMC_SECRET"

#: 示例假密钥，仅用于本地开发与自动化测试。上线前必须更换！
EXAMPLE_DEV_SECRET = "EXAMPLE-DEV-SECRET-RDBMC-REPLACE-BEFORE-RELEASE"

CODE_PREFIX = "RDBMC"
_SIGNATURE_BYTES = 20  # 160 bit 签名，足够防伪造且码长可控
_PAYLOAD_VERSION = 1
PLANS = ("monthly", "permanent")


class LicenseError(Exception):
    """授权相关错误，消息为可直接展示给用户的中文。"""


def get_secret(explicit: str | None = None) -> str:
    """按 显式参数 > 环境变量 RDBMC_SECRET > 示例假密钥 的顺序取得密钥。"""
    if explicit:
        return explicit
    env_value = os.environ.get(SECRET_ENV_VAR, "").strip()
    if env_value:
        return env_value
    return EXAMPLE_DEV_SECRET


def _b32_grouped(raw: bytes) -> str:
    text = base64.b32encode(raw).decode("ascii").rstrip("=")
    return "-".join(text[i:i + 5] for i in range(0, len(text), 5))


def _b32_ungroup(text: str) -> bytes:
    cleaned = text.replace("-", "").strip().upper()
    padding = "=" * ((8 - len(cleaned) % 8) % 8)
    return base64.b32decode(cleaned + padding)


def _sign(payload_bytes: bytes, secret: str) -> bytes:
    digest = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    return digest[:_SIGNATURE_BYTES]


def issue_license(email: str, plan: str = "monthly", days: int = 30,
                  secret: str | None = None,
                  today: _dt.date | None = None) -> str:
    """为 ``email`` 签发一张授权码。

    plan=monthly 时必须给出正整数 days，到期日 = 签发日 + days 天
    （含到期日当天可用，见 verify_license）；plan=permanent 无到期日。
    """
    email = (email or "").strip()
    if not email or "@" not in email:
        raise LicenseError("邮箱格式不正确，无法签发授权码。")
    if plan not in PLANS:
        raise LicenseError("授权类型不正确：应为 monthly 或 permanent。")
    start = today or _dt.date.today()
    if plan == "monthly":
        if not days or days <= 0:
            raise LicenseError("月付授权的有效天数必须为正整数。")
        exp = (start + _dt.timedelta(days=days)).isoformat()
    else:
        exp = None
    payload = {"email": email, "plan": plan, "exp": exp, "v": _PAYLOAD_VERSION}
    payload_bytes = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":")).encode("utf-8")
    signature = _sign(payload_bytes, get_secret(secret))
    return "{}-{}-{}".format(CODE_PREFIX, _b32_grouped(payload_bytes),
                             _b32_grouped(signature))


def verify_license(code: str, secret: str | None = None,
                   today: _dt.date | None = None) -> dict:
    """验签并校验有效期。成功返回载荷 dict，失败抛 LicenseError（中文）。"""
    if not code or not isinstance(code, str):
        raise LicenseError("授权码为空。")
    text = code.strip().upper()
    if not text.startswith(CODE_PREFIX + "-"):
        raise LicenseError("授权码格式不正确：应以 RDBMC- 开头。")
    body = text[len(CODE_PREFIX) + 1:]
    joined = body.replace("-", "")
    sig_chars = len(base64.b32encode(b"\x00" * _SIGNATURE_BYTES).decode().rstrip("="))
    if len(joined) <= sig_chars:
        raise LicenseError("授权码长度不正确，可能被截断。")
    payload_part, sig_part = joined[:-sig_chars], joined[-sig_chars:]
    try:
        payload_bytes = _b32_ungroup(payload_part)
        signature = _b32_ungroup(sig_part)
    except Exception:
        raise LicenseError("授权码包含非法字符，解码失败。")
    expected = _sign(payload_bytes, get_secret(secret))
    if not hmac.compare_digest(signature, expected):
        raise LicenseError("授权码签名校验失败：授权码无效或已被篡改。")
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except Exception:
        raise LicenseError("授权码载荷损坏，无法解析。")
    if payload.get("v") != _PAYLOAD_VERSION:
        raise LicenseError("授权码版本不受支持，请联系技术支持获取新码。")
    plan = payload.get("plan")
    if plan not in PLANS:
        raise LicenseError("授权码类型不受支持，请联系技术支持获取新码。")
    if plan == "monthly":
        exp_text = payload.get("exp") or ""
        try:
            expire = _dt.date.fromisoformat(exp_text)
        except ValueError:
            raise LicenseError("授权码到期日字段损坏。")
        now = today or _dt.date.today()
        if now > expire:
            raise LicenseError("授权码已于 {} 到期，请续费后获取新码。".format(exp_text))
    return payload


def is_pro(code: str | None, secret: str | None = None,
           today: _dt.date | None = None) -> bool:
    """便捷判断：授权码有效（月付在有效期内 / 永久）时返回 True，异常返回 False。"""
    if not code:
        return False
    try:
        verify_license(code, secret=secret, today=today)
    except LicenseError:
        return False
    return True
