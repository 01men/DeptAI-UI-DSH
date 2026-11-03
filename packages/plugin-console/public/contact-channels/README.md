# `<contact-channels>` · 可复用「联系我们」渠道组件

零依赖 Web Component：一个 `<script>` 引入即可在任何页面使用，Shadow DOM 样式隔离，不污染宿主页面，也不受宿主样式影响。参考 MiniMax 官网页脚风格设计。

## 目录结构（整个文件夹拷走即可复用）

```
contact-channels/
├── contact-channels.js    # 组件本体（唯一必需的运行时文件）
├── assets/
│   ├── qrcode-official.jpg   # 元冰可公众号二维码（可换成任意项目的二维码）
│   └── qrcode-telegram.png   # Telegram 群二维码
├── demo.html              # 效果预览页（双击本地打开即可）
└── README.md
```

## 快速开始

```html
<!-- 1. 引入（相对路径或任意静态资源地址） -->
<script src="contact-channels/contact-channels.js"></script>

<!-- 2. 使用：默认即元冰可完整配置 -->
<contact-channels></contact-channels>

<!-- 3. 换主题 / 品牌色 -->
<contact-channels theme="light" accent="#7c5cff"></contact-channels>
```

## 自定义配置（复用到其他产品）

方式一：HTML 内嵌 JSON（推荐，无需写 JS）

```html
<contact-channels theme="light">
  <script type="application/json">
  {
    "brand":  { "name": "你的产品", "tagline": "Build with\n你的产品", "logo": "" },
    "heading": "联系我们",
    "channels": [
      { "type": "email",    "label": "邮箱",   "value": "hello@your.com" },
      { "type": "wechat",   "label": "微信群", "value": "https://..." },
      { "type": "telegram", "label": "Telegram", "value": "https://t.me/..." }
    ],
    "cards": [
      { "label": "产品公众号", "image": "assets/qrcode-official.jpg", "hint": "扫码关注" },
      { "label": "社区群",     "image": "https://cdn.xxx.com/qr.png", "href": "https://...", "hint": "扫码加群" }
    ]
  }
  </script>
</contact-channels>
```

方式二：JS 属性赋值（适合 React / Vue 动态传入）

```js
document.querySelector('contact-channels').config = { brand: {...}, channels: [...], cards: [...] };
```

### 配置字段

| 字段 | 说明 |
|---|---|
| `brand` | 品牌区。`logo`（图片地址，留空用内置六边形 Y 标）、`name`、`tagline`（`\n` 分行）。传 `"brand": null` 隐藏品牌区 |
| `heading` | 可选小标题，如「联系我们」 |
| `channels[]` | 联系渠道图标条。`type`: `email / wechat / telegram / github / phone / link`；`label` 提示文案；`value` 邮箱地址或链接 |
| `cards[]` | 二维码卡片。`label`、`image`、`hint`（放大层提示语）、`href`（放大层「打开链接」，可选） |
| 置空 | `channels: []` 只展示二维码；`cards: []` 只展示图标条 |

### 路径解析规则

- **默认内置资源**（元冰可二维码）：相对**组件脚本所在目录**的 `assets/`，跟页面位置无关，拷走文件夹即可用。
- **你在配置里写的相对路径**：跟普通 HTML 一样相对**当前页面**。
- `https://`、`data:`、`/` 开头的地址原样使用。

## 属性

| 属性 | 说明 |
|---|---|
| `theme` | `dark`（默认）/ `light` |
| `accent` | 主题色，任意 CSS 颜色，如 `#7c5cff` |
| `brand-name` / `tagline` | 快捷覆盖品牌名 / 标语（优先于配置内值） |

## CSS 变量（深度定制）

```css
contact-channels {
  --cc-accent: #2f6bff;   /* 主题色 */
  --cc-bg: #161618;       /* 背景色 */
  --cc-fg: #f5f5f7;       /* 前景文字 */
  --cc-muted: #8f8f94;    /* 次要文字/图标 */
  --cc-radius: 16px;      /* 圆角 */
  --cc-maxw: 860px;       /* 内容最大宽度 */
}
```

也可用 `::part(root|brand|channels|cards|card|heading)` 精确选择内部结构。

## 事件

| 事件 | 触发 | detail |
|---|---|---|
| `cc-channel-click` | 点击渠道图标 | `{ channel }` |
| `cc-card-click` | 点击二维码卡片（放大） | `{ card }` |
| `cc-copy` | 复制邮箱 | `{ text }` |

事件 `bubbles + composed`，可穿透 Shadow DOM 被外层框架监听，适合埋点。

## 框架集成

React：

```jsx
function ContactFooter() {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.config = myConfig; }, []);
  return <contact-channels ref={ref} theme="light" />;
}
```

Vue：

```vue
<contact-channels theme="light" ref="cc" />
<!-- mounted 里：this.$refs.cc.config = myConfig -->
```

## 内置行为

- 邮箱图标点击 = 打开邮件客户端；悬停出现的蓝色小按钮 = 复制邮箱（带 toast 反馈）
- 微信 / Telegram 图标 = 新标签打开对应链接
- 点击二维码卡片 = 弹层放大查看（Esc / 点背景关闭），配置了 `href` 时放大层带「打开链接」
- 二维码图片缺失时显示「二维码待配置」占位，不破版
- 响应式：窄屏自动换行；`prefers-reduced-motion` 下关闭动效
