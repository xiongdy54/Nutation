// 独立制卡台窗口（v48.79 / D123）——全局快捷键 / 托盘菜单呼出的单例窗口：
// 手动制卡 + AI 制卡 + AI 解释同一套面板（渲染入口 workbench.html → src/workbench.tsx，复用主 preload 的全部桥）。
// 纪律：① 关闭＝隐藏（单例复用，真正退出才销毁）；② 首次呼出贴近鼠标所在屏幕右缘，之后保留用户拖到的位置；
// ③ 默认置顶（边读别的材料边制卡），可在窗口内切换；④ 就绪后才 show（杜绝白闪）。
const { BrowserWindow, screen, app, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const { loadAppPage } = require("./devServer"); // D239：载入顺序 + dev server 地址唯一来源
const appLog = require("./appLog"); // D260：载入失败/渲染进程消失落到主日志（否则只剩一片白窗，无迹可查）

let win = null;
let ctx = null;
let quitting = false;
let pinned = true;
let positioned = false;
let pendingShow = false;
let pendingShowTimer = null;
let loaded = false;
let loadRetried = false; // D260：主框架载入失败只自动重试一次，之后收起挂起请求、不再弹白窗
// v49.95（D261）：图片挖空编辑器需要宽幅——进入时把独立制卡台展开为固定宽窗，退出后收回原宽度。
// Windows 的 setBounds 没有原生动画（Electron 的 animate 仅 macOS），用主进程定时器逐帧插值；
// 右缘锚定，窗口靠屏幕右缘（默认呼出位置）时向左展开，不跑出工作区。
const WIDE_WIDTH = 1200; // 右栏 300 + 工具条完整展开（约 700）+ 两侧留白
const RESIZE_MS = 600; // 窗口位移大（480→1200，720px），时长要够长：峰值速度与时长成反比，太短就是「一冲而过」
const RESIZE_MAX_HZ = 75; // 出帧频率上限：setBounds 同步重排要 2–9ms，高刷屏全速出帧会把主线程占满
const RESIZE_MARGIN = 24;
let wideState = null; // { win, restoreWidth }
let resizeAnim = null; // { timer, win }
let resizeWaiters = []; // 等动画落位的 IPC 调用（渲染层据此在窗口到位后再淡入编辑器）

/** 挂起中的呼出请求作废（hide 后写优先 / 窗口销毁时清理） */
function cancelPendingShow() {
  pendingShow = false;
  if (pendingShowTimer != null) {
    clearTimeout(pendingShowTimer);
    pendingShowTimer = null;
  }
}

/** 消费一次挂起的呼出（ready-to-show / did-finish-load / 安全阀三路共用，幂等） */
function consumePendingShow() {
  if (!pendingShow) return;
  pendingShow = false;
  if (pendingShowTimer != null) {
    clearTimeout(pendingShowTimer);
    pendingShowTimer = null;
  }
  reveal();
}

function themeBackground() {
  try {
    const mode = ctx?.readSettings?.()?.theme?.mode;
    // C-37："system" 档按主进程 nativeTheme 解析（保证新开/呼出时窗口底色与解析后的主题一致、无白闪）；
    // 未知值维持既有回落浅色（渲染层 resolveThemeMode 对未知值按系统解析，主进程读不到设置时保守回落）。
    const dark = mode === "dark" || (mode === "system" && nativeTheme.shouldUseDarkColors);
    return dark ? "#111111" : "#fafaf8";
  } catch {
    return "#fafaf8";
  }
}

function createWindow() {
  if (win && !win.isDestroyed()) return win;
  loaded = false;
  loadRetried = false;
  win = new BrowserWindow({
    width: 480,
    height: 780,
    minWidth: 400,
    minHeight: 520,
    frame: false,
    show: false,
    title: "制卡台",
    icon: process.platform === "win32" ? path.join(__dirname, "icon.ico") : path.join(__dirname, "icons", "icon-light.png"), // C-28：非 Windows 用 PNG（ico 只有 Windows 认；与主窗口 icons/ PNG 同目录）
    alwaysOnTop: pinned,
    backgroundColor: themeBackground(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: ["--bdi-role=workbench"] // D248：BDI 桥按窗口角色裁剪（T5）
    }
  });
  const w = win;
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.on("closed", () => {
    if (win === w) win = null;
    if (wideState && wideState.win === w) wideState = null;
    stopResizeAnim();
    flushResizeWaiters();
    loaded = false;
    cancelPendingShow();
  });
  // 导航防护（与主窗口同规则）
  w.webContents.on("will-navigate", (event, url) => {
    if (url.split("#")[0] === w.webContents.getURL().split("#")[0]) return;
    event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // 每次开始加载都复位 loaded（v201）：语义＝「当前这份文档已可显示」。旧实现只在新建窗口时
  // 复位，页面 reload（vite 重启 full-reload / 断连重连自动刷新）后 loaded 保持陈旧 true，
  // show() 只能靠 isLoading() 兜底，挂起的呼出请求就此失去消费者（D200 同构缺陷）。
  w.webContents.on("did-start-loading", () => {
    loaded = false;
  });
  // 就绪即消费挂起的呼出。旧实现是 once——监听器首次加载后即被消耗，之后任何「加载中 show()」
  // 挂起的 pendingShow 永远无人消费（全局快捷键 / 托盘呼出同样中招）。改 on + 幂等消费。
  w.on("ready-to-show", () => {
    loaded = true;
    consumePendingShow();
  });
  // v201：兜底消费挂起的呼出——ready-to-show 偶发不触发（隐藏窗 reload）时，加载完成本身就是
  // 「可显示」信号；consumePendingShow 内部走 reveal，`win:workbenchShown` 随 reveal 自然补发，
  // 渲染层同步语义不变。
  w.webContents.on("did-finish-load", () => {
    consumePendingShow();
  });
  // D260：载入失败要可见、可恢复——失败一次自动重试；再失败就收起挂起请求，只留日志与白窗兜底，
  // 不再让「2s 安全阀」把一片空白显示出来（本次事故即：主进程被日志风暴占死 → 导航没跑起来 → 白窗常驻）。
  const onFailLoad = (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // ERR_ABORTED：导航被新导航取代（正常路径）
    appLog.log("WARN", "workbench", `载入失败 code=${code} ${desc} @ ${String(url).slice(0, 160)}`);
    if (loadRetried) {
      cancelPendingShow();
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
      return;
    }
    loadRetried = true;
    setTimeout(() => {
      if (win && !win.isDestroyed()) load();
    }, 800);
  };
  w.webContents.on("did-fail-load", onFailLoad);
  // D260：渲染进程没了也别留一具白窗——销毁，下次呼出重建（closed 会复位 win/loaded）。
  w.webContents.on("render-process-gone", (_e, details) => {
    appLog.log("ERROR", "workbench", `渲染进程退出：${details?.reason || "unknown"}`);
    cancelPendingShow();
    if (win && !win.isDestroyed()) win.destroy();
  });
  // D260：无边框窗口没有系统标题栏关闭钮，渲染层白屏时用户无路可退——
  // 主进程侧只在「文档尚未就绪」时接 Esc 兜底（就绪后 Esc 归渲染层关菜单，不抢占）。
  w.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || loaded) return;
    event.preventDefault();
    hide();
  });
  const load = () => {
    // D239：载入顺序与主窗口同规（D192 修订：`npm run dev` 优先 dev server，原先这里漏了——开发时制卡台
    // 一直跑旧 dist）；地址不再写死，统一在 devServer.js。
    loadAppPage(w, { app, fs, distFile: path.join(__dirname, "../dist/workbench.html"), page: "workbench.html" });
  };
  load();
  return w;
}

