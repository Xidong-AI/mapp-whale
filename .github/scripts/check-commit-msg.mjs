#!/usr/bin/env node
// 校验 PJ568 提交规范：标题格式【类型[，范围]】摘要，摘要 ≤30 字。
// 用法：
//   node check-commit-msg.mjs <msg-file>        # commit-msg hook
//   node check-commit-msg.mjs --range A..B      # CI 校验区间
//   node check-commit-msg.mjs --all             # 校验全部提交

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TYPES = ["初始", "更改", "新增", "修复", "格式", "文档", "测试", "维护"];
const TITLE_RE = new RegExp(
  `^【(${TYPES.join("|")})(，[^】\\n]{1,20})?】(.{1,30})$`,
  "u"
);

function checkOne(message, source) {
  const title = (message.split(/\r?\n/)[0] ?? "").trim();
  if (!title) return `${source}: 提交信息为空`;
  if (/^Merge /i.test(title) || /^Revert /i.test(title)) return null;
  if (/^Initial commit$/i.test(title)) return null;

  const match = title.match(TITLE_RE);
  if (!match) {
    return `${source}: 标题不符合【类型[，范围]】摘要：${title}`;
  }
  const summary = match[3];
  if ([...summary].length > 30) {
    return `${source}: 摘要超过 30 字：${summary}`;
  }
  return null;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function checkRange(range) {
  let hashes;
  try {
    hashes = git(["rev-list", "--no-merges", range])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    hashes = git(["rev-list", "--no-merges", "HEAD"])
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  return hashes.map((hash) => {
    const message = git(["log", "-1", "--format=%B", hash]);
    return checkOne(message, hash.slice(0, 8));
  });
}

function checkAll() {
  return checkRange("HEAD");
}

const args = process.argv.slice(2);
let errors = [];

if (args[0] === "--range" && args[1]) {
  errors = checkRange(args[1]);
} else if (args[0] === "--all") {
  errors = checkAll();
} else if (args[0]) {
  errors = [checkOne(readFileSync(args[0], "utf8"), args[0])];
} else {
  console.error("用法：check-commit-msg.mjs <msg-file> | --range A..B | --all");
  process.exit(2);
}

errors = errors.filter(Boolean);
if (errors.length > 0) {
  console.error("提交规范检查未通过：");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log("提交规范检查通过");
