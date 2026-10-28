# Issue 巡检台账

> 「GitHub 反馈常设工作流」已处理记录。每日凌晨 2 点自动巡检 DeptAI-UI-DSH 的 open issues，
> 新反馈直接修复并回复感谢；本文件兼作「新反馈」判定基准——编号不在此表的 open issue 即为新反馈。
>
> 列：编号 | 标题 | 提交者 | 类型 | 处理方式 | 凭据 | 日期

| 编号 | 标题 | 提交者 | 类型 | 处理方式 | 凭据 | 日期 |
|---|---|---|---|---|---|---|
| #1 | plugin bundle: bundled @ybkk/plugin-rq-card is not resolvable after install from git (ERR_MODULE_NOT_FOUND at boot) | @01men | 缺陷 | 已修复（根因移除）：根包 @ybkk/gate-01 自声明插件出口（dsh.client + exports），cordis.patch.yml rq-card 条目改写根包名，废弃 file: 依赖与 bundledDependencies；修复提交 2447bce 于 2026-10-27 交付 main（本台账建立时补齐收尾：感谢评论 + 关闭 completed）。遗留跟进：npm registry latest 1.2.1 早于修复，registry 安装形态待后续发版更新，已在该 issue 回复中如实说明并建议暂用 git 形态 | [评论](https://github.com/01men/DeptAI-UI-DSH/issues/1#issuecomment-6475413661) | 2026-10-29 |
