# 预言鲸

Linux.do 微应用（mapp）：拖动滑块预测 DeepSeek 下一代模型。

- 前端：Bun + Vite + TypeScript，单 IIFE，运行在 mapp 沙箱。
- 后端：Cloudflare Workers + D1 + Cron Triggers。
- 结算：定时拉取 `https://api.deepseek.com/models`，按市场条件匹配 `name` 等字段，连续命中后自动结算；截止未命中判「否」，管理端可手动覆盖。

## 目录

```text
mapp-whale/
  app/      前端（Bun + Vite + mapp SDK）
  server/   后端（Cloudflare Workers + D1）
  docs/     契约与 API 文档
```

## 快速开始

### 后端

```sh
cd server
bun install
bunx wrangler d1 create whale
# 把输出里的 database_id 填进 wrangler.jsonc
bunx wrangler d1 migrations apply whale --local
bunx wrangler secret put DEEPSEEK_API_KEY
bunx wrangler secret put ADMIN_TOKEN
bunx wrangler secret put PLATFORM_ISSUER
bunx wrangler secret put PLATFORM_APP_ID
bunx wrangler dev
```

部署与配置细节见 `server/README.md`。

### 前端

```sh
cd app
bun install
bun run dev
```

构建并打包：

```sh
bun run build
# 产物：dist/package/app.zip
```

把 `src/config.ts` 的 `API_ORIGIN` 和 `manifest.json` 的 `id` 换成真实值，再上传 `app.zip` 到社区应用沙箱。

## 配置

所有可调参数都在 D1 的 `config` 表，通过管理 API 修改，不需要改代码：

```sh
curl -X PATCH https://<API_ORIGIN>/admin/config \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"daily_chips":200,"seed_per_side":8000}'
```

完整 API 与数据模型见 `docs/CONTRACT.md`。

## 开发检查与 CI

- 安装钩子：`scripts/install-hooks.sh`。commit-msg 校验提交规范，pre-commit 拦截敏感文件/超大文件并跑 autocorrect，pre-push 跑前后端 typecheck 与测试。
- CI：`.github/workflows/ci.yml`，包含提交规范、前端 typecheck/test/build、后端 typecheck/test。
- 提交标题格式：`【类型[，范围]】摘要`，类型为 初始/更改/新增/修复/格式/文档/测试/维护，摘要不超过 30 字。

## 文档

- `docs/CONTRACT.md`：前后端唯一契约（数据模型、API、结算、缓存、保留策略）。