function position(w) {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const [cw, ch] = w.getSize();
    const x = Math.round(area.x + area.width - cw - 24);
    const y = Math.round(area.y + Math.max(24, (area.height - ch) / 2));
    w.setPosition(x, y);
  } catch {
    /* 定位失败不阻塞显示 */
  }
}

/** 屏幕布局变化（显示器休眠 / 拔出 / 重排）后，上次的位置可能落在任何工作区之外——
 * 此时 show 出来用户也看不见。完全离屏（与所有 workArea 零交集）才判离屏：
 * 用户故意拖到边缘只露一条的摆放不动。（与 D201 同判据） */
function offScreen(w) {
  try {
    const b = w.getBounds();
    return !screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
  } catch {
    return false;
  }
}

/** 停止进行中的窗口尺寸动画（新动画 / 窗口销毁时调用，幂等；不放行等待者，由终态统一放行） */
function stopResizeAnim() {
  if (resizeAnim) {
    if (resizeAnim.immediate) clearImmediate(resizeAnim.immediate);
    else if (resizeAnim.timer != null) clearTimeout(resizeAnim.timer);
  }
  resizeAnim = null;
}

/** 动画落位 / 被销毁 / 无动画直落时放行所有等待者 */
function flushResizeWaiters() {
  const ws = resizeWaiters;
  resizeWaiters = [];
  for (const r of ws) r();
}

