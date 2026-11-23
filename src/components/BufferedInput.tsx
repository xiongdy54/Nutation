// v49.167 / D337：自持文字的单行输入框——击键只重渲染输入框自己，按节流把值交给上层。
// 起因：大组件（卡片浏览器 / 阅读器 / 知识图谱 / 日记 / 设置）把输入框的 value 挂在根 state 上，
// 每个击键（含输入法组字中的每个拼音字母）都触发整棵子树重渲染、甚至逐键写库 → 输入法卡顿。
// 契约：
//   - value 是上层的真值；它变成「不是本框刚交出去的值」时（清空、套用方案等外部改写）同步进输入框。
//   - 组字期间不向上汇报；compositionend 后按 delay 节流汇报。
//   - Enter / Esc（非组字）与失焦时**同步冲刷**待汇报值，再调用上层的 onKeyDown / onBlur——
//     上层处理器读到的已是最新值（不会拿到旧闭包里的半截文字）。
//   - 卸载时若有未汇报的值，补交一次（设置项不丢最后几个字）。
// 只用于单行纯文本（搜索框、名称框、设置文本项）；卡片/摘录/批注正文仍走 src/components/editor/（C-34）。
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import { isImeComposing } from "../lib/ime";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange"> & {
  value: string;
  onValueChange: (v: string) => void;
  /** 汇报节流（ms），默认 250 */
  delay?: number;
};

const BufferedInput = forwardRef<HTMLInputElement, Props>(function BufferedInput(
  { value, onValueChange, delay = 250, onKeyDown, onBlur, onCompositionStart, onCompositionEnd, ...rest },
  ref,
) {
  const [text, setText] = useState(value);
  const sent = useRef(value); // 最近一次交给上层（或从上层收下）的值
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const composing = useRef(false);
  // 最新的上层回调：冲刷后上层重渲染，要调用的是新闭包
  const latest = useRef({ onValueChange, onKeyDown, onBlur });
  useLayoutEffect(() => {
    latest.current = { onValueChange, onKeyDown, onBlur };
  });

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const emit = () => {
    clearTimer();
    const v = pending.current;
    pending.current = null;
    if (v === null || v === sent.current) return;
    sent.current = v;
    latest.current.onValueChange(v);
  };
  const flushNow = () => {
    if (pending.current === null) return;
    flushSync(emit);
  };
  const schedule = () => {
    clearTimer();
    if (composing.current) return;
    timer.current = window.setTimeout(emit, delay);
  };

  // 上层改写（非本框交出的值）→ 覆盖输入框并丢弃待汇报值
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    pending.current = null;
    clearTimer();
    setText(value);
  }, [value]);

  useEffect(
    () => () => {
      clearTimer();
      const v = pending.current;
      if (v !== null && v !== sent.current) latest.current.onValueChange(v);
    },
    [],
  );

  return (
    <input
      {...rest}
      ref={ref}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        pending.current = e.target.value;
        schedule();
      }}
      onCompositionStart={(e) => {
        composing.current = true;
        clearTimer();
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        composing.current = false;
        pending.current = e.currentTarget.value;
        schedule();
        onCompositionEnd?.(e);
      }}
      onKeyDown={(e) => {
        // 组字中的 Enter/Esc 属于输入法：不冲刷，但仍交给上层（上层自带 isImeComposing 守卫）
        if (!isImeComposing(e) && (e.key === "Enter" || e.key === "Escape")) flushNow();
        latest.current.onKeyDown?.(e);
      }}
      onBlur={(e) => {
        flushNow();
        latest.current.onBlur?.(e);
      }}
    />
  );
});

export default BufferedInput;
