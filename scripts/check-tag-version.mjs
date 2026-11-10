#!/usr/bin/env node
// D274 / v49.108：发布前置校验——Git tag 必须与 package.json version 一致。
//
// 为什么需要：electron-updater 的版本比对真源是打包进 app 的 package.json `version`，
// 而 GitHub Release 的 tag / latest.yml 版本来自构建时的 tag。两者不一致时，客户端会
// 永远认为“已是最新”或反复提示同一版本。CI 在 tag 推送时先跑本脚本，fail fast。
//
// 用法：
//   node scripts/check-tag-version.mjs            # 读 GITHUB_REF_TYPE / GITHUB_REF_NAME
//   node scripts/check-tag-version.mjs v0.0.1     # 本地显式校验某个 tag
// 非 tag 构建（workflow_dispatch / 本地手动）直接跳过，退出码 0。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const explicitTag = process.argv[2] || "";
const refType = process.env.GITHUB_REF_TYPE || (explicitTag ? "tag" : "");
const refName = process.env.GITHUB_REF_NAME || explicitTag;

if (refType !== "tag") {
  console.log(`[check-tag-version] 非 tag 构建（${refType || "manual"}），跳过校验`);
  process.exit(0);
}

if (!refName) {
  console.error("[check-tag-version] 缺少 GITHUB_REF_NAME（或命令行 tag 参数）");
  process.exit(1);
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
if (!versionPattern.test(String(pkg.version || ""))) {
  console.error(`[check-tag-version] package.json version 非法：${JSON.stringify(pkg.version)}`);
  process.exit(1);
}

const expected = `v${pkg.version}`;
if (refName !== expected) {
  console.error(
    `[check-tag-version] tag 与 package.json version 不一致：tag=${refName}，package.json=${pkg.version}。\n` +
      `请把 package.json 的 version 改为 ${refName.replace(/^v/, "")} 后重新提交并打 tag，或使用 tag ${expected}。`
  );
  process.exit(1);
}

console.log(`[check-tag-version] OK：tag ${refName} == package.json version ${pkg.version}`);
