// v49.171 / D341：无障碍支持开关（设置键 app.accessibilitySupport）——取值归一与启动参数的唯一实现面。
// 背景：常驻的无障碍（UI Automation）客户端会持续查询应用的无障碍树，Chromium 在主进程 UI 线程上
// 按整章正文 DOM 应答（每次 100–330 ms、约 0.6 s 一次），阅读滚动因此卡顿。运行期
// app.setAccessibilitySupportEnabled(false) 会被外部客户端随即重新打开，只能用启动参数关闭。
// 默认关闭；仅严格 true 为开。启动参数只在启动时生效——改设置后须重启。
// 渲染层读侧默认显示同规：src/components/SettingsPanel.tsx AccessibilityRow（改默认值两处必须同步）。
"use strict";

const DISABLE_SWITCH = "disable-renderer-accessibility";

function accessibilitySupportEnabled(raw) {
  return raw === true;
}

/**
 * 在 app ready 之前调用：设置为关闭时追加 --disable-renderer-accessibility。
 * @param {{ appendSwitch(name: string): void }} commandLine  Electron app.commandLine（测试可注入）
 * @param {() => any} readSettings  读 settings.json 的整份对象；读取失败按默认（关闭）处理
 * @returns {boolean} 是否追加了参数
 */
function applyAccessibilitySwitch(commandLine, readSettings) {
  let raw;
  try {
    raw = readSettings()?.app?.accessibilitySupport;
  } catch {
    raw = undefined;
  }
  if (accessibilitySupportEnabled(raw)) return false;
  commandLine.appendSwitch(DISABLE_SWITCH);
  return true;
}

module.exports = { accessibilitySupportEnabled, applyAccessibilitySwitch, DISABLE_SWITCH };
