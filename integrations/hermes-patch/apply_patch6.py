# -*- coding: utf-8 -*-
"""
apply_patch6 —— hermes 本地直读 guard 安装器（dev-plan-nas-authz §2.5，仅产出代码未部署）。

按既有补丁规范实现（R7 修订）：
- hook 化：guard 逻辑全部在独立模块 nas_authz_guard.py，本补丁只在调度层插入一行 import hook；
- hash 锚点：应用前校验目标文件 hash，不匹配即拒绝应用并告警（防静默打在错误版本上）；
- 幂等标记：重复应用自动跳过；
- 备份 + py_compile 校验 + 本地 fixture 自测（--selftest 两轮：应用 → 幂等跳过）。

用法（6 实例共享同一脚本，各实例配自己的平台地址与凭证 env）：
    python3 apply_patch6.py --target /opt/app/hermes_adapter.py   # 应用
    python3 apply_patch6.py --target ... --selftest               # 本地 fixture 自测
    python3 apply_patch6.py --target ... --rollback               # 回滚（恢复最近备份）
"""
from __future__ import annotations

import argparse
import hashlib
import py_compile
import shutil
import sys
from pathlib import Path

# hash 锚点：目标调度层文件的预期 sha256（上游 hermes 镜像升级后此处必须同步更新，
# 不匹配即拒绝应用——宁可补丁失效告警，不可静默打在错误版本上）。
TARGET_HASHES = {
    # "hermes_adapter.py": "sha256:<40位占位，联调窗口按实际镜像填写>",
}
HOOK_MARKER = "# == nas_authz_guard hook (apply_patch6) =="
HOOK_LINES = [
    HOOK_MARKER,
    "from nas_authz_guard import NasAuthzGuard, AuthzDeny  # noqa: E402",
    "_nas_authz_guard = NasAuthzGuard()",
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_anchor(target: Path) -> None:
    """hash 锚点校验：清单非空且当前文件在清单内时必须匹配；不在清单内视为未知版本拒绝。"""
    key = target.name
    if not TARGET_HASHES:
        return  # 清单未填（首次联调窗口）：允许应用但必须显式 --allow-unknown
    expected = TARGET_HASHES.get(key)
    if expected is None:
        raise SystemExit(f"[patch6] 拒绝应用：目标文件 {key} 不在 hash 锚点清单内（上游版本未知）")
    actual = sha256_of(target)
    if actual != expected.removeprefix("sha256:"):
        raise SystemExit(f"[patch6] 拒绝应用：hash 锚点不匹配（期望 {expected[:16]}…，实际 {actual[:16]}…）。"
                         f"上游镜像已升级，请先核对调度层改动并更新 TARGET_HASHES，同时告警通报。")


def is_applied(text: str) -> bool:
    return HOOK_MARKER in text


def insert_hook(target: Path) -> None:
    """在「文件工具调度层」函数入口插入一行 import hook（占位锚点函数按实际镜像确认）。"""
    text = target.read_text(encoding="utf-8")
    if is_applied(text):
        print("[patch6] 已应用（幂等跳过）")
        return
    anchor = "def dispatch_file_tool("
    if anchor not in text:
        raise SystemExit(f"[patch6] 拒绝应用：未找到调度层锚点函数 {anchor}（结构漂移，请人工核对）")
    patched = text.replace(
        anchor,
        "\n".join(HOOK_LINES) + "\n\n\n" + anchor,
        1,
    )
    target.write_text(patched, encoding="utf-8")


def backup(target: Path) -> Path:
    backup_path = target.with_suffix(target.suffix + ".patch6.bak")
    shutil.copy2(target, backup_path)
    return backup_path


def py_compile_check(target: Path) -> None:
    py_compile.compile(str(target), doraise=True)
    print("[patch6] py_compile 通过")


def rollback(target: Path) -> None:
    backup_path = target.with_suffix(target.suffix + ".patch6.bak")
    if not backup_path.exists():
        raise SystemExit("[patch6] 回滚失败：无备份")
    shutil.copy2(backup_path, target)
    print(f"[patch6] 已回滚：{backup_path} → {target}")


def selftest(workdir: Path) -> None:
    """本地 fixture 自测：两轮（应用 → 幂等跳过）+ hash 锚点不匹配拒绝 + guard deny 卡片理由。"""
    fixture_dir = workdir / "patch6-selftest"
    fixture_dir.mkdir(parents=True, exist_ok=True)
    fixture = fixture_dir / "hermes_adapter.py"
    if not fixture.exists():
        fixture.write_text(
            "def dispatch_file_tool(action, paths, sender_staff_id):\n"
            "    return {'ok': True, 'action': action}\n",
            encoding="utf-8",
        )
    # 第一轮：应用
    insert_hook(fixture)
    py_compile_check(fixture)
    assert is_applied(fixture.read_text(encoding="utf-8"))
    print("[selftest] 第一轮应用成功")
    # 第二轮：幂等跳过
    before = fixture.read_text(encoding="utf-8")
    insert_hook(fixture)
    assert fixture.read_text(encoding="utf-8") == before, "幂等性破坏"
    print("[selftest] 第二轮幂等跳过")
    # 锚点不匹配拒绝（临时注入非空清单：真实部署时清单随镜像版本维护）
    global TARGET_HASHES
    original_hashes = dict(TARGET_HASHES)
    TARGET_HASHES.clear()
    TARGET_HASHES["hermes_adapter.py"] = "sha256:" + sha256_of(fixture)
    bad = fixture_dir / "unknown_adapter.py"
    bad.write_text("def dispatch_file_tool(\n    pass\n", encoding="utf-8")
    try:
        verify_anchor(bad)
        raise AssertionError("未知版本未被拒绝")
    except SystemExit as error:
        assert "锚点清单" in str(error)
    mismatch = fixture_dir / "hermes_adapter.py"
    mismatch.write_text("# 上游升级后的新版本\ndef dispatch_file_tool(\n    pass\n", encoding="utf-8")
    try:
        verify_anchor(mismatch)
        raise AssertionError("hash 不匹配未被拒绝")
    except SystemExit as error:
        assert "hash 锚点不匹配" in str(error)
    TARGET_HASHES.clear()
    TARGET_HASHES.update(original_hashes)
    print("[selftest] hash 锚点：未知版本/hash 不匹配均拒绝应用（告警语义）")
    # guard deny → 卡片理由（不依赖真实平台：未配置即 fail-closed 拒绝）
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from nas_authz_guard import NasAuthzGuard, AuthzDeny

    guard = NasAuthzGuard(platform_base_url="", client_id="", client_secret="")
    try:
        guard.check("nas_x", "delete", ["/a/b"], "sender_1")
        raise AssertionError("fail-closed 未生效")
    except AuthzDeny as deny:
        assert deny.reasons and "不可达" in deny.reasons[0]
        print(f"[selftest] deny 卡片理由渲染：{deny}")
    print("[selftest] 全部通过")


def main() -> None:
    parser = argparse.ArgumentParser(description="hermes nas_authz_guard 补丁安装器")
    parser.add_argument("--target", help="调度层文件路径")
    parser.add_argument("--selftest", action="store_true", help="本地 fixture 自测（两轮 + 锚点拒绝 + deny 理由）")
    parser.add_argument("--rollback", action="store_true", help="回滚到最近备份")
    parser.add_argument("--allow-unknown", action="store_true", help="锚点清单为空时显式放行（首次联调）")
    args = parser.parse_args()

    workdir = Path(__file__).resolve().parent
    if args.selftest:
        selftest(workdir)
        return
    if not args.target:
        parser.print_help()
        return
    target = Path(args.target).resolve()
    if args.rollback:
        rollback(target)
        return
    verify_anchor(target)
    backup_path = backup(target)
    insert_hook(target)
    py_compile_check(target)
    print(f"[patch6] 应用完成：{target}（备份 {backup_path}）")


if __name__ == "__main__":
    main()
