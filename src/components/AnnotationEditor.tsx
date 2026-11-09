// 批注编辑浮层 v2（D267，规格 §3.4 R37/R40 + docs/design/ANNOTATION-EDITOR-V2-D267.md）。
// 形态约定（与项目「编辑即写」一致）：
//   · **无「保存」「取消」按钮**——输入 400ms 防抖 + 失焦即落库；保存态收在顶行右段（8px）。
//   · **批注文字清空 ＝ 删除批注**（comment → null）：条目本身保留（纯高亮仍是高亮、摘录仍是摘录）。
//   · 顶行 = 设置页色板（annotatePalette）+ 卡片计数 + 制卡 + 删除；面板内不再有自定义取色入口，
//     也不再读取 annotateCustomEnabled（键与设置页控件保留，边界见设计稿 §7）。
//   · 删除按钮**按 kind 换标签**（R36）：highlight →「删除高亮」；extract →「删除摘录」；各带就地二次确认。
//   · **失焦即走**（R37 强化）：焦点离开浮层（点别处/点别的条目）→ 先把文字落库、再立刻收起；
//     Esc 同样「先落库再收起」（确认态先取消确认）。故浮层不会赖在屏上挡住下一次点击。
//   · 焦点陷阱 + Esc 关闭（useDialogA11y 既有件）；**非模态**（aria-modal=false）——它靠失焦收起，
//     不是拦着背景的模态对话框。打开时显式聚焦书写区并把光标放到末尾。
// 定位一律走 src/lib/popoverPlace.ts（与 MarkPopover / SelectionMenu 同一份实现）：
// 锚点＝所引那段文字的包围盒，**居中**贴其上/下方，空间不够自动翻面。
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { placePopover, type PopoverRect } from "../lib/popoverPlace";
import { useDialogA11y } from "../lib/dialogA11y";
import { ANNOT_COLORS } from "./SelectionMenu";
import ReadMarkdown from "./editor/ReadMarkdown";
import { useT } from "../lib/i18n";
import { IconSelCardCount, IconSelCheck, IconSelTrash } from "./selectionIcons";

/** 已保存态的迟到窗口：防抖落库后短暂显示「已保存」再隐去 */
const SAVED_HINT_MS = 1400;
/** 输入防抖（R37：与项目「编辑即写」一致） */
const DEBOUNCE_MS = 400;
/** 浮层宽度（设计稿 §3）：304px，锚线与定位都按它算 */
const PANEL_WIDTH = 304;

export interface AnnotationEditorProps {
  extractId: string;
  kind: "highlight" | "extract";
  comment: string | null;
  color: string | null;
  /** 锚点包围盒（视口坐标）——所引文字/高亮的位置 */
  anchor: PopoverRect;
  /** 容器（视口坐标；缺省＝整个视口） */
  container?: PopoverRect | null;
  /** 用户配好的色板（设置键 annotatePalette；缺省＝全 8 色） */
  palette?: readonly string[];
  /** 文字落库（comment 为 null ＝ 删除批注） */
  onSaveComment: (comment: string | null) => Promise<void>;
  /** 颜色落库 */
  onSaveColor: (color: string) => Promise<void>;
  /** 删除整条（按 kind 换标签；已含二次确认） */
  onDelete: () => Promise<void>;
  onClose: () => void;
  /**
   * v48.45（D85）：文中标记的**聚合已制卡数**（本条 + 全部子孙摘录的卡之和）——
   * 悬停浮层退役后由本浮层承接展示；缺省（摘录页宿主）不显示。0 张不渲染（D267）。
   */
  cardCount?: number;
  /** 「就此制卡」动作（走宿主的手动制卡链）；缺省不显示按钮 */
  onMakeCard?: () => void;
  /**
   * v48.47（D87）：点「已制卡 N 张」→ 宿主跳卡片浏览器并按该锚的子孙闭包筛选；
   * 缺省（无跳转出口）时计数保持纯文字。
   */
  onOpenCards?: () => void;
}

/** 色块显示色：色板 id → --annot-<id>；#hex 原样 */
export function annotColorCss(color: string | null | undefined): string {
  const c = String(color ?? "");
  if (!c) return "var(--grey-2)";
  return c.startsWith("#") ? c : `var(--annot-${c})`;
}

