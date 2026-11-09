# 预言鲸 · 后端（server/）

Cloudflare Workers + D1 + Cron Triggers。接口契约见 `../docs/CONTRACT.md`（第 5–12 节）。

## 目录

```text
server/
  src/
    index.ts           # fetch 路由 + scheduled（结算 / 月度归档）
    platform-auth.ts   # 平台 JWT 验签（原生 WebCrypto + JWKS 模块级缓存）
    cors.ts            # 精确 origin 白名单、预检放行、错误响应带 CORS
    db.ts              # D1 helpers、config 热读、用户初始化、Asia/Shanghai 日期
    settle.ts          # 结算引擎（纯计算 + D1 写入分离）
    routes/public.ts   # /public/*
    routes/me.ts       # /me*（claim、positions、history、rank）
    routes/bets.ts     # POST /bets（幂等 + 同 batch 扣款）
    routes/admin.ts    # /admin/*（常量时间 token 比较、audit）
  migrations/0001_init.sql
  test/
```

## 配置

### secrets（`wrangler secret put`）

| 名称 | 说明 |
| ---- | ---- |
| `DEEPSEEK_API_KEY` | 调 `https://api.deepseek.com/models` |
| `ADMIN_TOKEN` | 管理 API Bearer token，至少 32 随机字符 |
| `PLATFORM_ISSUER` | 例如 `https://linux.do` |
| `PLATFORM_APP_ID` | 与 manifest `id` 一致 |

### vars（`wrangler.jsonc` 或 dashboard）

| 名称 | 默认 |
| ---- | ---- |
| `PLATFORM_AUDIENCE` | `<API_ORIGIN>`（JWT `aud`，不要用请求 Host） |
| `ALLOWED_ORIGINS` | `https://linux.do`（逗号分隔） |
| `DEEPSEEK_MODELS_URL` | `https://api.deepseek.com/models` |

本地开发把上述值写进 `.dev.vars`（已 gitignore，不要提交）：

```ini
DEEPSEEK_API_KEY=sk-xxx
ADMIN_TOKEN=本地随意但保持 32 位以上
PLATFORM_ISSUER=https://linux.do
PLATFORM_APP_ID=<APP_ID>
PLATFORM_AUDIENCE=http://localhost:8787
ALLOWED_ORIGINS=http://localhost:5173,https://linux.do
```

## D1 创建与迁移

```sh
npx wrangler d1 create whale          # 把返回的 database_id 填入 wrangler.jsonc
bun run db:migrate:local              # 本地
bun run db:migrate:remote             # 远端（需登录）
```

## 本地运行

```sh
bun install
bun run dev                           # wrangler dev --test-scheduled
curl http://localhost:8787/public/config
curl http://localhost:8787/public/markets
```

## Cron 测试

```sh
# 每 10 分钟的结算 tick
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*/10+*+*+*"
# 每月 1 日的归档维护
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=10+0+1+*+*"
```

结算数据源拉取失败时只记录日志，不结算。

## 验证

```sh
bun run typecheck
bun test
```

测试基于 WebCrypto 自签 P-256 token 与内存 SQLite（D1 shim），不依赖外部服务。

## 管理 API（curl 示例）

```sh
T="你的 ADMIN_TOKEN"
H="Authorization: Bearer $T"

# 配置
curl -s -H "$H" https://<API_ORIGIN>/admin/config
curl -s -X PATCH -H "$H" -H 'Content-Type: application/json' \
  -d '{"bet_min": "20", "daily_chips": "150"}' \
  https://<API_ORIGIN>/admin/config

# 创建市场
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{
    "id": "m_v5_2026",
    "title": "V5 在 2026 年底前出现？",
    "description": "以官方 /models 的 name 字段为准。",
    "condition": { "kind": "name_regex", "regex": "DeepSeek[- ]?V5", "flags": "i" },
    "deadline": 1798732799000,
    "seedYes": 5000,
    "seedNo": 5000
  }' \
  https://<API_ORIGIN>/admin/markets

# 锁定 / 改截止
curl -s -X PATCH -H "$H" -H 'Content-Type: application/json' \
  -d '{"status": "locked"}' \
  https://<API_ORIGIN>/admin/markets/m_v5_2026

# 手动结算
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"outcome": "yes", "reason": "manual"}' \
  https://<API_ORIGIN>/admin/markets/m_v5_2026/settle

# 回滚（仅 settled 且无派奖，需 force）
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"force": true}' \
  https://<API_ORIGIN>/admin/markets/m_v5_2026/reopen

# 统计 / 保留策略清理 / 审计
curl -s -H "$H" https://<API_ORIGIN>/admin/stats
curl -s -X POST -H "$H" https://<API_ORIGIN>/admin/maintenance
curl -s -H "$H" "https://<API_ORIGIN>/admin/audit?limit=20"
```

## 安全注意

- 身份一律取 JWT `(iss, sub)`，绝不信任 body 的 `user_id`。
- 管理失败返回 401，不回显 token；比较为常量时间。
- 日志不输出 `Authorization`、`mini_app_token`、`DEEPSEEK_API_KEY`、`ADMIN_TOKEN`。
- `.dev.vars`、`node_modules`、`.wrangler/` 已在 gitignore，不要提交。
