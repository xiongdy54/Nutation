// v49.173 / D343：右下角通知栈（设计 docs/design/CHANGELOG-VIEWER.md §4 ①）。
// 全应用的右下角通知统一放在这里：后台活动指示器恒在最下（它底边钉死、向上展开），
// 其余通知（更新提示等）排在它上面。容器 fixed 于 right/bottom --sp-4，竖向、间距 --sp-2、右对齐。
//
// 让位动效（「同时出现时要有自然的排列效果」）：任一项出现 / 消失时，其余项从旧位置平滑滑到新位置——
// FLIP：结构变化（childList）在微任务里测得新位置，先用 transform 反向抵消位移，下一帧过渡回 0。
// 只在**结构变化**时滑动：后台活动卡展开 / 收起本身有高度过渡，上方的项随布局逐帧流动即可，
// 若对尺寸变化也做 FLIP 会逐帧互相追赶。尺寸变化只刷新位置缓存。
// 动效关闭（body.motion-off / reduce）时不做 FLIP，直接落位。
//
// 挂到 body：.app-shell 自成层叠上下文（z-index:0），留在壳内时 --z-toast 只在壳内生效（D329 同因）。
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motionPreference } from "../lib/mindmap/v2/animate";

export default function ToastStack({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    // 每项的**视觉**底边（含进行中的 transform）：栈底钉死，项的位移只体现在底边上，项自身变高不算位移
    const last = new Map<Element, number>();
    const slots = () => Array.from(root.children) as HTMLElement[];
    const remember = () => {
      last.clear();
      for (const el of slots()) {
        if (el.offsetHeight > 0) last.set(el, el.getBoundingClientRect().bottom);
      }
    };
    const glide = () => {
      const animate = motionPreference() === "full";
      for (const el of slots()) {
        if (el.offsetHeight === 0) continue;
        const before = last.get(el);
        // 新的布局底边（去掉进行中的 transform）；与旧视觉底边之差＝要抵消的位移，途中再变也能接续
        const now = el.getBoundingClientRect().bottom - currentShift(el);
        if (!animate || before === undefined || Math.abs(before - now) < 0.5) continue;
        el.style.transition = "none";
        el.style.transform = `translateY(${before - now}px)`;
        void el.offsetHeight; // 提交反向位移
        el.style.transition = "";
        el.style.transform = "";
      }
      remember();
    };
    remember();
    const mo = new MutationObserver(glide);
    mo.observe(root, { childList: true, subtree: true });
    const ro = new ResizeObserver(remember);
    ro.observe(root);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);

  return createPortal(
    <div ref={ref} className="toast-stack" data-ui="toast-stack">
      {children}
    </div>,
    document.body
  );
}

/** 槽位当前 transform 的 Y 位移（FLIP 过渡途中再次变化时，从当前视觉位置接续） */
function currentShift(el: HTMLElement): number {
  const tf = getComputedStyle(el).transform;
  if (!tf || tf === "none") return 0;
  const m = tf.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const parts = m[1].split(",").map(Number);
  return Number.isFinite(parts[5]) ? parts[5] : 0;
}
