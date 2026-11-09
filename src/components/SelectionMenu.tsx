// 选区浮条（D266，取代 D122 的「模式开关 + 标注选项抽屉」）：
// 选中文字后出现在选区上方（放不下翻到下方）的一行横条——
//   色点｜底色 / 下划线两段开关｜摘录 批注｜制卡 AI 制卡 AI 解释 查词
// · 点色＝立刻以该色落一条 kind=highlight，浮条不消失；再点色＝改同一条颜色，不新建。
// · 「摘录」＝把当前浮条那条升级 kind=extract（同一条 extracts 行）；无条目时直接建摘录。
// · 形式是常驻两段开关；有当前条目时立即改写 annotation_type，无条目时只改下一次默认值。
// · 批注＝浮条内文本框；有当前条目时防抖落库，无条目时作为下一次点色/摘录的草稿。
// · 动作呈现按 app.selectionBarStyle：text（默认，六个动作全写文字、全条无 svg）|
//   icon（六个动作全用图标、全条无文字标签，名称走 120ms 自绘 tooltip + aria-label）。
// 定位一律走 src/lib/popoverPlace.ts（R22：锚点＝选区包围盒）；高度/宽度变化由 ResizeObserver 重新定位。
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { placePopover, type PopoverRect } from "../lib/popoverPlace";
import { isImeComposing } from "../lib/ime";
import type { SelectionBarStyle } from "../lib/selectionBarSettings";
import { useT } from "../lib/i18n";
import {
  IconSelAiCards,
  IconSelCard,
  IconSelExcerpt,
  IconSelExplain,
  IconSelFormFill,
  IconSelFormUnderline,
  IconSelLookup,
  IconSelNote
} from "./selectionIcons";

/** 批注色板 id（规格 §2）：渲染取 --annot-<name>；颜色不承载调度语义 */
export const ANNOT_COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "magenta"] as const;
export type AnnotColor = (typeof ANNOT_COLORS)[number];

/** 标记形式（v48.41/D81；D266 改为常驻两段开关）：highlight＝底色高亮；underline＝批注色下划线。 */
export type AnnotMarkForm = "highlight" | "underline";

/** 浮条里对选区做事的四个动作（与快捷键 Alt+Z/C/E/D 同源 selAct.*） */
export interface SelectionBarActions {
  manual: () => void;
  aiCards: () => void;
  explain: () => void;
  lookup: () => void;
}

const COLOR_NAMES: Record<string, string> = {
  red: "红", orange: "橙", yellow: "黄", green: "绿", teal: "青", blue: "蓝", purple: "紫", magenta: "品红"
};
const FORM_LABEL: Record<AnnotMarkForm, string> = { highlight: "底色", underline: "下划线" };

