# mcp-drift

把「这台机器现在跑什么 MCP、权限面被放宽到哪」导出成**可 review 的快照**，并检测与团队基线的漂移。

零依赖，只用 Node 内置模块。Node >= 18。

## 为什么存在

`dsh-mcp-manager` 把 MCP 的名册、加载模式、工具规则、破坏性工具策略管得很好，
但这些开关**只存在于本机 profile 的 `cordis.patch.yml` 里**。

于是这个场景无人能察觉：

| 人 | 机器上的实际状态 |
|---|---|
| A | 上季度出过事故，把 `delete_*` 全禁了 |
| B | 忘了配，`destructiveHint: true` 的工具直接进了会话 |
| C | 还留着两个月前临时加、团队早已决定下线的 server |

**三个人的 MCP 权限面完全不同，而且没有任何一个人能看出这个差异。**

本工具不解决治理，只解决**让差异变得可见且可进 code review**。

## 它读哪几个字段（这是最容易搞错的地方）

`dsh-mcp-manager` 的策略**不在 MCP 行自己的 `config` 上**。MCP 行的 `config` 是连接配置
（`command` / `args` / `url` / `env` / `headers`）。策略在**插件自己的设置节点**里，
而那个节点的 Loader 行 id 就是 `mcp-manager`：

```yaml
- insert:
    - id: mcp-manager                    # ← 策略在这里
      name: '@guowenzhang/dsh-mcp-manager'
      config:
        loading: dynamic                 # eager | dynamic | lazy，全局，不分行
        descriptions:
          'global:context7': '查库文档'   # 行描述，按 rowKey
        tools:                           # 按行的工具规则
          'global:context7': ['get_*', '!delete_*']   # ! 前缀 = 隐藏
          'preset:standard:mcp-github': ['list_*']
        optimize:                        # 全局上下文预算策略
          hideDestructive: true
          annotations: true
          search: true
          namesOnly: true
          pageSize: 10
          maxTools: 200
    - id: mcp-context7                   # ← 这只是连接配置，不含策略
      name: '@upstash/context7-mcp'
      config:
        command: npx
        args: [-y, '@upstash/context7-mcp']
```

`rowKey` 是 `global:<serverName>` 或 `preset:<presetId>:<serverName>`。
`serverName` 的算法复刻自插件的 `serverNameFromCommand`：去 scope、去尾部
`-mcp` / `-mcp-server` / `-server`、去版本、非字母数字转 `-`、截 32 字符。
（`@upstash/context7-mcp` → `context7`；`@modelcontextprotocol/server-github` → `server-github`。）
本工具同时把行 id 当作别名接受，避免改名导致的误报。

## 用法

```sh
# 1. 生成基线（提交进仓库，作为团队约定）
node mcp-drift.mjs snapshot --config ~/.dsh/profiles/<profile>/cordis.patch.yml -o mcp-baseline.json

# 2. 本机自检
node mcp-drift.mjs check --config <同上> --baseline mcp-baseline.json

# 3. 比对两份已保存的快照
node mcp-drift.mjs diff --baseline base.json --current cur.json
```

CI 里一步到位：

```yaml
- run: node mcp-drift.mjs check --config cordis.patch.yml --baseline mcp-baseline.json
```

| 退出码 | 含义 |
|---|---|
| `0` | 无漂移；基线缺失也算 0（第一次接入不该红） |
| `1` | 有漂移（含风险级）；`snapshot` 读到不完整策略面时同样 1 |
| `2` | 参数缺失、文件不存在、YAML 解析失败 |

## 输出分级

| 级别 | 含义 | 例子 |
|---|---|---|
| `[风险]` | 权限面被放宽，需人工确认 | 全局 `hideDestructive` 被关 / 新增基线外的 server / 启用了基线里关着的 server / 基线里的 server 消失 |
| `[放宽]` | 约束减少 | 工具规则少了条目 / 规则 key 匹配不到任何 server / `maxTools` 上限被移除 |
| `[变更]` | 口径变化但未必放宽 | 加载模式改变 / server 被关闭 / server 改名 |

## 设计约束

**绝不静默降级。** 治理工具最危险的失败模式不是崩溃，是**报一个假的干净结果**：

- 配置存在但解析不出映射 → 抛错退出，不当成「未配置」
- 找不到设置节点 → 明确警告「本快照只含 server 名单，不代表权限面」，退出 1
- 规则里含非字符串条目 → 报警告，不上报一份看起来正常的规则集
- 规则 key 匹配不到任何 server 行（改名后策略静默失效）→ 单列 `ORPHAN_RULE_KEY`，不沉在警告里
- YAML 用了锚点 / 多文档 / 块标量 → 报错，不猜

**只读配置，比的是配置不是运行态。** 不校验 server 是否真实存在、是否可达、
工具集合是否与声明一致——那是 `tools/list` 的事，不是这份快照的事。

**`surfaceHash` 覆盖全局策略 + 每个启用行的 server 名与规则集。**
两台机器的 hash 相同，说明权限面一致；不同就 diff 看差异。

## 已知边界

- 不解析多文档 / 锚点 / 复杂嵌套 flow 块，遇到直接报错
- `serverName` 的推断字段名跟随上游 `src/mcp-spec.ts`，**上游改名需同步本工具**
- 同一 server 名在多个 preset 下各有规则时，全部取出合并排序（不区分 plane，只做权限面判定）
- 基线 JSON 是 `v2` schema；`v1` 快照（字段名错误的那版）不兼容，需重新生成