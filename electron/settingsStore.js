// settings.json 读写（唯一实现：main.js 的 settings:* IPC、db.js、优化器等均经此）
// C-15：原 main.js 自带一份 readSettings/writeSettings 与本文分叉，现合并到 electron/jsonFile.js——
// BOM 容忍、损坏留档（最近 5 份）、原子写 + fsync 由底层统一。
// C-40a（审计：业务核心与 Node/Electron 解耦）：路径惰性化——模块加载不再触碰 electron（纯 Node
// 宿主可加载）；桌面态首次访问时回落 Electron userData（首次即定格，与解耦前「模块加载期固化」
// 等价——main.js 的 pinUserData/M7_TEST_USERDATA setPath 均先于 require）；注入宿主经 configure()。
const path = require("path");
const { readJsonObject, writeJsonAtomic } = require("./jsonFile");

let settingsFile = null;
function configure({ dataDir }) { settingsFile = path.join(dataDir, "settings.json"); }
function file() {
  if (!settingsFile) settingsFile = path.join(require("electron").app.getPath("userData"), "settings.json");
  return settingsFile;
}

// 审计 E-7（D285）：进程内缓存，以 (mtimeMs, size) 为键——每次仍 stat 一次以感知外部改动（手改 settings.json、
// 恢复备份），但命中时省掉整文件读 + JSON 解析（readSettings 有 40+ 调用点，部分在批量路径上）。
// 返回值一律 structuredClone：调用方普遍「读出来改一改再 writeSettings」，绝不能把缓存对象交出去被就地改。
// 所有窗口的设置读写都经主进程 IPC 走本模块，故进程内缓存不存在跨窗口陈旧；写入后立即以新 stat 回填缓存。
let cache = null; // { file, mtimeMs, size, value }
function statKey(f) {
  try {
    const st = require("fs").statSync(f);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function readSettings() {
  const f = file();
  const key = statKey(f);
  if (key && cache && cache.file === f && cache.mtimeMs === key.mtimeMs && cache.size === key.size) {
    return structuredClone(cache.value);
  }
  const value = readJsonObject(f, () => ({ app: {}, theme: {} }));
  const after = statKey(f); // 损坏留档会改名原文件 → after 为 null，不缓存
  cache = key && after && after.mtimeMs === key.mtimeMs && after.size === key.size
    ? { file: f, ...key, value: structuredClone(value) }
    : null;
  return value;
}

// 审计 C-8（F43 P0-4）：settings.json 带数值格式版本键，让未来版本能识别这份文件由哪一代格式写成。
// 只在缺失 / 非数值时补当前值；已有更大的数（更新版本写的）原样保留，绝不降级。
const SETTINGS_FORMAT_VERSION = 1;
function stampFormatVersion(all) {
  if (!all || typeof all !== "object" || Array.isArray(all)) return all;
  return typeof all.version === "number" ? all : { ...all, version: SETTINGS_FORMAT_VERSION };
}

function writeSettings(all) {
  const f = file();
  cache = null;
  all = stampFormatVersion(all);
  writeJsonAtomic(f, all);
  const key = statKey(f);
  if (key) cache = { file: f, ...key, value: JSON.parse(JSON.stringify(all)) }; // 与落盘内容同形（JSON 往返）
}

/** 测试用：清空进程内缓存 */
function _resetSettingsCache() { cache = null; }

module.exports = { get SETTINGS_FILE() { return file(); }, configure, readSettings, writeSettings, _resetSettingsCache };
