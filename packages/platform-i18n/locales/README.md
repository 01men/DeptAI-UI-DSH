# 词典目录（locales/<locale>/*.json）

- **键 = 中文原文**（逐字，含标点），**值 = 译文**。`zh-CN` 无需词典（键即原文）。
- 同目录**多文件按文件名序浅合并**——服务端抽取按插件组分文件（如 `10-console-routes.json`、
  `20-iam-authn.json`、`30-workforce-panel.json`、`40-assets.json`、`90-cli.json`），并行团队互不覆盖。
- 插值占位符 `{name}`：键与译文都可含；`t('共 {n} 条记录', { n: 3 })`。
- 企业定制覆盖层：`I18N_EXTRA_DIR/<locale>/*.json`（同键覆盖，私有化部署本地话术）。
- 前端词典在 `plugin-console/public/locales/<locale>/` 与 `plugin-panel-core/public/locales/<locale>/`，
  由控制台 `GET /locales/:locale` 三层合并后单请求下发。
- **术语以 docs/i18n/GLOSSARY.md 为准；协议层 ASCII 键（事件名/权限点/错误码/env/信封字段）永不翻译。**
