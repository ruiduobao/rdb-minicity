#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RDB MiniCity 授权码发码工具（命令行，仅供运营方在本地/服务器使用）。

用法::

    export RDBMC_SECRET='<上线真实密钥>'
    python3 tools/issue_license.py --email user@example.com --plan monthly --days 30
    python3 tools/issue_license.py --email user@example.com --plan permanent

输出一行授权码，发给用户粘贴到页面「输入授权码激活 Pro」处即可。
签发后会立即自验回读并打印载荷摘要，确认无误再发出。
密钥只从环境变量 RDBMC_SECRET 读取，切勿写进命令行参数（会留在 shell 历史里）；
未设置环境变量时使用仓库示例假密钥并打印警告，仅供本地测试，上线前必须更换。
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import license as license_module  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="签发 RDB MiniCity 授权码")
    parser.add_argument("--email", required=True, help="购买用户的邮箱")
    parser.add_argument("--plan", required=True, choices=["monthly", "permanent"],
                        help="monthly=月付（带到期日），permanent=永久（无到期日）")
    parser.add_argument("--days", type=int, default=30,
                        help="月付有效天数，默认 30；permanent 时忽略")
    args = parser.parse_args(argv)

    secret = os.environ.get(license_module.SECRET_ENV_VAR, "").strip()
    if not secret:
        print("警告：未设置环境变量 {}，正在使用仓库示例假密钥签发，"
              "此码仅供本地测试，上线前必须更换密钥。".format(
                  license_module.SECRET_ENV_VAR), file=sys.stderr)
        secret = license_module.EXAMPLE_DEV_SECRET
    try:
        code = license_module.issue_license(args.email, plan=args.plan,
                                            days=args.days, secret=secret)
    except license_module.LicenseError as exc:
        print("签发失败：{}".format(exc), file=sys.stderr)
        return 1
    # 签发后自验回读：确保发出去的码能通过同一套校验
    payload = license_module.verify_license(code, secret=secret)
    exp_desc = payload["exp"] if payload["plan"] == "monthly" else "永久有效"
    print("邮箱：{}  类型：{}  到期：{}".format(payload["email"], payload["plan"], exp_desc))
    print(code)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
