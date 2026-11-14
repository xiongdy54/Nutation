// 审计 #14：flash / toast 提示的**唯一计时面**。
//
// 原实现在 12 处各写一遍 `setFlash(note); window.setTimeout(() => setFlash(null), 1800)`——
// 计时器无主，两个后果：
//   ① 1.8s 内连发两条提示（连刷摘录的正常节奏），**第一条**的计时器到点会把第二条提前清掉；
//   ② 组件卸载后计时器仍在跑，回调里的 setState 落在已卸载组件上（无主定时器）。
// 本钩子：一个 timer ref ＋ 每次显示前 clearTimeout ＋ 卸载时清理。
// 可见行为与原实现一致（同一驻留时长、同一「后一条覆盖前一条」的显示语义），
// 差别只在于后一条现在能完整显示满时长、卸载不再留悬空回调。
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 提示驻留时长（ms）。
 * 说明：theme.css 的 `--dur-*` 族全部是**过渡/动画时长**（60–400ms，见 :root 动效段），
 * 没有「提示驻留多久」语义的 Token；本值不是动画时长，故不硬套 --dur-*，也不新造 Token 名。
 * 原 12 处裸写 1800 收敛到这一个常量（要改驻留时长只改这里）。
 */
export const FLASH_MS = 1800;

/**
 * 一条短时提示的状态与显示入口。
 * 返回 `[当前提示文本 | null, 显示函数]`；显示函数身份稳定（可安全进 useCallback deps）。
 */
export function useFlash(): [string | null, (msg: string) => void] {
  const [flash, setFlash] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const show = useCallback((msg: string) => {
    // 先清掉上一条的计时器：否则它会提前清掉本条（审计 #14 的核心症状）
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setFlash(msg);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setFlash(null);
    }, FLASH_MS);
  }, []);

  // 卸载即回收：不留指向已卸载组件的 setState
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    []
  );

  return [flash, show];
}