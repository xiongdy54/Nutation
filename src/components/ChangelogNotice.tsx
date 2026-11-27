// v49.173 / D343：更新后首次启动的一行提示（设计 docs/design/CHANGELOG-VIEWER.md §3 / §4 ①）。
// 克制、不打扰：不弹模态、不抢焦点、不注册快捷键；每个版本最多一次（出现即写已读版本）。
// 位置由 ToastStack 决定（右下角，排在后台活动指示器上方）。
// 停留：出现后 12s 自动收回；指针悬停或焦点在内时暂停计时，离开后重新计时。
// 出场：is-closing 播 --dur-exit 动画后卸载；动效关闭 / reduce 时立即卸载（兜底定时器防 animationend 丢失）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { motionPreference } from "../lib/mindmap/v2/animate";
import { IconClose } from "./icons";

/** 自动收回（JS 计时器，非动画参数） */
const AUTO_DISMISS_MS = 12000;

interface Props {
  version: string;
  onOpen: () => void;
  onDone: () => void;
}

export default function ChangelogNotice({ version, onOpen, onDone }: Props) {
  const T = useT();
  const [closing, setClosing] = useState(false);
  const [held, setHeld] = useState(false); // 悬停 / 焦点在内：暂停自动收回
  const rootRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  useEffect(() => {
    if (held || closing) return;
    const id = window.setTimeout(() => setClosing(true), AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [held, closing]);

  useEffect(() => {
    if (!closing) return;
    if (motionPreference() !== "full") {
      finish();
      return;
    }
    const fallback = window.setTimeout(finish, 400);
    return () => window.clearTimeout(fallback);
  }, [closing, finish]);

  return (
    <div
      ref={rootRef}
      className={`toast-card changelog-notice${closing ? " is-closing" : ""}`}
      role="status"
      aria-live="polite"
      data-changelog-notice
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(rootRef.current?.contains(document.activeElement) ?? false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
      onAnimationEnd={(e) => {
        if (e.animationName === "toast-out") finish();
      }}
    >
      <span className="changelog-notice-text">
        {T("已更新至")} <span className="changelog-notice-ver">v{version}</span>
      </span>
      <button
        type="button"
        className="changelog-notice-link"
        onClick={() => {
          onOpen();
          setClosing(true);
        }}
      >
        {T("看看有什么新变化")}
      </button>
      <button
        type="button"
        className="toast-close"
        title={T("关闭")}
        aria-label={T("关闭")}
        onClick={() => setClosing(true)}
      >
        <IconClose size={14} />
      </button>
    </div>
  );
}
