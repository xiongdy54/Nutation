// 制卡台布局与全局信号（v48.79 / D123；v49.104 / D270：固定右侧、内推单轨）
// 职责：① 开合时把「内推」写到 <html> 数据属性（CSS 据此给 .app-main 让出 400px）；
// ② 顶栏按钮 ↔ 宿主面板的轻量 DOM 事件桥（不动 eventBus 的锁定事件表）；③ 跨页「开着」意图。
//
// D270 口径：
//  · 放置固定右侧，窗口**不外延**（不调用 win:dockExtend / win:dockRestore），无底部放置；
//  · 展开在宿主 useLayoutEffect 内同步落地（页面过渡快照首帧即最终宽度）；
//  · 宿主卸载＝同步释放布局（releaseDockLayout），新页快照不得带 400px 空带；
//  · 开合动画只服务「同一页面内的用户开合」；页面切换的首帧一律瞬时落位，位移交给 View Transitions。
export type WorkbenchPlacement = "right";
/** 独立窗口里的制卡台：不占布局、不推让 */
export type WorkbenchDockPlacement = WorkbenchPlacement | "window";

/** 右侧制卡台宽度（与 theme.css 的 --wb-w 同值） */
export const WB_WIDTH = 400;

// ---------- 顶栏按钮 ↔ 宿主面板（DOM 事件桥） ----------
export const WB_TOGGLE_EVENT = "wb:toggle";
export const WB_STATE_EVENT = "wb:state";

export interface WorkbenchState {
  /** 制卡台当前展开 */
  open: boolean;
  /** AI 正在生成（静态点提示，不闪烁） */
  busy: boolean;
  /** 手动草稿在场（预留，当前恒由宿主按需填） */
  draft: boolean;
}

// 跨页面保持「制卡台是开着的」：宿主随视图切换卸载/重挂，新宿主挂载时按此标记同步初始化
// （用户意图；不支持制卡台的页面不挂宿主，也不改写本标记）。
let lastOpen = false;
export function getLastWorkbenchOpen(): boolean {
  return lastOpen;
}
export function setLastWorkbenchOpen(v: boolean): void {
  lastOpen = v;
}

export function requestWorkbenchToggle(): void {
  window.dispatchEvent(new CustomEvent(WB_TOGGLE_EVENT));
}

export function publishWorkbenchState(s: WorkbenchState): void {
  window.dispatchEvent(new CustomEvent<WorkbenchState>(WB_STATE_EVENT, { detail: s }));
}

// ---------- 内推布局仲裁 ----------
// 页面切换的交叠帧里新旧宿主的 effect 清理与挂载次序不可靠——登记表里「最后登记且展开」的宿主说了算；
// 旧宿主注销时若新宿主已登记，则布局保持不动（不收起再展开）。
const owners = new Map<symbol, true>();
let applied = false;
let chainGen = 0; // 世代号：旧的收起/落定清理不得覆盖新一次展开
let animTimer: number | null = null;
const ANIM_MS = 260; // ≥ --dur-panel(240ms)

function root(): HTMLElement {
  return document.documentElement;
}

function clearAnimTimer(): void {
  if (animTimer !== null) {
    window.clearTimeout(animTimer);
    animTimer = null;
  }
}

function settleOpenLater(gen: number): void {
  clearAnimTimer();
  animTimer = window.setTimeout(() => {
    animTimer = null;
    if (gen !== chainGen) return;
    delete root().dataset.wbAnim; // 动画窗口结束：此后窗口缩放不再产生过渡
  }, ANIM_MS);
}

function applyOpen(onCommit: (() => void) | undefined, animate: boolean): void {
  if (applied) {
    // 页面切换的新宿主已接手旧宿主的布局：只同步宿主可见态，绝不重播动画
    onCommit?.();
    return;
  }
  clearAnimTimer();
  const gen = ++chainGen;
  const el = root();
  el.dataset.wbPlace = "right";
  el.dataset.wbOpen = "1";
  if (animate) {
    el.dataset.wbAnim = "1";
    settleOpenLater(gen);
  } else {
    delete el.dataset.wbAnim; // 首帧即最终宽度（页面过渡快照取稳定态）
  }
  applied = true;
  onCommit?.();
}

function applyClose(onCommit: (() => void) | undefined): void {
  if (!applied) {
    onCommit?.();
    return;
  }
  clearAnimTimer();
  const gen = ++chainGen;
  const el = root();
  el.dataset.wbAnim = "1";
  delete el.dataset.wbOpen; // margin 回落与坞体滑出同帧
  applied = false;
  onCommit?.();
  animTimer = window.setTimeout(() => {
    animTimer = null;
    if (gen !== chainGen) return;
    delete el.dataset.wbPlace;
    delete el.dataset.wbAnim;
  }, ANIM_MS);
}

/** 宿主登记自己的制卡台展开态（open=false 即注销）。
 *  animate=false 用于「页面挂载时的既有开态」：不做 margin/坞体过渡，首帧即终态。 */
export function setDockLayout(owner: symbol, open: boolean, onCommit?: () => void, animate = true): void {
  if (open) {
    owners.delete(owner); // 重新登记＝成为「最后登记者」
    owners.set(owner, true);
    applyOpen(onCommit, animate);
    return;
  }
  owners.delete(owner);
  if (owners.size > 0) {
    onCommit?.();
    return;
  }
  applyClose(onCommit);
}

/** 宿主卸载（页面切换）：同步释放，不能等 260ms——新页第一帧就必须是满宽。
 *  若同一轮里已有新宿主登记（交接），布局保持不动。 */
export function releaseDockLayout(owner: symbol): void {
  owners.delete(owner);
  if (owners.size > 0) return;
  chainGen += 1;
  clearAnimTimer();
  const el = root();
  delete el.dataset.wbOpen;
  delete el.dataset.wbPlace;
  delete el.dataset.wbAnim;
  applied = false;
}