export default function AnnotationEditor({
  extractId,
  kind,
  comment,
  color,
  anchor,
  container,
  palette,
  onSaveComment,
  onSaveColor,
  onDelete,
  onClose,
  cardCount,
  onMakeCard,
  onOpenCards
}: AnnotationEditorProps) {
  const T = useT();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);
  const [text, setText] = useState(comment ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<number | null>(null);
  const hintRef = useRef<number | null>(null);
  /** 已落库文字（判等用：没变就不写库，避免失焦时白发一次更新） */
  const committedRef = useRef<string>(comment ?? "");
  /** 最新文字（收起时落库读它：监听器不随每次输入重挂） */
  const textRef = useRef<string>(comment ?? "");
  textRef.current = text;
  /** 鼠标按在浮层内：此时 textarea 的「失焦」不是真的离开（点空白 / 点动作不算收起） */
  const downInsideRef = useRef(false);

  const colors = palette && palette.length ? palette : (ANNOT_COLORS as readonly string[]);
  /** D224：批注里的 Mermaid 实时预览——完整围栏闭合后才渲染，避免输入途中闪错误回落 */
  const hasMermaidPreview = /```mermaid[\s\S]*?```/.test(text);

  const showSaved = () => {
    setSaveState("saved");
    if (hintRef.current) window.clearTimeout(hintRef.current);
    hintRef.current = window.setTimeout(() => setSaveState("idle"), SAVED_HINT_MS);
  };

  /** 落库（清空 ⇒ null）；返回是否真的写了 */
  const commit = async (next: string) => {
    const normalized = next.trim();
    if (normalized === committedRef.current.trim()) return false;
    committedRef.current = normalized;
    setSaveState("saving");
    try {
      await onSaveComment(normalized ? normalized : null);
      showSaved();
      return true;
    } catch {
      setSaveState("idle");
      return false;
    }
  };

  /**
   * 收起浮层：**先把文字落库、再立刻消失**。落库是已发出的 IPC 调用，不受卸载影响；
   * 不这样做的话，防抖计时器会随卸载被清掉 → 刚敲的字丢掉（实测：点别处消失后文字没保存）。
   */
  const closeAndSave = () => {
    void commit(textRef.current);
    onClose();
  };
  const panelRef = useDialogA11y<HTMLDivElement>(closeAndSave);

  // 打开时显式聚焦书写区（顶行色板在 DOM 前面，不能依赖「首个可聚焦元素」）；光标落到末尾。
  // 进入删除确认态时焦点落到「删除」；取消后回到书写区（D267 §5.2）。
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (confirmDelete) {
        panel.querySelector<HTMLButtonElement>("[data-del-confirmed]")?.focus({ preventScroll: true });
        return;
      }
      const ta = taRef.current;
      if (!ta) return;
      ta.focus({ preventScroll: true });
      try {
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } catch {
        /* 受控值切换途中偶发：忽略 */
      }
    });
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDelete]);

  // 书写区自动长高：39（雨林 47）起、168 封顶；与样张 grow() 同参（行高由 CSS Token 决定）
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const cs = getComputedStyle(ta);
    const max = parseFloat(cs.maxHeight) || 168;
    const h = Math.min(max, ta.scrollHeight);
    ta.style.height = `${h}px`;
    ta.style.overflowY = ta.scrollHeight > h + 1 ? "auto" : "hidden";
  }, [text, hasMermaidPreview]);

  // 定位：先渲染在视口外一帧等测量（与 MarkPopover/SelectionMenu 同规）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const { left, top, placement } = placePopover({
      anchor,
      container,
      size: { width: el.offsetWidth, height: el.offsetHeight },
      // 贴所引那段的下方居中；下方放不下自动翻到上方（空间不足再夹进容器）
      prefer: "below",
      align: "center"
    });
    setPos({ left, top, placement });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, anchor.width, anchor.height, confirmDelete, hasMermaidPreview]);

  // D224：Mermaid 预览是懒加载的，SVG 落位后浮层高度会再变；尺寸变化时重新贴一次锚点，
  // 避免预览把浮层顶出视口（与 confirmDelete 的显式重定位同规）。
  useEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const { left, top, placement } = placePopover({
        anchor,
        container,
        size: { width: el.offsetWidth, height: el.offsetHeight },
        prefer: "below",
        align: "center"
      });
      setPos({ left, top, placement });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.x, anchor.y, anchor.width, anchor.height, container]);

  const commitRef = useRef(commit);
  commitRef.current = commit;

  // 点浮层之外 ⇒ 落库并收起（点别条目的 mousedown 先走这里，随后的 click 才能打开它自己的浮层）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && panelRef.current?.contains(t)) return;
      closeAndSave();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 400ms 防抖落库
  useEffect(() => {
    if (text.trim() === committedRef.current.trim()) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void commitRef.current(text), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // 卸载时清掉两条计时器（防抖 + 已保存回 idle）
  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (hintRef.current) window.clearTimeout(hintRef.current);
    },
    []
  );

  // 失焦即落库**并收起**（R37）：浮层内换焦点（点删除、点色块）不算「离开浮层」，
  // 故只在焦点移到**浮层之外**时才收，避免点删除时先写一次空批注。
  function handleBlur(e: React.FocusEvent<HTMLTextAreaElement>) {
    const next = e.relatedTarget as Node | null;
    if (next && panelRef.current?.contains(next)) return;
    if (downInsideRef.current) return; // 点浮层内空白 / 动作：不是离开
    closeAndSave();
  }

  const deleteLabel = kind === "highlight" ? T("删除高亮") : T("删除摘录");
  const confirmQuestion = kind === "highlight" ? T("删除高亮？") : T("删除摘录？");
  const saveLabel =
    saveState === "saving" ? T("保存中…") : saveState === "saved" ? T("已保存") : T("自动保存");
  const cardLabel = cardCount !== undefined ? T("已制卡 {n} 张", { n: cardCount }) : "";
  // 确认态色板收成当前色：8 色时确认组也能固定在右端，不溢出、不静默截断（D267 §5.2）
  const paletteColors = confirmDelete ? (color ? [color] : []) : colors;
  const stemX = pos
    ? Math.max(16, Math.min(PANEL_WIDTH - 16, anchor.x + anchor.width / 2 - pos.left))
    : 32;

  const panelStyle: CSSProperties = pos
    ? ({ left: pos.left, top: pos.top, "--stem-x": `${stemX}px` } as CSSProperties)
    : { left: -9999, top: 0 };

  return (
    <div
      ref={panelRef}
      className="annot-editor"
      role="dialog"
      aria-modal="false"
      aria-label={kind === "highlight" ? T("编辑高亮") : T("编辑摘录")}
      data-editor-kind={kind}
      data-editor-for={extractId}
      data-place={pos?.placement ?? "below"}
      data-confirm={confirmDelete ? "1" : undefined}
      style={panelStyle}
      onMouseDownCapture={() => {
        downInsideRef.current = true;
      }}
      onMouseUpCapture={() => {
        downInsideRef.current = false;
      }}
      onKeyDown={(e) => {
        // 确认态 Esc 先取消确认（再按一次才收起浮层）；其余 Esc 交给 useDialogA11y
        if (e.key === "Escape" && confirmDelete) {
          e.preventDefault();
          e.stopPropagation();
          setConfirmDelete(false);
        }
      }}
    >
      <div className="annot-top">
        {paletteColors.length > 0 && (
          <div
            className={`annot-palette${confirmDelete ? " is-dim" : ""}`}
            role="group"
            aria-label={T("高亮颜色")}
          >
            {paletteColors.map((c) => {
              const on = c === color;
              return (
                <button
                  key={c}
                  type="button"
                  className={`annot-swatch${on ? " on" : ""}`}
                  data-color={c}
                  aria-pressed={on}
                  aria-label={T("用这支色：{color}", { color: c })}
                  title={T("用这支色：{color}", { color: c })}
                  disabled={confirmDelete}
                  onClick={() => {
                    setSaveState("saving");
                    void onSaveColor(c).then(showSaved).catch(() => setSaveState("idle"));
                  }}
                >
                  <i style={{ background: annotColorCss(c) }} />
                </button>
              );
            })}
          </div>
        )}
        {paletteColors.length > 0 && <span className="annot-sep" aria-hidden="true" />}
        <span className="annot-spacer" />
        <span
          className="annot-save"
          data-savestate
          data-state={saveState}
          aria-live="polite"
          aria-label={saveLabel}
          title={saveLabel}
        >
          {saveState === "saving" ? (
            <span className="annot-save-pulse" aria-hidden="true" />
          ) : saveState === "saved" ? (
            <IconSelCheck />
          ) : null}
          <span className="annot-sr">{saveLabel}</span>
        </span>
        {!confirmDelete && cardCount !== undefined && cardCount > 0 &&
          (onOpenCards ? (
            <button
              type="button"
              className="annot-card"
              data-cardcount
              data-open-cards
              title={T("查看这个锚点下的全部卡片（含子摘录等所有子层级产出的卡）")}
              aria-label={cardLabel}
              onClick={onOpenCards}
            >
              <IconSelCardCount />
              <span>{cardCount}</span>
            </button>
          ) : (
            <span className="annot-card" data-cardcount title={cardLabel} aria-label={cardLabel}>
              <IconSelCardCount />
              <span>{cardCount}</span>
            </span>
          ))}
        {!confirmDelete && onMakeCard && (
          <button
            type="button"
            className="annot-make"
            data-make-card
            title={T("就此制卡")}
            aria-label={T("就此制卡")}
            onClick={onMakeCard}
          >
            {T("制卡")}
          </button>
        )}
        {!confirmDelete && (
          <button
            type="button"
            className="annot-trash"
            data-del
            title={deleteLabel}
            aria-label={deleteLabel}
            onClick={() => setConfirmDelete(true)}
          >
            <IconSelTrash />
          </button>
        )}
        {confirmDelete && (
          <span className="annot-confirm" role="group" aria-label={confirmQuestion}>
            <span className="annot-confirm-q">{confirmQuestion}</span>
            <button type="button" className="annot-cancel" data-del-cancel onClick={() => setConfirmDelete(false)}>
              {T("取消")}
            </button>
            <button
              type="button"
              className="annot-confirm-btn"
              data-del-confirmed
              onClick={() => void onDelete()}
            >
              {T("删除")}
            </button>
          </span>
        )}
      </div>
      <div className="annot-body">
        <textarea
          ref={taRef}
          className="annot-ta"
          rows={2}
          value={text}
          // 不放解释性小字（R38：清空＝删批注属直觉）；placeholder 只作输入提示
          placeholder={T("写下你的想法…")}
          aria-label={T("批注文字")}
          onChange={(e) => setText(e.target.value)}
          onBlur={handleBlur}
        />
        {hasMermaidPreview && (
          <div className="annot-editor-preview" data-annot-preview role="group" aria-label={T("图表预览")}>
            <ReadMarkdown text={text} />
          </div>
        )}
      </div>
    </div>
  );
}
