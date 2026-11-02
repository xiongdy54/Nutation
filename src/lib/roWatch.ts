// D260 增补：ResizeObserver 自激循环看守（**只上报，不改行为**）
//
// 背景（2026-11-02 实机事故）：某个 RO 回调改布局 → 又触发自己，浏览器每秒抛 8~50 条
// 「ResizeObserver loop completed with undelivered notifications」，但该错误**不带任何目标信息**——
// 日志里只知道「有东西在循环」，点不出是哪个组件，导致只能靠猜。
//
// 做法：包一层 ResizeObserver，给每个实例计数；连续 3 个 1s 窗口回调都超过 40 次即判为自激，
// 上报**一次**（元素标签/类名/id/尺寸 + 构造函数栈），此后该实例不再上报。
//
// 纪律：
//  ① 只计数与上报，不阻断、不节流、不改回调时机（行为零改变）；
//  ② 每会话最多 MAX_REPORTS 条，单个实例只报一次——埋点本身绝不能变成新的噪音源；
//  ③ 隐私（§7.5）：只取元素标签/类名/id/尺寸与构造栈，不取任何文本内容；
//  ④ 上报延到下一个宏任务——避免在 RO 投递过程中再触发一次同步布局读（那会加重循环）。
const WINDOW_MS = 1000;
const CALLS_PER_WINDOW = 40; // 正常拖动窗口/滚动也很难持续超过这个数
const SUSTAINED_WINDOWS = 3; // 连续 3 个窗口都超 → 判为自激（排除一次性抖动）
const MAX_REPORTS = 3; // 每会话上报上限
const MAX_TARGETS = 4; // 单实例记住几个被观察元素

type Rec = {
  windowStart: number;
  calls: number;
  streak: number;
  total: number;
  reported: boolean;
  targets: Element[];
  origin: string;
};

type ReportBridge = { report?: (payload: Record<string, unknown>) => void };

let reports = 0;

/** 元素的可读标识：tag#id.class1.class2 WxH（不含任何文本内容） */
function describe(el: Element | undefined): string {
  if (!el || !el.isConnected) return "（元素已卸载）";
  try {
    const cls = (el.getAttribute("class") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(".");
    const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""} ${Math.round(r.width)}x${Math.round(r.height)}`;
  } catch {
    return "（读取失败）";
  }
}

/** 构造函数调用点（去掉本文件自身两帧），生产构建里也足以定位到组件 */
function originOf(): string {
  try {
    const line = (new Error().stack || "").split("\n")[3] || "";
    return line.trim().replace(/^at\s+/, "").slice(0, 160);
  } catch {
    return "?";
  }
}

function send(rec: Rec): void {
  if (reports >= MAX_REPORTS) return;
  reports += 1;
  const bridge = (globalThis as unknown as { logsAPI?: ReportBridge }).logsAPI;
  const where = rec.targets.map(describe).join(" / ") || "（未记录目标）";
  const windowSec = Math.round(WINDOW_MS / 1000);
  // 延到宏任务：不在 RO 投递里做布局读，也不在本轮里再排一次 IPC
  setTimeout(() => {
    try {
      bridge?.report?.({
        kind: "error",
        message:
          `[ro-watch] ResizeObserver 自激循环：${where} · 累计 ${rec.total} 次回调，` +
          `连续 ${SUSTAINED_WINDOWS} 个 ${windowSec}s 窗口均 > ${CALLS_PER_WINDOW} 次 · 构造于 ${rec.origin}`
      });
    } catch {
      /* 上报失败绝不影响业务（D119 口径） */
    }
  }, 0);
}

function tick(rec: Rec): void {
  rec.total += 1;
  const now = performance.now();
  if (now - rec.windowStart < WINDOW_MS) {
    rec.calls += 1;
    return;
  }
  // 窗口结算：先判上一个窗口是否超限，再开新窗口
  const over = rec.calls > CALLS_PER_WINDOW;
  rec.streak = over ? rec.streak + 1 : 0;
  rec.calls = 1;
  rec.windowStart = now;
  if (rec.streak >= SUSTAINED_WINDOWS && !rec.reported) {
    rec.reported = true;
    send(rec);
  }
}

export function installResizeObserverWatch(): void {
  const g = globalThis as unknown as {
    ResizeObserver?: new (cb: ResizeObserverCallback) => ResizeObserver;
    __roWatchInstalled?: boolean;
  };
  const Native = g.ResizeObserver;
  if (!Native || g.__roWatchInstalled) return;
  g.__roWatchInstalled = true;

  const watch = new Proxy(Native, {
    construct(Target, args: [ResizeObserverCallback]) {
      const cb = args[0];
      const rec: Rec = {
        windowStart: performance.now(),
        calls: 0,
        streak: 0,
        total: 0,
        reported: false,
        targets: [],
        origin: originOf()
      };
      const wrapped: ResizeObserverCallback = (entries, observer) => {
        tick(rec);
        cb(entries, observer);
      };
      const inst = new Target(wrapped);
      // 记录被观察元素（最多 4 个），供上报时点名；不改变 observe 语义
      const nativeObserve = inst.observe.bind(inst);
      inst.observe = (target: Element, options?: ResizeObserverOptions) => {
        if (rec.targets.length < MAX_TARGETS && target) rec.targets.push(target);
        nativeObserve(target, options);
      };
      return inst;
    }
  });

  g.ResizeObserver = watch;
}

// 入口处 import 即安装（必须在任何组件创建 RO 之前——放在 main/workbench/capture 的首行 import）
installResizeObserverWatch();