/** 返回一个在当前窗口尺寸动画结束时 resolve 的 Promise（无动画进行时立即 resolve） */
function whenResizeIdle() {
  if (!resizeAnim) return Promise.resolve();
  return new Promise((r) => resizeWaiters.push(r));
}

/** easeInOutSine：起止速度均为 0，峰值速度仅为匀速的 π/2 倍（cubic 为 3 倍）——
    窗口位移 720px 时，cubic 峰值每帧跳 60px 以上、肉眼是「一顿一顿」；sine 曲线把峰值压平。 */
function easeInOutSine(k) {
  return -(Math.cos(Math.PI * k) - 1) / 2;
}

/** 逐帧插值到目标 bounds；animate=false 直接落位（减动效 / 测试）。
    ① 帧网格：Windows 上 setTimeout(16) 实测约 31ms 一帧（≈32fps），故按显示器刷新率算帧周期，
       每帧落在 t0 + n×period 的固定网格上，帧耗时（setBounds 同步重排 2–9ms）不会累积成节奏漂移；
    ② 位置由 performance.now() 的真实时间决定，掉帧时下一帧自动追上，总时长恒定。 */
function animateBounds(w, target, animate) {
  stopResizeAnim();
  if (!animate) {
    w.setBounds(target);
    flushResizeWaiters();
    return;
  }
  const from = w.getBounds();
  let hz = 60;
  try {
    hz = screen.getDisplayMatching(from).displayFrequency || 60;
  } catch { /* 取不到刷新率按 60Hz */ }
  const period = 1000 / Math.max(30, Math.min(RESIZE_MAX_HZ, hz));
  const t0 = performance.now();
  const finish = () => {
    resizeAnim = null;
    flushResizeWaiters();
  };
  const tick = () => {
    if (!win || win.isDestroyed() || win !== w) {
      stopResizeAnim();
      flushResizeWaiters();
      return;
    }
    const now = performance.now();
    const k = Math.min(1, (now - t0) / RESIZE_MS);
    const e = easeInOutSine(k);
    w.setBounds({
      x: Math.round(from.x + (target.x - from.x) * e),
      y: Math.round(from.y + (target.y - from.y) * e),
      width: Math.round(from.width + (target.width - from.width) * e),
      height: Math.round(from.height + (target.height - from.height) * e)
    });
    if (k >= 1) {
      finish();
      return;
    }
    const after = performance.now();
    const nextAt = t0 + (Math.floor((after - t0) / period) + 1) * period;
    // 帧点调度：Windows 的 setTimeout 粒度 15.6ms，而 setBounds 本身占 5–11ms，剩余等待常只有几毫秒——
    // 定时器会把它拉长成整整一帧（实测帧距 28ms/9ms 交替，等于每隔一帧漏一帧）。动画仅持续 RESIZE_MS，
    // 期间全程用 setImmediate 轮询到帧点：每轮都让出事件循环，IPC 与其它定时器照常处理。
    const arm = () => {
      if (performance.now() >= nextAt - 0.3) {
        tick();
        return;
      }
      resizeAnim = { timer: null, win: w, immediate: setImmediate(arm) };
    };
    arm();
  };
  resizeAnim = { timer: null, win: w }; // 占位：让 whenResizeIdle 在首帧同步期间也认为「进行中」
  tick();
}