export default function SelectionMenu({
  anchor,
  container,
  colors,
  onCreate,
  onUpdateColor,
  onUpdateForm,
  onUpgrade,
  onSaveComment,
  onAlreadyExtracted,
  byLocked = false,
  form = "highlight",
  onFormChange,
  barStyle = "text",
  actions
}: {
  /** 选区包围盒（视口坐标）——R22 判据 4 */
  anchor: PopoverRect;
  /** 阅读容器（视口坐标；浮条夹在它内部，含 8px 边距） */
  container?: PopoverRect | null;
  /** 用户配好的色板（设置键 annotatePalette）；空则不渲染色点 */
  colors: readonly string[];
  /** 首次点色 / 点摘录落库；返回新条目 id（失败返回 null） */
  onCreate: (color: AnnotColor, form: AnnotMarkForm, comment: string, kind: "highlight" | "extract") => Promise<string | null>;
  /** 同一条改色 */
  onUpdateColor: (id: string, color: AnnotColor) => Promise<void>;
  /** 同一条改形式（annotation_type） */
  onUpdateForm: (id: string, form: AnnotMarkForm) => Promise<void>;
  /** 同一条升级为摘录（kind=extract） */
  onUpgrade: (id: string) => Promise<void>;
  /** 批注防抖落库（null＝清空） */
  onSaveComment: (id: string, comment: string | null) => Promise<void>;
  /** 已是摘录时再点「摘录」的提示（父级 showToast） */
  onAlreadyExtracted?: () => void;
  /**
   * 多段选择修饰键按住期间置位：浮条**让路**——整块 pointer-events:none，
   * 好让「按住 Ctrl 拖选下一段」的起笔落在正文而不是浮条上。
   */
  byLocked?: boolean;
  /** 当前默认形式与持久回调（app.annotateForm） */
  form?: AnnotMarkForm;
  onFormChange?: (f: AnnotMarkForm) => void;
  /** 动作呈现：text（默认）| icon */
  barStyle?: SelectionBarStyle;
  /** 四个选区动作；缺省＝不渲染工具组 */
  actions?: SelectionBarActions;
}) {
  const T = useT();
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);
  const [color, setColor] = useState<string>(colors[0] ?? "");
  const [formState, setFormState] = useState<AnnotMarkForm>(form);
  const [kind, setKind] = useState<"none" | "highlight" | "extract">("none");
  const [comment, setComment] = useState("");
  const [commentOpen, setCommentOpen] = useState(false);

  const draftIdRef = useRef<string | null>(null);
  const kindRef = useRef<"none" | "highlight" | "extract">("none");
  const colorRef = useRef(colors[0] ?? "");
  const formRef = useRef<AnnotMarkForm>(form);
  const commentRef = useRef("");
  const commentDirtyRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  /** 选区世代：异步落库往返期间选区可能已换，回来只认发起时的那一代（防旧 id/色/批注绑到新选区） */
  const genRef = useRef(0);
  /** 正在落库的那一代；null＝空闲。按代记录，旧请求的 finally 不得清掉新一代的忙标记 */
  const busyGenRef = useRef<number | null>(null);
  /** 落库往返期间又点了「摘录」：登记意图，等这一笔返回后在同一行上升级 */
  const pendingRef = useRef<"extract" | null>(null);
  /** 展开批注后的延迟聚焦；关闭 / 换选区 / 卸载必须先取消，否则焦点会落回高度 0 的 textarea */
  const commentFocusTimerRef = useRef<number | null>(null);
  const onSaveCommentRef = useRef(onSaveComment);
  onSaveCommentRef.current = onSaveComment;

  const clearCommentFocusTimer = () => {
    if (commentFocusTimerRef.current !== null) {
      window.clearTimeout(commentFocusTimerRef.current);
      commentFocusTimerRef.current = null;
    }
  };

  // 随选区（锚点）更换重置——浮条是「这一次标注」的一次性面板；条目已落库，不丢数据
  useEffect(() => {
    // 上一笔尚未防抖落库的批注先补写（换选区不等于丢弃用户刚输入的文字）
    const oldId = draftIdRef.current;
    if (oldId && commentDirtyRef.current) {
      commentDirtyRef.current = false;
      void onSaveCommentRef.current(oldId, commentRef.current.trim() || null);
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    clearCommentFocusTimer();
    genRef.current += 1;
    busyGenRef.current = null;
    pendingRef.current = null;
    colorRef.current = colors[0] ?? "";
    formRef.current = form;
    setColor(colors[0] ?? "");
    setFormState(form);
    setKind("none");
    kindRef.current = "none";
    draftIdRef.current = null;
    setComment("");
    commentRef.current = "";
    setCommentOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, anchor.width, anchor.height]);

  // 设置页改了默认形式 / 色板：没有当前条目时跟随；有条目时以浮条内操作为准
  useEffect(() => {
    formRef.current = form;
    if (!draftIdRef.current) setFormState(form);
  }, [form]);
  useEffect(() => {
    // 已落库的条目以库里的颜色为准：色板变动不能只改 UI 不改库（会造成浮条与标记不同色）
    if (draftIdRef.current) return;
    if (!colors.includes(color)) {
      colorRef.current = colors[0] ?? "";
      setColor(colors[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors.join("|")]);

  const place = () => {
    const el = ref.current;
    if (!el) return;
    const { left, top, placement } = placePopover({
      anchor,
      container,
      size: { width: el.offsetWidth, height: el.offsetHeight },
      prefer: "above"
    });
    setPos((p) => (p && p.left === left && p.top === top && p.placement === placement ? p : { left, top, placement }));
  };

  useLayoutEffect(place, [anchor.x, anchor.y, anchor.width, anchor.height, container?.x, container?.y, container?.width, container?.height, colors.length, barStyle, formState, kind]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, anchor.width, anchor.height, container?.x, container?.y, container?.width, container?.height]);

  // 批注草稿：离开浮条时把尚未落库的那一笔补写（失败静默，用户在栏内仍可重试）
  useEffect(
    () => () => {
      genRef.current += 1; // 卸载后回来的落库结果不再写回任何状态
      busyGenRef.current = null;
      pendingRef.current = null;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (commentFocusTimerRef.current !== null) window.clearTimeout(commentFocusTimerRef.current);
      const id = draftIdRef.current;
      if (id && commentDirtyRef.current) {
        commentDirtyRef.current = false;
        void onSaveCommentRef.current(id, commentRef.current.trim() || null);
      }
    },
    []
  );

  // 批注框收起后必须失焦：textarea 只是高度收成 0，仍在 DOM 里；
  // 留着焦点会让 Esc 继续被它吃掉（浮条关不掉），开始打字也写进看不见的框里。
  // 同时取消展开时的延迟聚焦——先开再秒关时，定时器不能把焦点又塞回隐藏框。
  useEffect(() => {
    if (commentOpen) return;
    clearCommentFocusTimer();
    const ta = textRef.current;
    if (ta && document.activeElement === ta) ta.blur();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentOpen]);

  const markKind = (next: "none" | "highlight" | "extract") => {
    kindRef.current = next;
    setKind(next);
  };

  const ensureDraft = async (nextKind: "highlight" | "extract", overrideComment?: string, overrideColor?: string) => {
    // 点色是「这一下用这支色」：必须用实参，不能读刚 setState 还没提交的 color
    const useColor = overrideColor ?? color;
    if (!useColor) return;
    const gen = genRef.current;
    const existing = draftIdRef.current;
    if (existing) {
      if (nextKind === "extract" && kindRef.current !== "extract") {
        busyGenRef.current = gen;
        try {
          await onUpgrade(existing);
          if (genRef.current !== gen) return;
          markKind("extract");
        } catch {
          // 升级失败：保持原样，用户可重试（写库错误由主进程记录）
        } finally {
          if (busyGenRef.current === gen) busyGenRef.current = null;
        }
      }
      return;
    }
    if (busyGenRef.current === gen) {
      // 同一选区的首次落库还在路上：只登记升级意图，等它返回后在同一行上补做——
      // 不能直接 return 丢掉，否则「点色后马上点摘录」会留下一条纯高亮。
      if (nextKind === "extract") pendingRef.current = "extract";
      return;
    }
    busyGenRef.current = gen;
    try {
      const text = (overrideComment ?? commentRef.current).trim();
      const formAtCreate = formRef.current;
      const id = await onCreate(useColor as AnnotColor, formAtCreate, text, nextKind);
      // 往返期间选区可能已换：旧请求的 id 绝不能绑到新选区的浮条上
      if (genRef.current !== gen) return;
      if (!id) {
        pendingRef.current = null;
        return;
      }
      draftIdRef.current = id;
      commentDirtyRef.current = false;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      markKind(nextKind);
      // 落库途中点过「摘录」：同一条记录上升级（不新建第二条）
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending === "extract" && nextKind !== "extract") {
        try {
          await onUpgrade(id);
          if (genRef.current !== gen) return;
          markKind("extract");
        } catch {
          // 升级失败：保留已落库的高亮，用户可重试
        }
      }
      if (genRef.current !== gen) return;
      // 落库往返期间用户可能又点了色 / 改了形式 / 继续打字：以最新一次操作为准补写
      if (colorRef.current !== useColor) void onUpdateColor(id, colorRef.current as AnnotColor);
      if (formRef.current !== formAtCreate) void onUpdateForm(id, formRef.current);
      const pendingComment = commentRef.current.trim();
      if (pendingComment !== text) void onSaveCommentRef.current(id, pendingComment || null);
    } catch {
      // 落库失败：不绑定草稿，用户可重试（写库错误由主进程记录）。
      // 同代排队中的「摘录」也要作废，否则下一次点色成功会被残留意图自动升级。
      if (genRef.current === gen) pendingRef.current = null;
    } finally {
      if (busyGenRef.current === gen) busyGenRef.current = null;
    }
  };

  const pickColor = (c: string) => {
    colorRef.current = c;
    setColor(c);
    const id = draftIdRef.current;
    if (id) {
      void onUpdateColor(id, c as AnnotColor);
      return;
    }
    void ensureDraft("highlight", undefined, c);
  };

  const pickForm = (f: AnnotMarkForm) => {
    formRef.current = f;
    setFormState(f);
    onFormChange?.(f);
    const id = draftIdRef.current;
    if (id) void onUpdateForm(id, f);
  };

  const clickExtract = () => {
    if (kindRef.current === "extract") {
      onAlreadyExtracted?.();
      return;
    }
    void ensureDraft("extract");
  };

  const flushComment = (value: string) => {
    commentDirtyRef.current = false;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const id = draftIdRef.current;
    if (id) void onSaveComment(id, value.trim() || null);
  };

  const scheduleCommentSave = (value: string) => {
    commentDirtyRef.current = true;
    if (!draftIdRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      flushComment(value);
    }, 350);
  };

  const toggleComment = () => {
    const next = !commentOpen;
    clearCommentFocusTimer();
    setCommentOpen(next);
    if (next) {
      // 记下定时器：开→关、换选区、卸载都先取消，避免焦点落回已收起的 textarea
      commentFocusTimerRef.current = window.setTimeout(() => {
        commentFocusTimerRef.current = null;
        textRef.current?.focus();
      }, 120);
    }
  };

  // 点按钮不夺走正文选区（textarea 例外：它要拿焦点）
  const keepSel = (e: ReactMouseEvent) => e.preventDefault();

  const isIcon = barStyle === "icon";
  const extract = kind === "extract";
  const hasComment = comment.trim().length > 0;

  const actBtn = (key: string, label: string, tip: string, icon: ReactNode, onClick: () => void, extra?: string) => (
    <button
      key={key}
      type="button"
      className={`sel-btn${isIcon ? " ic" : ""}${key === "note" || key === "extract" ? " sel-primary" : ""}${extra ? ` ${extra}` : ""}`}
      data-sel-act={key}
      {...(key === "extract" ? { "data-annot-extract": "", "aria-pressed": extract } : {})}
      title={isIcon ? undefined : tip}
      aria-label={label}
      {...(isIcon ? { "data-tip": tip } : {})}
      onMouseDown={keepSel}
      onClick={onClick}
    >
      {isIcon ? icon : label}
      {key === "note" && hasComment && <i className="sel-dot" aria-hidden="true" />}
    </button>
  );

  return (
    <div
      ref={ref}
      className={`menu selection-menu sel-bar${byLocked ? " menu-locked" : ""}`}
      role="dialog"
      aria-label={T("选中文字")}
      data-sel-actions
      data-kind={kind}
      data-form={formState}
      data-bar-style={barStyle}
      data-place={pos?.placement ?? "above"}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      <div className={`sel-clip${commentOpen ? " open" : ""}`}>
        <div>
          <div className="comment-inner">
            <textarea
              ref={textRef}
              className="menu-comment"
              rows={2}
              placeholder={T("写批注…（Ctrl+Enter 用当前色保存）")}
              aria-label={T("批注内容")}
              tabIndex={commentOpen ? 0 : -1}
              value={comment}
              onChange={(e) => {
                const v = e.target.value;
                setComment(v);
                commentRef.current = v;
                scheduleCommentSave(v);
              }}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return; // 组字中的 Ctrl+Enter/Esc 属于输入法，不保存/不收面板
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (draftIdRef.current) flushComment(commentRef.current);
                  else void ensureDraft("highlight", commentRef.current);
                } else if (e.key === "Escape") {
                  // 先收批注框并立刻交还焦点：否则 textarea 只是高度收成 0，
                  // 仍持有焦点，第二次 Esc 还会被它吃掉，浮条永远关不掉。
                  e.stopPropagation();
                  setCommentOpen(false);
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="sel-row">
        {colors.length > 0 && (
          <div className="swatches" role="group" aria-label={T("标注色")}>
            {colors.map((c) => {
              const on = color === c;
              const colorWord = T(COLOR_NAMES[c] ?? c);
              return (
                <button
                  key={c}
                  type="button"
                  className={`swatch${on ? " on" : ""}`}
                  data-color={c}
                  aria-pressed={on}
                  title={T("{color}色 · 点色即高亮", { color: colorWord })}
                  aria-label={T("标注色 {c}", { c: colorWord })}
                  onMouseDown={keepSel}
                  onClick={() => pickColor(c)}
                >
                  <i style={{ background: c.startsWith("#") ? c : `var(--annot-${c})` }} />
                </button>
              );
            })}
          </div>
        )}

        <span className={`form-switch${isIcon ? " icon" : ""}`} data-form-toggle role="group" aria-label={T("标记形式")}>
          {(["highlight", "underline"] as const).map((f) => {
            const on = formState === f;
            return (
              <button
                key={f}
                type="button"
                className={`form-seg${on ? " on" : ""}`}
                data-annot-form={f}
                aria-pressed={on}
                aria-label={T(FORM_LABEL[f])}
                {...(isIcon ? { "data-tip": T(FORM_LABEL[f]) } : {})}
                onMouseDown={keepSel}
                onClick={() => pickForm(f)}
              >
                {isIcon ? (f === "highlight" ? <IconSelFormFill /> : <IconSelFormUnderline />) : T(FORM_LABEL[f])}
              </button>
            );
          })}
        </span>

        <i className="sel-sep" aria-hidden="true" />
        {actBtn("extract", T("摘录"), T("摘录（同一条升级，不新建）"), <IconSelExcerpt />, clickExtract, extract ? "on" : undefined)}
        {actBtn("note", T("批注"), T("批注（先写再点颜色）"), <IconSelNote />, toggleComment, commentOpen ? "on" : undefined)}

        {actions && (
          <>
            <i className="sel-sep" aria-hidden="true" />
            {actBtn("manual", T("制卡"), T("就地制卡 · Alt+Z"), <IconSelCard />, actions.manual)}
            {actBtn("aiCards", T("AI 制卡"), T("AI 制卡 · Alt+C"), <IconSelAiCards />, actions.aiCards)}
            {actBtn("explain", T("AI 解释"), T("AI 解释 · Alt+E"), <IconSelExplain />, actions.explain)}
            {actBtn("lookup", T("查词"), T("查词 · Alt+D"), <IconSelLookup />, actions.lookup)}
          </>
        )}
      </div>
    </div>
  );
}
