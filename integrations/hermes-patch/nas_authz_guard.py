# -*- coding: utf-8 -*-
"""
nas_authz_guard —— hermes 本地直读通道数据权限 guard（dev-plan-nas-authz §2.5，R7 hook 化交付）。

交付形态：独立模块文件，仅产出代码未部署。apply_patch6.py 在钉钉适配器「文件工具调度层」
插入一行 import hook（两条通道：本地直读 + MCP，都拦在调度层），上游镜像升级时漂移面最小。

设计：
- 身份取自消息 sender_staff_id（钉钉 userId），调用平台 check 用 agent 自己的机器凭证
  （client-credentials 令牌缓存刷新），身份绝不进工具参数（P0-2 教训）；
- fail-closed：平台不可达默认拒绝；env HERMES_AUTHZ_DEGRADE=readonly 灰度期降级只读；
- observeOnly（平台 rules.observeOnly=true）时 deny 仅告警不拦截（G0 双通道同步观察）；
- deny 返回结构化理由（含申请入口提示），由 patch4 卡片链路渲染给用户。
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

# 操作映射：本地直读动作 / MCP 工具 → 七类操作（与网关 authz.js 同一 §2.1 映射语义）
OP_MAP = {
    "read": "read", "list": "read", "search": "read", "info": "read",
    "download": "download",
    "write": "write", "create": "write", "upload": "write", "mkdir": "write",
    "rename": "modify", "move": "modify", "copy": "modify", "compress": "modify", "extract": "modify",
    "delete": "delete",
    "share": "share", "admin": "admin",
}
WRITE_LIKE = {"write", "modify", "delete", "share", "admin"}


class AuthzDeny(Exception):
    """deny 异常：调度层捕获后走 patch4 卡片链路回拒绝理由（含申请入口）。"""

    def __init__(self, reasons, share_request_hint=True):
        self.reasons = list(reasons)
        self.share_request_hint = share_request_hint
        text = "；".join(self.reasons)
        if share_request_hint:
            text += "。如需分享/临时授权，请回复「申请分享」发起审批。"
        super().__init__(text)


class NasAuthzGuard:
    def __init__(self, platform_base_url=None, client_id=None, client_secret=None, timeout_seconds=2.0):
        import os

        self.platform_base_url = (platform_base_url or os.environ.get("HERMES_AUTHZ_PLATFORM_URL", "")).rstrip("/")
        self.client_id = client_id or os.environ.get("HERMES_AUTHZ_CLIENT_ID", "")
        self.client_secret = client_secret or os.environ.get("HERMES_AUTHZ_CLIENT_SECRET", "")
        self.timeout_seconds = float(timeout_seconds)
        self.degrade = os.environ.get("HERMES_AUTHZ_DEGRADE", "deny").lower()  # deny | readonly（灰度可配）
        self.observe_only = os.environ.get("HERMES_AUTHZ_OBSERVE_ONLY", "0") == "1"
        self._token_cache = {"token": None, "expires_at": 0.0}

    # -- 机器凭证（client-credentials，令牌缓存刷新） ------------------------

    def _machine_token(self):
        if self._token_cache["token"] and self._token_cache["expires_at"] > time.time() + 60:
            return self._token_cache["token"]
        if not self.platform_base_url or not self.client_id or not self.client_secret:
            raise RuntimeError("HERMES_AUTHZ_UNCONFIGURED：平台地址或机器凭证未配置")
        request = urllib.request.Request(
            f"{self.platform_base_url}/api/auth/client-credentials",
            method="POST",
            headers={"content-type": "application/json"},
            data=json.dumps({"clientId": self.client_id, "clientSecret": self.client_secret}).encode("utf-8"),
        )
        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        data = payload.get("data") or {}
        token = data.get("token")
        expires_in = int(data.get("expiresInSec") or data.get("expiresAt") or 3600)
        if not token:
            raise RuntimeError("HERMES_AUTHZ_TOKEN_FAIL：机器凭证换牌失败")
        self._token_cache = {"token": token, "expires_at": time.time() + expires_in}
        return token

    # -- 判定 -----------------------------------------------------------------

    def check(self, nas_id, action, paths, sender_staff_id):
        """
        调度层唯一入口。返回 allow；deny 抛 AuthzDeny（理由透传卡片）。
        action：本地直读动作名或 MCP 工具名（内部归一化为七类操作）。
        """
        op = OP_MAP.get(str(action).lower().removeprefix("fs_").removeprefix("nas_fs_"))
        if op is None:
            raise AuthzDeny([f"操作 {action} 不在数据权限映射面内，fail-closed 拒绝"], share_request_hint=False)
        paths = [str(p) for p in (paths if isinstance(paths, (list, tuple)) else [paths]) if str(p).strip()]
        try:
            token = self._machine_token()
        except Exception as error:  # fail-closed：换牌失败即拒绝
            raise AuthzDeny([f"平台判定不可达（{error}），fail-closed 拒绝"], share_request_hint=False)

        body = json.dumps({"nasId": nas_id, "userId": sender_staff_id, "paths": paths, "op": op}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.platform_base_url}/api/nas/authz/check",
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
            data=body,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
            decision = payload.get("data") or {}
        except Exception as error:
            if self.degrade == "readonly" and op not in WRITE_LIKE:
                return True  # 灰度降级：放行读
            raise AuthzDeny([f"平台判定不可达（{error}），{'只读降级' if self.degrade == 'readonly' else 'fail-closed'} 拒绝"],
                            share_request_hint=False)

        reasons = decision.get("reasons") or []
        observe_only = bool(decision.get("observeOnly"))
        if decision.get("decision") == "allow" or (observe_only and self.observe_only):
            # G0：平台观察模式 + 本地 observeOnly 开关 → deny 仅告警不拦截（allow 正常放行）
            return True
        if observe_only:
            return True  # 平台侧观察模式：本地同步观察，不拦截（G0 双通道一起观察，避免绕权后门）
        raise AuthzDeny(reasons or ["数据权限拒绝（平台未返回理由）"])