/** 目标工作区内的横向夹紧范围（右缘锚定后不跑出屏幕） */
function horizontalRange(b, width) {
  const area = screen.getDisplayMatching(b).workArea;
  const minX = area.x + RESIZE_MARGIN;
  const maxX = area.x + area.width - width - RESIZE_MARGIN;
  return { minX, maxX: Math.max(minX, maxX) };
}

function wideTarget(w) {
  try {
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(WIDE_WIDTH, area.width - RESIZE_MARGIN * 2);
    if (!(width > b.width)) return null;
    const minX = area.x + RESIZE_MARGIN;
    const maxX = Math.max(minX, area.x + area.width - width - RESIZE_MARGIN);
    const x = Math.max(minX, Math.min(b.x + b.width - width, maxX));
    return { x: Math.round(x), y: b.y, width: Math.round(width), height: b.height };
  } catch {
    return null;
  }
}

function restoreTarget(w, restoreWidth) {
  const b = w.getBounds();
  const [minW] = w.getMinimumSize();
  const width = Math.max(minW || 0, restoreWidth);
  let x = b.x + b.width - width;
  try {
    const { minX, maxX } = horizontalRange(b, width);
    x = Math.max(minX, Math.min(x, maxX));
  } catch {
    /* 取不到工作区时保持右缘锚定 */
  }
  return { x: Math.round(x), y: b.y, width: Math.round(width), height: b.height };
}

/** IPC 入口（v49.95 / D261）：mode="wide" 展开固定宽窗 / "restore" 收回进入前宽度。
    仅接受本窗口渲染进程的请求；重复 wide/restore 幂等（不重复记原宽度、不重播动画）。 */
function resize(mode, animate, sender) {
  const w = win;
  if (!w || w.isDestroyed()) return false;
  if (sender && w.webContents !== sender) return false;
  if (mode === "wide") {
    if (wideState && wideState.win === w) return true;
    const target = wideTarget(w);
    if (!target) return false;
    wideState = { win: w, restoreWidth: w.getBounds().width };
    animateBounds(w, target, animate);
    return true;
  }
  if (mode === "restore") {
    if (!wideState || wideState.win !== w) return false;
    const { restoreWidth } = wideState;
    wideState = null;
    animateBounds(w, restoreTarget(w, restoreWidth), animate);
    return true;
  }
  return false;
}

function reveal() {
  const w = win;
  if (!w || w.isDestroyed()) return;
  if (!positioned || offScreen(w)) {
    position(w);
    positioned = true;
  }
  w.setBackgroundColor?.(themeBackground());
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  w.webContents.send("win:workbenchShown");
}

function show() {
  const w = createWindow();
  if (!loaded || w.webContents.isLoading()) {
    pendingShow = true;
    // v201 安全阀：加载悬挂（vite 半死：端口在、请求不回）时 pendingShow 无事件可消费，
    // 最迟 2s 强制显示——宁可短暂主题色白板，不让快捷键/托盘呼出没反应（D200 同构缺陷）。
    if (pendingShowTimer == null) {
      pendingShowTimer = setTimeout(() => {
        pendingShowTimer = null;
        consumePendingShow();
      }, 2000);
    }
    return state();
  }
  reveal();
  return state();
}

function hide() {
  // v201：用户显式要收，挂起中的呼出作废（后写优先；否则安全阀会把刚收的窗又弹出来）
  cancelPendingShow();
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  return state();
}

function toggle() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) return hide();
  return show();
}

function togglePin() {
  pinned = !pinned;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned);
  return state();
}

function state() {
  return { visible: !!(win && !win.isDestroyed() && win.isVisible()), pinned };
}

/** IPC 入口：win:workbench */
function control(action) {
  switch (action) {
    case "show":
      return show();
    case "hide":
      return hide();
    case "pin":
      return togglePin();
    default:
      return toggle();
  }
}

function prepareQuit() {
  quitting = true;
}

function init(options) {
  ctx = options || null;
}

// themeBackground 导出仅供测试（tests/window-skin.test.cjs 的 electron 桩单测；C-29 isAutoLaunchOn 同先例）
module.exports = { init, control, show, hide, toggle, prepareQuit, themeBackground, resize, whenResizeIdle };
