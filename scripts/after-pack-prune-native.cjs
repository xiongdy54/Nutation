"use strict";
// D274 / v49.108：按目标平台/架构裁剪原生预编译二进制。
//
// 为什么用 afterPack 而不是平台级 `files`：
// electron-builder 26 的 getFileMatchers 会把平台级 `files` 字符串并入 defaultMatcher；
// 当顶层 `files` 已被 normalizeFiles 转成 FileSet 对象时，defaultMatcher 会成为 matchers[0]
// 且只含 ignore 模式，getMainFileMatchers 于是追加 `**/*`，把整个仓库打进 asar（实测 2.37 GB）。
// 因此平台差异只能在打包后处理：app.asar.unpacked 里的 *.node 本来是 asarUnpack 真实文件，
// 直接删除非目标项即可，运行时只会 require 当前 platform/arch 的那一个。
// 资源目录经 packager.getResourcesDir() 解析：win/linux 是 <appOutDir>/resources，
// macOS 是 <appOutDir>/<ProductName>.app/Contents/Resources（不能硬编码 resources/）。
//
// 保留规则：
//   win32  → prebuilds/win32-<arch>.node        + fsrs-rs-nodejs-win32-<arch>-*
//   darwin → prebuilds/darwin-<arch>.node       + fsrs-rs-nodejs-darwin-<arch>-*
//   linux  → prebuilds/linux-<arch>.node
//            prebuilds/linuxmusl-<arch>.node    + fsrs-rs-nodejs-linux-<arch>-*（gnu / musl 都留）
// universal 构建不裁（保留全部，避免误删）。
const fs = require("fs");
const path = require("path");

// builder-util 的 Arch 枚举：ia32=0, x64=1, armv7l=2, arm64=3, universal=4
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function platformName(context) {
  if (context && context.electronPlatformName) return context.electronPlatformName;
  const p = context && context.packager && context.packager.platform;
  return (p && p.nodeName) || "";
}

function archName(context) {
  const a = context && context.arch;
  if (typeof a === "string") return a;
  return ARCH_NAMES[a] || "";
}

function keepPrebuilds(platform, arch) {
  if (!platform || !arch || arch === "universal") return null;
  if (platform === "win32") return new Set([`win32-${arch}.node`]);
  if (platform === "darwin") return new Set([`darwin-${arch}.node`]);
  if (platform === "linux") return new Set([`linux-${arch}.node`, `linuxmusl-${arch}.node`]);
  return null;
}

// macOS 的 resources 目录不在 <appOutDir>/resources，而在
// <appOutDir>/<ProductName>.app/Contents/Resources；优先用 electron-builder
// 自己的 getResourcesDir（win/linux = resources，mac = .app/Contents/Resources）。
function resourcesDir(context) {
  const packager = context && context.packager;
  if (packager && typeof packager.getResourcesDir === "function") {
    return packager.getResourcesDir(context.appOutDir);
  }
  if (platformName(context) === "darwin") {
    const productFilename =
      (packager && packager.appInfo && packager.appInfo.productFilename) || "Nutation";
    return path.join(context.appOutDir, `${productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

function pruneNative(context) {
  const platform = platformName(context);
  const arch = archName(context);
  const keep = keepPrebuilds(platform, arch);
  const removed = [];
  if (!keep) return { removed, platform, arch, skipped: !keep };

  const modulesDir = path.join(resourcesDir(context), "app.asar.unpacked", "node_modules");

  // 1) better-sqlite3：binding.js 只按 process.platform / process.arch 选一个文件。
  const prebuildDir = path.join(modulesDir, "better-sqlite3", "prebuilds");
  try {
    for (const name of fs.readdirSync(prebuildDir)) {
      if (name.endsWith(".node") && !keep.has(name)) {
        fs.rmSync(path.join(prebuildDir, name), { force: true });
        removed.push(`better-sqlite3/prebuilds/${name}`);
      }
    }
  } catch {
    // 目录不存在（非 NAPI 打包路径）——无事可做
  }

  // 2) fsrs-rs-nodejs：CI 为跨架构出包会同时安装 x64 / arm64 两套平台包。
  try {
    for (const name of fs.readdirSync(modulesDir)) {
      if (!name.startsWith("fsrs-rs-nodejs-")) continue;
      if (!name.includes(`${platform}-${arch}`)) {
        fs.rmSync(path.join(modulesDir, name), { recursive: true, force: true });
        removed.push(name);
      }
    }
  } catch {
    // 同上
  }

  return { removed, platform, arch, skipped: false };
}

module.exports = async function afterPack(context) {
  const result = pruneNative(context);
  if (result.skipped) {
    console.log(`[after-pack-prune-native] ${result.platform || "?"}/${result.arch || "?"}：跳过（universal 或未知平台）`);
    return;
  }
  console.log(
    `[after-pack-prune-native] ${result.platform}/${result.arch}：移除 ${result.removed.length} 项` +
      (result.removed.length ? `（${result.removed.join(", ")}）` : "")
  );
};
module.exports.pruneNative = pruneNative;
