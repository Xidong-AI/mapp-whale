# 预言鲸 · 提审与发布清单

## 1. 应用信息

- 名称：预言鲸
- 用途：以虚拟鲸珠预测 DeepSeek 下一代模型的发布时间与规格，提供市场、彩池、排行榜与赛季玩法。
- 说明：拖动滑块表达看涨/看跌强度，小鲸鱼随强度进化；结果由 `https://api.deepseek.com/models` 的 `name` 字段自动判定。
- 图标：应用页上传（建议深海蓝底 + 荧光青鲸鱼）。
- 讨论主题：应用页填写。

## 2. 权限用途

| 权限              | 用途                                   |
| ----------------- | -------------------------------------- |
| `user.read`         | 读取当前用户 ID 与昵称，用于身份和下注 |
| `network.request`   | 调用自有后端 API                       |
| `storage.read`      | 读取本地缓存的市场、榜单和草稿         |
| `storage.write`     | 写入本地缓存与未提交草稿               |
| `theme.read`        | 跟随论坛深浅色主题                     |

未申请剪贴板、全屏、媒体、文件、外链等未使用权限。

## 3. 网络端点

后端运营方：PJ568（自有 Cloudflare Worker）。

正式地址：`https://mapp-whale.pj568.eu.org`

| 端点                    | 方法 | auth     | 用途                       |
| ----------------------- | ---- | -------- | -------------------------- |
| `/public/config`          | GET  | none     | 产品配置、赛季、限额       |
| `/public/markets`         | GET  | none     | 市场列表与详情             |
| `/public/leaderboard`     | GET  | none     | 总资产榜 / 命中率榜        |
| `/me`                     | GET  | platform | 当前用户与鲸珠余额         |
| `/me/claim`               | POST | platform | 每日鲸珠补给               |
| `/me/positions`           | GET  | platform | 当前持仓                   |
| `/me/history`             | GET  | platform | 历史预测                   |
| `/me/rank`                | GET  | platform | 本人排名                   |
| `/bets`                   | POST | platform | 提交预测                   |

受保护端点使用平台 JWT：

- 服务端固定从 `https://linux.do/mini-app-api/jwks` 获取公钥，不信任请求里的 `iss`、`jku`、`jwk`、`x5u`。
- 校验 `iss`、`aud`、`app_id`、`channel`、`scopes`、`htm`、`htu`、`query_keys`、`nbf`、`exp`。
- 身份只取 `(iss, sub)`，正文里的 `user_id` 一律忽略。
- JWT 缺失或无效返回 401；业务权限不足返回 403；不回退 Cookie 鉴权。
- 写操作按 `(user_key, client_request_id)` 幂等，扣款、加池、插注同一 D1 batch。

响应示例：

```jsonc
// GET /public/config
{ "ok": true, "data": { "productName": "预言鲸", "season": "2026-11", "betMin": 10, "maxBetRatio": 0.5, "dailyChips": 100, "initialChips": 1000, "pageSize": 20, "accuracyMinSamples": 5 } }

// GET /public/markets
{ "ok": true, "data": { "items": [ { "id": "m_v5_2026", "title": "V5 在 2026 年底前出现？", "status": "open", "yesPool": 0, "noPool": 0, "impliedYes": 0.5, "participantCount": 0 } ], "nextCursor": null } }
```

## 4. 数据与沙箱隔离

- 正式数据存于 D1 `whale`。
- 沙箱构建使用 `channel = sandbox` 的 JWT；服务端只允许读取与登录验证，写操作返回 `SANDBOX_READONLY`，不会写入正式彩池、用户余额或排行榜。
- 沙箱只用于作者和审核员验证界面、登录态与只读流程；正式版才允许提交预测和领取鲸珠。

## 5. 可重复操作步骤

1. 打开应用，匿名可浏览市场与排行榜。
2. 登录 Linux.do 后重新打开应用。
3. 在「市场」选择任意市场，拖动滑块到看涨或看跌，输入鲸珠数量，点「确认预测」。
4. 在「我的」查看鲸珠余额、持仓与历史；点「领取」获得每日补给。
5. 在「排行榜」切换总资产 / 命中率与赛季。

## 6. 版本与打包

```sh
cd app
bun install --frozen-lockfile
MINI_APP_ID=<应用页分配的 UUIDv7> MINI_APP_VERSION=1.0.0 bun run build
```

产物：`dist/package/app.zip`。只上传该 ZIP，不上传项目目录或 `package.json`。

打包脚本会拒绝占位 ID；本地测试可显式设 `MINI_APP_ALLOW_PLACEHOLDER_ID=1`，但该产物不能上传。

## 7. 提审前自查

- [ ] `manifest.json` 的 `id` 是应用页分配的 UUIDv7，版本为三段数字。
- [ ] ZIP 由 `@discourse-mini-app/sdk` 的 `pack` 生成，无额外文件、无秘密。
- [ ] 首屏调用 `lifecycle.ready()`；游客、权限拒绝、API 失败都有可见反馈。
- [ ] HTTP 服务配置 CORS；JWT 缺失或无效返回 401。
- [ ] 手机、桌面、深浅主题、缓存恢复、重新打开均可用。
- [ ] 沙箱中检查的是本次版本和同一份 ZIP。
- [ ] 沙箱构建 7 天内有效；正式发布版本必须高于已发布最高版本。
- [ ] 相同 SHA-256 的 ZIP 不能重复提交（`BUILD_EXISTS`），改内容或升版本后重打。

## 8. 常见拒绝

| 现象                | 原因                        | 处理                     |
| ------------------- | --------------------------- | ------------------------ |
| `APP_ID_MISMATCH`     | manifest `id` 与应用页不一致  | 原样复制应用页 ID        |
| `BUILD_EXISTS`        | 相同 ZIP 提交过               | 改内容或升版本           |
| 首屏空白            | 未调用 `lifecycle.ready()`    | 首次渲染后调用一次       |
| 权限被驳回          | 申请了未使用的权限          | 只保留实际使用的权限     |
| 端点被驳回          | 指向无权运营的服务          | 使用自有域名并说明归属   |
| 沙箱构建消失        | 超过 7 天                   | 重新打包上传             |
