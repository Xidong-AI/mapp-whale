import type { MiniAppManifest } from "@discourse-mini-app/sdk/pack";
import { pack } from "@discourse-mini-app/sdk/pack";
import { copyFile, readFile, writeFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile("manifest.json", "utf8")
) as MiniAppManifest & { endpoints?: Record<string, { url: string }> };

// The single source of truth for the API origin lives in src/config.ts.
const configSource = await readFile("src/config.ts", "utf8");
const configured =
  /export\s+const\s+API_ORIGIN\s*=\s*"([^"]+)"/.exec(configSource)?.[1];
const origin = (
  process.env.MINI_APP_API_ORIGIN?.trim() ||
  configured ||
  "https://whale-api.example.com"
).replace(/\/+$/, "");

if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) {
  throw new Error(`API origin must be a plain https origin: ${origin}`);
}

const defaultOrigin = "https://whale-api.example.com";
const sourceOrigin = configured || defaultOrigin;
const destination = new URL(origin);
for (const endpoint of Object.values(manifest.endpoints ?? {})) {
  const url = new URL(endpoint.url);
  url.protocol = destination.protocol;
  url.host = destination.host;
  endpoint.url = url.toString();
}

// The IIFE keeps API_ORIGIN for the dev-only fetch transport; keep it in sync too.
const bundlePath = "dist/web/app.js";
const bundle = await readFile(bundlePath, "utf8");
if (origin !== sourceOrigin) {
  await writeFile(bundlePath, bundle.split(sourceOrigin).join(origin));
}

manifest.id = process.env.MINI_APP_ID || manifest.id;
manifest.version = process.env.MINI_APP_VERSION || manifest.version;

await copyFile("src/template.html", "dist/web/index.html");
await copyFile("src/strings.json", "dist/web/strings.json");

const files: Record<string, Buffer> = {};
for (const name of ["index.html", "app.js", "app.css", "strings.json"]) {
  files[name] = await readFile(`dist/web/${name}`);
}
for (const path of manifest.assets || []) {
  if (
    !/^[a-zA-Z0-9_.\-/]{1,160}$/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid package asset path");
  }
  files[path] = await readFile(`dist/web/${path}`);
}

const result = await pack({
  manifest,
  files,
  outputDirectory: "dist/package",
});
console.log(
  `Created ${result.file} (${result.size} bytes), app ${manifest.id}, version ${manifest.version}, API ${origin}`
);
