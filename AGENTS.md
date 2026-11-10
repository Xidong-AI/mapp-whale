# 预言鲸 · Agent 约定

## 前端版本号

- 每次修改 `app/` 并准备上传新包时，先提升 `app/manifest.json` 的 `version`，并同步 `app/package.json`。
- `version` 必须是 `x.y.z` 三段纯数字，不能带前导零或 `-rc` 等后缀；正式发布必须高于历史最高正式版本。
- 平台按 ZIP 的完整 SHA-256 判重：内容相同会报 `BUILD_EXISTS`，即使版本号相同或构建已过期。改版本号或改包内容后重新打包。
- 只改后端或文档时不必提升前端版本，除非你要重新上传前端包。

## 构建自检

```sh
cd app
MINI_APP_ID=01a1c002-2ff0-7bf9-aeb7-bc25e4e6cbb0 \
MINI_APP_VERSION=<x.y.z> \
MINI_APP_API_ORIGIN=https://mapp-whale.pj568.eu.org \
bun run build
unzip -p dist/package/app.zip manifest.json
sha256sum dist/package/app.zip
```

上传前确认 `id`、`version`、`permissions` 与预期一致，并记录 SHA-256。
