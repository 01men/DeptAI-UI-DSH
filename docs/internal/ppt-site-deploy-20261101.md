# 宣讲页 ppt.ybkkasi.com 部署记录 · 2026-11-01

> 任务：将《元冰可 AIOS × 01门》交互式宣讲页（`PPT/kimi_agent_html宣讲页部署.zip`，纯静态：
> index.html + src/main.js + src/style.css + vendor/{d3,three}）部署到 **https://ppt.ybkkasi.com**，
> 作为本项目产品与 [01men/DeptAI-UI-DSH](https://github.com/01men/DeptAI-UI-DSH) 的对外介绍页。
> 结论先行：**已上线，公网 200，真浏览器渲染三处抽查（首屏粒子画布 / d3 架构图 / 14 行业图谱）全部通过。**

## 一、部署拓扑（全部落在本机，与 demo 子域同一套路：本地管理隧道 + LaunchAgent 常驻）

```
浏览器
  │ https://ppt.ybkkasi.com/
  ▼
Cloudflare（DNS CNAME ppt → 3c85f544-0ffe-4ad0-967e-cb6a25a9205d.cfargotunnel.com，橙云代理）
  ▼
ybkk-ppt 隧道（本地管理 ingress：~/.cloudflared/config-ppt.yml，兜底 404 不暴露其他本机端口）
  └─ 唯一路径规则            → http://127.0.0.1:7280   ← python http.server 静态目录
                                                       /Users/ybkk/ybkk-lab/ppt-site/
```

落位清单：

| 项 | 值 |
| --- | --- |
| 站点目录 | `~/ybkk-lab/ppt-site/`（index.html、src/、vendor/，资源全部相对路径，改包即改站） |
| 静态服务 | `/usr/bin/python3 -m http.server 7280 --bind 127.0.0.1`（与 com.ybkk.site 同款模式） |
| 静态服务常驻 | `~/Library/LaunchAgents/com.ybkk.ppt-site.plist`（KeepAlive） |
| 隧道 | `ybkk-ppt` = `3c85f544-0ffe-4ad0-967e-cb6a25a9205d`（本地管理，credentials `~/.cloudflared/<id>.json`） |
| 隧道配置 | `~/.cloudflared/config-ppt.yml`（ingress：ppt.ybkkasi.com → 7280；兜底 404） |
| 隧道常驻 | `~/Library/LaunchAgents/com.cloudflare.tunnel-ppt.plist`（KeepAlive，http2） |
| DNS | `ppt.ybkkasi.com` CNAME → `<tunnel-id>.cfargotunnel.com`（proxied，经 cert.pem 凭据调 API 创建） |

部署过程备注：本机直连 `api.cloudflare.com` 超时（大陆网络常态，cloudflared API 客户端也不走系统代理），
实际经系统代理 7897 + cert.pem 内置凭据直调 Cloudflare API 完成建隧道与 DNS 记录；
首次 `cloudflared tunnel create` 虽超时报错但云端已建出同名隧道，二次执行复用（409 → list 复用），无重复资源。

## 二、验收实测（2026-11-01）

| 项 | 结果 |
| --- | --- |
| 本地服务 | `curl 127.0.0.1:7280/` 200；main.js/three/d3/css 均 200，`.js` 返回 `text/javascript`（ES module 可加载） |
| DNS | `dig +short ppt.ybkkasi.com @1.1.1.1` → 104.21.34.51 / 172.67.198.140（Cloudflare 代理） |
| 公网可达 | 经代理访客视角 `https://ppt.ybkkasi.com/` 200（≈2s 首字节），四类静态资源全 200 |
| 隧道连接 | ybkk-ppt 已注册 ≥2 条边缘连接（lax01/lax13，http2） |
| 真浏览器 | 1440×900 打开公网域名：标题正确；three.js 粒子画布渲染；d3 业务架构图 13 节点 + 检查器在位；七步闭环、14 行业图谱完整；导航高亮正常 |

## 三、已知边界与运维口径（诚实记录）

1. **依赖本机在线**：本页与 demo.ybkkasi.com 同为隧道回源本机模式，Mac 关机/断网页面不可达。
   若需不依赖本机的形态，后续可在 Cloudflare 侧换 Pages/静态托管（ybkk.ybkkasi.com 先例），DNS 记录改指即可。
2. **大陆直连波动**：Cloudflare 免费边缘在大陆网络下直连偶发 7-12s/超时（与 demo 子域同一边缘，
   属网络路径问题非本部署缺陷）；有代理或正常国际网络的访客体验稳定。
3. **无写入口**：python http.server 纯只读、仅监听回环；隧道兜底 404，不暴露任何其他本机端口。
4. **升级口径**：内容更新 = 覆盖 `~/ybkk-lab/ppt-site/` 目录文件即可，无需重启任何服务
   （http.server 每请求现读磁盘）；改 `config-ppt.yml` 后需 `launchctl kickstart -k gui/$(id -u)/com.cloudflare.tunnel-ppt`。
5. **回滚**：`launchctl bootout gui/$(id -u)/com.cloudflare.tunnel-ppt` +
   `launchctl bootout gui/$(id -u)/com.ybkk.ppt-site` + 删两个 plist、config-ppt.yml、站点目录，
   再经 API 删 DNS 记录与隧道即净。

## 四、复验速查

```bash
# 本地与公网
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7280/
curl -s -o /dev/null -w '%{http_code}\n' https://ppt.ybkkasi.com/   # 大陆直连慢时走代理复核
# 隧道状态
launchctl list | grep -E "tunnel-ppt|ppt-site"
tail -5 ~/Library/Logs/tunnel-ppt.err.log
# DNS
dig +short ppt.ybkkasi.com @1.1.1.1
```
