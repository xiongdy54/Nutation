// v49.170 / D340（KG-SG I5）：阅读停留信号 `unit_reads` 的渲染层探测。
// 口径（IMPL-PLAN §0 Z2）：同一导图单元（阅读内核的章节锚，与 ensureFed 送入主进程的单元锚同口径）连续作为「当前单元」
// ≥ 45 s，且文档可见、窗口聚焦 → 记一次读过；每个 (documentId, unitAnchor) 每会话只发一次（主进程另有唯一索引幂等）。
// 发之前先 ensureFed，保证主进程会话里已有该单元原文（原文术语抽取只在会话就绪时运行）。
import { useEffect } from "react";
import type { ReaderKernel } from "./reader/kernel";
import { ensureFed, type FeedKernel } from "./mindmapFeed";
import { kgApi } from "./kg";

export const UNIT_READ_DWELL_MS = 45_000;
export const UNIT_READ_POLL_MS = 2_000;
export const UNIT_READ_MAX_DT_MS = 2 * UNIT_READ_POLL_MS;

/** 纯逻辑：累计同一单元的可见停留；切换单元归零；失焦 / 隐藏期间不累计。达到阈值时返回该单元锚（每单元一次）。 */
export function createDwellTracker(thresholdMs = UNIT_READ_DWELL_MS) {
  let current: string | null = null;
  let acc = 0;
  const fired = new Set<string>();
  return {
    tick(anchor: string | null, dtMs: number, active: boolean): { unitAnchor: string; dwellMs: number } | null {
      if (!anchor) {
        current = null;
        acc = 0;
        return null;
      }
      if (anchor !== current) {
        current = anchor;
        acc = 0;
      }
      if (!active || fired.has(anchor)) return null;
      // M2：单次采样间隔上限 2 个轮询周期（窗口隐藏 / 节流 / 休眠后的超长间隔直接截断）
      acc += Math.min(Math.max(0, dtMs), UNIT_READ_MAX_DT_MS);
      if (acc < thresholdMs) return null;
      fired.add(anchor);
      return { unitAnchor: anchor, dwellMs: acc };
    },
    /** 发送失败时撤销，允许后续再试 */
    unfire(anchor: string) {
      fired.delete(anchor);
      if (current === anchor) acc = 0;
    },
    reset() {
      current = null;
      acc = 0;
      fired.clear();
    }
  };
}

/** 阅读器里挂一次：kernel 就绪且有 documentId 时每 2 s 采样当前单元 */
export function useUnitReadDwell(kernel: ReaderKernel | null, documentId: string | null, title: string) {
  useEffect(() => {
    if (!kernel || !documentId || typeof kernel.getReadingProbe !== "function") return;
    const api = kgApi();
    if (!api?.unitRead) return;
    const tracker = createDwellTracker();
    let last = performance.now();
    let disposed = false;
    const isActive = () => document.visibilityState === "visible" && document.hasFocus();
    let lastActive = isActive();
    // M2：可见性 / 焦点变化时重置采样起点，丢弃隐藏期间的时间段
    const resetLast = () => {
      last = performance.now();
      lastActive = isActive();
    };
    document.addEventListener("visibilitychange", resetLast);
    window.addEventListener("blur", resetLast);
    window.addEventListener("focus", resetLast);
    const timer = window.setInterval(() => {
      const t = performance.now();
      const dt = t - last;
      last = t;
      let anchor: string | null = null;
      try {
        anchor = kernel.getReadingProbe?.()?.unitAnchor ?? null;
      } catch {
        anchor = null;
      }
      const nowActive = isActive();
      const active = nowActive && lastActive; // 区间两端都可见且聚焦才累计
      lastActive = nowActive;
      const hit = tracker.tick(anchor, dt, active);
      if (!hit) return;
      void (async () => {
        try {
          const st = await ensureFed(kernel as unknown as FeedKernel, documentId, title);
          if (disposed) return;
          if (st.unsupported) return;
          await api.unitRead(documentId, hit.unitAnchor, Math.round(hit.dwellMs));
        } catch {
          tracker.unfire(hit.unitAnchor);
        }
      })();
    }, UNIT_READ_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resetLast);
      window.removeEventListener("blur", resetLast);
      window.removeEventListener("focus", resetLast);
    };
  }, [kernel, documentId, title]);
}
