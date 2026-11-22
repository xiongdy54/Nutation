// AI 面板（解释侧栏 / 制卡预览）
// 批 4（Task 5）：从 Reader.tsx 原样搬出（纯移动，零行为改动）——摘录页与阅读器共用同一份实现。
// v48.51（D91 §5.5）：答案尾部的事后建议轻提示行（仅 auto 路由进 ste 且 points=0 且改写≈原文时
// 出现——用户多半更想要概念解释）。
// v48.100（D144 #3）：explain 分支首行的「解读方式」切换器（D91 §5.2）退役——方式表达唯一归口＝
// 解释板块悬浮按钮行（ExplainModeBar 四 ghost 钮，本文件导出）；切换即重跑（D91 §5.3）语义保留，
// 由按钮行 / 事后建议钮经宿主 changeExplainMode 承载。
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { growTextarea } from "../lib/autoGrow";
import { isImeComposing } from "../lib/ime";
import ReadMarkdown from "./editor/ReadMarkdown";
import { GenUIPanelSurface } from "./genui/GenUIContext";
import CardSuggestions from "./genui/CardSuggestions";
import { normalizeComponentFences } from "../lib/genui/spec";
import { parseFollowUps, type CardDraft, type CardGenMode, type FollowUpGroup, type OcclusionRegion } from "../lib/cards";
import { isLikelySameText, parseSteMarkers, stripSteMarkers, type ExplainModePref } from "../lib/explainRouter";
import Dropdown from "./Dropdown";
import OcclusionShapes from "./OcclusionShapes";
import { IconCheck, IconChevronDown, IconClose, IconCopy, IconPencil } from "./icons";
import { copyText } from "../lib/genui/clipboard";
import type { AskThreadItem } from "../lib/useSelectionActions";
import { useT } from "../lib/i18n";
import { aiGateway } from "../lib/ai";
import { steWeakModel } from "../lib/steJson";

/** D144 §4.3：解释板块「当前方式」四值（三解读方式复用 ExplainModePref 的会话内记忆 + 自由提问） */
export type ExplainComposerMode = "auto" | "general" | "ste" | "ask";

const EXPLAIN_MODE_ITEMS: Array<[ExplainComposerMode, string]> = [
  ["auto", "自动"],
  ["general", "通用解读"],
  ["ste", "简明解读"],
  ["ask", "自由提问"]
];

/**
 * v48.100（D144 §3.1/§4.3）：解读方式悬浮按钮行（四 ghost 钮）——取代 v48.51（D91 §5.2）的
 * 解读方式下拉（该导出已退役）。按钮双职＝迁移「当前方式」+（有字时）按该方式发送；
 * §4.3 语义矩阵与发送路由由宿主 SelectionPanels 承载，本组件只呈现（§7 状态样式在 theme.css）。
 */
export function ExplainModeBar({
  mode,
  hasText,
  hasContext,
  onModeSelect
}: {
  mode: ExplainComposerMode;
  /** 输入框是否有字（§7 空输入态判定之一） */
  hasText: boolean;
  /** 是否有解释语境（解释面板在场或追问线程非空） */
  hasContext: boolean;
  onModeSelect: (m: ExplainComposerMode) => void;
}) {
  return (
    <>
      {EXPLAIN_MODE_ITEMS.map(([m, label]) => (
        <button
          key={m}
          type="button"
          className={`wb-mode-btn${mode === m ? " on" : ""}${!hasText && !hasContext ? " idle" : ""}`}
          data-mode={m}
          aria-pressed={mode === m}
          onClick={() => onModeSelect(m)}
        >
          <ModeLabel label={label} />
        </button>
      ))}
    </>
  );
}

/** EXPLAIN_MODE_ITEMS 是模块级常量（label 存键），渲染时经 useT 翻译 */
function ModeLabel({ label }: { label: string }) {
  const T = useT();
  return <>{T(label)}</>;
}

// ---------- D123：计时与状态行（静态方块点、无动画；计时自算——摘录页曾硬编码 elapsedSec=0） ----------
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 单行进度：「● 思考中 0:12 · 2052 字  [停止]」（计时＝从点击起累计，每秒刷新） */
export function AIStatus({
  startedAt,
  thinking,
  progress,
  onStop,
  label
}: {
  startedAt?: number;
  thinking?: number;
  progress?: number;
  onStop?: () => void;
  label?: string;
}) {
  const now = useNow(true);
  const T = useT();
  const chars = progress || thinking || 0;
  const text = label ?? (progress ? T("生成中") : thinking ? T("思考中") : T("等待响应"));
  return (
    <div className="ai-status" role="status" aria-live="polite" data-testid="ai-status">
      <span className="ai-status-dot" aria-hidden="true" />
      <span>{text}</span>
      <span className="mono ai-status-time">{fmtElapsed(startedAt ? now - startedAt : 0)}</span>
      {chars > 0 && <span className="mono ai-status-chars">{T("{n} 字", { n: chars })}</span>}
      {onStop && (
        <button type="button" className="btn btn-outline btn-sm ai-status-stop" onClick={onStop}>
          {T("停止")}
        </button>
      )}
    </div>
  );
}

/** v49.163 / D333：AI 输出的「所见文本」——等同手动框选复制：克隆渲染结果，剔除组件工具条/按钮，
    KaTeX 公式只留 TeX 源（去掉 HTML 渲染层，免得公式文字重复），离屏挂载后取 innerText（保留段落换行）。 */
export function answerPlainText(el: HTMLElement | null, fallback: string): string {
  if (!el) return fallback;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, [role='toolbar'], .nui-toolbar").forEach((n) => n.remove());
  clone.querySelectorAll(".katex").forEach((k) => {
    const tex = k.querySelector("annotation")?.textContent;
    if (tex) k.replaceWith(document.createTextNode(k.closest(".katex-display") ? `$$${tex}$$` : `$${tex}$`));
  });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;width:600px;white-space:normal;";
  host.appendChild(clone);
  document.body.appendChild(host);
  const text = clone.innerText;
  host.remove();
  return text.replace(/\n{3,}/g, "\n\n").trim() || fallback;
}

/** v49.163 / D333：AI 输出块——回答正文 + 底部动作条（左：一键复制；右：宿主给的制卡动作）。
    三处 AI 输出（解释页主回答 / 自由追问线程 / 知识点解释）共用，按钮排布与样式同一规范。 */
export function AnswerBlock({ answer, ground, done, action }: { answer: string; ground: (string | null | undefined)[]; done: boolean; action?: ReactNode }) {
  const T = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    const ok = await copyText(answerPlainText(ref.current, stripSteMarkers(answer).trim()));
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <>
      <div className="ai-answer" ref={ref}>
        {/* v48.74（D118 §3①）：渲染前剥离 <!--ste:…--> 机器标记——react-markdown@10 会把未挂 rehype-raw 的
            HTML 注释以转义文本渲染出来；answer 数据层原样保留（parseSteMarkers / 相似性判定不受影响） */}
        <GenUIPanelSurface ground={ground}><ReadMarkdown text={normalizeComponentFences(stripSteMarkers(answer))} /></GenUIPanelSurface>
      </div>
      {done && (
        <div className="ai-answer-foot" data-testid="ai-answer-foot">
          <button type="button" className="btn btn-secondary btn-sm" data-testid="ai-answer-copy" title={T("复制 AI 输出的全部内容")} onClick={() => void copy()}>
            {copied ? <IconCheck size={14} className="btn-ico" /> : <IconCopy size={14} className="btn-ico" />}
            {copied ? T("已复制") : T("复制")}
          </button>
          {action}
        </div>
      )}
    </>
  );
}

/** AI 解释页：自由追问线程（每条回复悬停出现「制卡」＝以该回复为材料走 AI 制卡） */
export function ExplainThread({ items, onMake }: { items: AskThreadItem[]; onMake: (answer: string) => void }) {
  const T = useT();
  if (items.length === 0) return null;
  return (
    <div className="wb-thread" data-testid="wb-thread">
      {items.map((it) => (
        <div key={it.id} className="wb-turn">
          <div className="wb-q">{it.q}</div>
          {it.running && !it.answer && <AIStatus startedAt={it.startedAt} thinking={it.thinking} />}
          {it.error && <div className="ai-error">{it.error}</div>}
          {it.answer && (
            <div className="wb-a">
              <AnswerBlock
                answer={it.answer}
                ground={[it.src, it.q, it.answer]}
                done={!it.running}
                action={
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onMake(it.answer as string)}>
                    {T("就此制卡")}
                  </button>
                }
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** AI 解释板块底部输入条：单行 32px 与「发送」同高对齐，随输入增高（≤120px）；Enter 发送、Shift+Enter 换行、IME 组合态不发送。
 * v48.100（D144 #3）：值受控上提（宿主持有——「引用」头部插入与 #5 选单落点的数据面）；
 * ref 句柄 insertQuote＝§4.4-c「引用」动作落点：头部插入引用块（既有草稿整体保留在其后，永不覆盖）、
 * 聚焦输入框并把光标落到文末（板块开合由宿主决定——引用不自动展开，§4.4-c）。 */
export interface ChatComposerHandle {
  insertQuote: (text: string) => void;
}

export const ChatComposer = forwardRef<ChatComposerHandle, {
  busy: boolean;
  onSend: (q: string) => void;
  /** 受控值（宿主上提）；发送成功后由本组件经 onValueChange("") 清空 */
  value: string;
  onValueChange: (v: string) => void;
}>(function ChatComposer({ busy, onSend, value, onValueChange }, ref) {
  const T = useT();
  const refEl = useRef<HTMLTextAreaElement | null>(null);
  // 句柄内读最新值/回调（refs 镜像，句柄身份稳定、无陈旧闭包）
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onValueChange);
  onChangeRef.current = onValueChange;
  useLayoutEffect(() => {
    if (refEl.current) growTextarea(refEl.current, 120);
  }, [value]);
  const send = () => {
    const q = value.trim();
    if (!q || busy) return;
    onSend(q);
    onChangeRef.current("");
  };
  useImperativeHandle(
    ref,
    () => ({
      insertQuote(text: string) {
        const t = text.trim();
        if (!t) return;
        // 引用块（逐行 "> " 前缀）+ 空行；既有草稿保留在其后（§4.4-c 永不覆盖）
        const block = t.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
        onChangeRef.current(block + valueRef.current);
        requestAnimationFrame(() => {
          const el = refEl.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length); // 光标落文末
          }
        });
      }
    }),
    []
  );
  return (
    <div className="wb-composer" data-testid="wb-composer">
      <textarea
        ref={refEl}
        rows={1}
        value={value}
        aria-label={T("追问 AI")}
        placeholder={T("追问，或自由提问…")}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button type="button" className="btn btn-primary btn-sm wb-composer-send" disabled={!value.trim() || busy} onClick={send}>
        {T("发送")}
      </button>
    </div>
  );
});

type KpGroup = { kpTitle: string; items: string[] };

/** AI 制卡页「知识点与后续可补」：勾选 · 条目（✎ 可编辑）· 解释（完成后可展开/收起）；
    制卡只有两条路径——勾选后底部批量条，或展开解释里的「制卡」（行内不再有重复的制卡钮）。 */
function FollowUpList({
  panel,
  groups,
  onExploration,
  onFollowUpCards
}: {
  panel: {
    /** D300：选文（组件落地校验的出处之一） */
    text: string;
    running: boolean;
    followUpBusy?: string[];
    followUpErrors?: Record<string, string>;
    explorations?: { id: number; item: string; srcKey?: string; question?: string; answer?: string; running: boolean; startedAt?: number; thinking?: number; error?: string }[];
  };
  groups: KpGroup[];
  onExploration: (item: string, kpTitle: string, srcKey?: string) => void;
  onFollowUpCards: (item: string, kpTitle: string, hint?: string) => void | Promise<void>;
}) {
  const T = useT();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [making, setMaking] = useState(false);
  const textOf = (item: string) => edited[item] ?? item;
  const expOf = (item: string) =>
    (panel.explorations ?? []).filter((e) => (e.srcKey ?? e.item) === item && e.item === textOf(item)).pop();
  const all = groups.flatMap((g) => g.items.map((item) => ({ item, kpTitle: g.kpTitle })));
  const picked = all.filter((x) => checked.has(x.item));
  const toggle = (item: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(item)) n.delete(item);
      else n.add(item);
      return n;
    });
  const startEdit = (item: string) => {
    setEditing(item);
    setDraft(textOf(item));
  };
  const commitEdit = (item: string) => {
    const v = draft.trim();
    setEditing(null);
    if (v && v !== textOf(item)) setEdited((m) => ({ ...m, [item]: v }));
  };
  const makeAll = async () => {
    setMaking(true);
    try {
      for (const x of picked) {
        const exp = expOf(x.item);
        await onFollowUpCards(textOf(x.item), x.kpTitle, exp?.answer);
      }
      setChecked(new Set());
    } finally {
      setMaking(false);
    }
  };
  return (
    <div className="ai-kps" data-testid="ai-kps">
      <div className="ai-kps-head">
        <span className="ai-kps-title">{T("知识点与后续可补")}</span>
        <button
          type="button"
          className="ai-link"
          onClick={() => setChecked(picked.length === all.length ? new Set() : new Set(all.map((x) => x.item)))}
        >
          {picked.length === all.length ? T("取消全选") : T("全选")}
        </button>
      </div>
      {groups.map((g, gi) => (
        <div key={gi} className="ai-kp">
          <div className="ai-kp-title">{g.kpTitle}</div>
          {g.items.map((item) => {
            const text = textOf(item);
            const exp = expOf(item);
            const busy = (panel.followUpBusy ?? []).includes(text);
            const err = panel.followUpErrors?.[text];
            const isOpen = open.has(item);
            const explainBtn = exp?.running ? (
              <button type="button" className="ai-kp-explain is-busy" disabled>
                {T("解释中")}
              </button>
            ) : exp?.answer ? (
              <button
                type="button"
                className="ai-kp-explain is-done"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(item)) n.delete(item);
                    else n.add(item);
                    return n;
                  })
                }
              >
                {isOpen ? T("收起") : T("展开")}
                <IconChevronDown size={11} className={isOpen ? "is-flip" : undefined} />
              </button>
            ) : (
              <button
                type="button"
                className="ai-kp-explain"
                disabled={panel.running}
                onClick={() => {
                  onExploration(text, g.kpTitle, item);
                  setOpen((s) => new Set(s).add(item));
                }}
              >
                {exp?.error ? T("重试") : T("解释")}
              </button>
            );
            return (
              <div key={item} className="ai-kp-item" data-testid="ai-kp-item">
                <div className="ai-kp-row">
                  <input
                    type="checkbox"
                    className="ai-kp-check"
                    checked={checked.has(item)}
                    aria-label={T("选择：{text}", { text })}
                    onChange={() => toggle(item)}
                  />
                  {editing === item ? (
                    <>
                      <input
                        className="ai-kp-edit"
                        value={draft}
                        autoFocus
                        aria-label={T("编辑条目")}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (isImeComposing(e)) return; // 组字中的 Enter/Esc 属于输入法（确认/取消候选词），不提交/不关编辑框
                          if (e.key === "Enter") commitEdit(item);
                          else if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <button type="button" className="ai-icon" title={T("确定")} onClick={() => commitEdit(item)}>
                        <IconCheck size={13} />
                      </button>
                      <button type="button" className="ai-icon" title={T("取消")} onClick={() => setEditing(null)}>
                        <IconClose size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="ai-kp-text">{text}</span>
                      <button type="button" className="ai-icon ai-kp-pencil reveal-on-hover" title={T("编辑条目（改成你想了解的内容再点解释）")} onClick={() => startEdit(item)}>
                        <IconPencil size={13} />
                      </button>
                      {explainBtn}
                    </>
                  )}
                </div>
                {exp?.running && <div className="ai-kp-note mono">{T("AI 正在回答…")}</div>}
                {exp?.error && <div className="ai-error">{exp.error}</div>}
                {err && <div className="lint lint-error">{err}</div>}
                {busy && <div className="ai-kp-note mono">{T("补充制卡中…")}</div>}
                {isOpen && exp?.answer && (
                  <div className="ai-kp-exp">
                    <AnswerBlock
                      answer={exp.answer}
                      ground={[panel.text, item, exp.question, exp.answer]}
                      done={!exp.running}
                      action={
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy || panel.running}
                          onClick={() => void onFollowUpCards(text, g.kpTitle, exp.answer)}
                        >
                          {T("制卡")}
                        </button>
                      }
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {picked.length > 0 && (
        <div className="ai-kps-bar" data-testid="ai-kps-bar">
          <span>{T("已选 {n} 项", { n: picked.length })}</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={making || panel.running} onClick={() => void makeAll()}>
            {making ? T("制卡中…") : T("制卡 ({n})", { n: picked.length })}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AIPanel({
  panel,
  onAccept,
  onAcceptOcclusion,
  onEdit,
  onSplitReverse,
  onRejectAll,
  onExplain,
  onMakeCards,
  onModeChange,
  mode = "auto",
  onSearchBackground,
  onFollowUpCards,
  onExploration,
  onAsk,
  explainMode = "auto",
  onExplainModeChange,
  /** v48.74（D118 §3④）：生成中「停止」——经宿主 stopAIRun() 走 ai:abort 取消当前请求 */
  onStop,
  elapsedTick = 0
}: {
  panel: {
    kind: "explain" | "cards" | "occlusion";
    text: string;
    answer?: string;
    drafts?: CardDraft[];
    accepted?: Set<number>;
    blockReasons?: string[];
    batchId?: string;
    running: boolean;
    progress?: number;
    thinking?: number;
    startedAt?: number;
    elapsedSec?: number;
    searching?: boolean;
    searched?: boolean;
    error?: string;
    mode?: CardGenMode;
    routeLabel?: string;
    routeForm?: string;
    image?: { dataUrl: string; assetPath: string };
    regions?: OcclusionRegion[];
    kps?: { id: string; summary: string }[];
    supplemental?: Set<number>;
    followUpBusy?: string[];
    followUpStarted?: Record<string, number | undefined>;
    followUpErrors?: Record<string, string>;
    explorations?: {
      id: number;
      item: string;
      kpTitle: string;
      question: string;
      answer?: string;
      running: boolean;
      startedAt?: number;
      thinking?: number;
      error?: string;
    }[];
  };
  onAccept: (draft: CardDraft, draftIndex: number, edited?: Partial<CardDraft>) => Promise<void>;
  onAcceptOcclusion: (draft: CardDraft, draftIndex: number) => Promise<void>;
  onEdit: (draftIndex: number, patch: Partial<CardDraft>) => void;
  onSplitReverse: (draftIndex: number) => void;
  onRejectAll: () => void;
  onExplain: (question: string | null) => void;
  onMakeCards: () => void;
  onModeChange: (mode: CardGenMode) => void;
  mode?: CardGenMode;
  onSearchBackground: () => void;
  onFollowUpCards: (item: string, kpTitle: string, hint?: string) => void | Promise<void>;
  onExploration: (item: string, kpTitle: string, srcKey?: string) => void;
  /** D123：解释页快捷追问（通俗解释/严格定义…）走自由追问线程；缺省回落 onExplain（替换式） */
  onAsk?: (question: string) => void;
  /** v48.51（D91 §5.2）：解读方式三态（会话内记忆，auto=默认） */
  explainMode?: ExplainModePref;
  /** v48.51（D91 §5.3）：切换即重跑（重发请求在宿主 changeExplainMode） */
  onExplainModeChange?: (m: ExplainModePref) => void;
  /** v48.74（D118 §3④）：生成中「停止」（缺省不渲染按钮——宿主未接取消通道时） */
  onStop?: () => void;
  elapsedTick?: number;
}) {
  const T = useT();
  // v48.51（D91 §5.5 事后建议）：仅 auto 路由进 ste 的结果、流式完成后，机器标记 points=0
  // 且改写与原文几乎一致（文本其实清晰，用户多半更想要概念解释）→ 答案尾部一行轻提示。
  // 显式选择「简明解读」= 用户自判需要简化流程，不打扰（§4.1 门控取消的本意）。
  const steMarkers = panel.kind === "explain" && panel.answer ? parseSteMarkers(panel.answer) : null;
  const suggestGeneral =
    panel.kind === "explain" &&
    !!panel.answer &&
    !panel.running &&
    !panel.error &&
    explainMode === "auto" &&
    !!onExplainModeChange &&
    steMarkers !== null &&
    steMarkers.points === 0 &&
    isLikelySameText(panel.text, stripSteMarkers(panel.answer));
  // v49.134（D301）：简明解读对指令遵从要求高——当前模型参数量 ≤14B 时，在结果下方提示换用更强的模型
  const [weakModel, setWeakModel] = useState(false);
  const isSteAnswer = steMarkers?.points !== undefined;
  useEffect(() => {
    if (!isSteAnswer) return;
    let alive = true;
    aiGateway.getConfig().then((c) => alive && setWeakModel(steWeakModel(c?.model ?? ""))).catch(() => {});
    return () => { alive = false; };
  }, [isSteAnswer]);
  const isOcclusion = panel.kind === "occlusion";
  const followUpGroups: FollowUpGroup[] = panel.kps ? parseFollowUps(panel.kps) : [];
  const nowTick = elapsedTick;
  const busySec = (item: string) => {
    const started = panel.followUpStarted?.[item];
    return started ? Math.max(0, Math.round((nowTick - started) / 1000)) : 0;
  };
  const explSec = (e: { startedAt?: number }) =>
    e.startedAt ? Math.max(0, Math.round((nowTick - e.startedAt) / 1000)) : 0;

  return (
    <div className="ai-panel">
      {/* v48.52（D92 §6.1）：CardDock 头行改为页签条（AI 解释｜AI 制卡）+「＋制卡」+ 收起/关闭，
          不再承载标题（`.ai-panel-title` 仅存于 DictPanel 自有头行）；关闭＝dock 的 data-dock-close 钮，
          走宿主既有关闭链含批次 reject。本组件只渲染 .ai-panel-body（全部钩子零改动）。 */}

      <div className="ai-panel-body">
        <blockquote className="ai-quote">{panel.text}</blockquote>

        {/* D123：单行进度（计时自算，不再依赖宿主传入的 elapsedSec——摘录页曾硬编码 0）；
            v48.74（D118 §3④）：生成中可手动停止 */}
        {(panel.kind === "cards" || isOcclusion) && panel.running && (
          <AIStatus startedAt={panel.startedAt} thinking={panel.thinking} progress={panel.progress} onStop={onStop} />
        )}
        {panel.searching && <div className="ai-streaming mono">{T("正在联网检索事件背景…")}</div>}
        {panel.error && <div className="ai-error">{panel.error}</div>}

        {panel.kind === "explain" && panel.running && !panel.answer && (
          <AIStatus startedAt={panel.startedAt} thinking={panel.thinking} onStop={onStop} />
        )}

        {panel.kind === "explain" && panel.answer && (
          <>
            {/* v49.163 / D333：底部动作条＝左「复制」右「就此制卡」（主动作 primary）；追问快捷钮另起一行（outline 轻量选项） */}
            <AnswerBlock
              answer={panel.answer}
              ground={[panel.text, panel.answer]}
              done={!panel.running}
              action={
                <button className="btn btn-primary btn-sm" disabled={panel.running} onClick={onMakeCards}>
                  {T("就此制卡")}
                </button>
              }
            />
            {weakModel && isSteAnswer && !panel.running && (
              <div className="ai-suggest" data-testid="ste-weak-model">
                <span>{T("当前模型较小，简明解释可能达不到规范要求；建议在设置中换用更强的模型。")}</span>
              </div>
            )}
            {/* v48.51（D91 §5.5）：事后建议——路由错配的语义级纠偏，点击即按通用解读重跑（reader-explain scope） */}
            {suggestGeneral && (
              <div className="ai-suggest" data-testid="explain-suggest">
                <span>{T("这段更像概念解释，切换到通用解读？")}</span>
                <button className="btn btn-outline btn-sm" onClick={() => onExplainModeChange?.("general")}>
                  {T("切换到通用解读")}
                </button>
              </div>
            )}
            {/* v49.163 / D333：追问快捷钮（outline 轻量选项；「就此制卡」已移入上方动作条） */}
            <div className="ai-actions ai-followups">
              {([["通俗解释", "通俗解释"], ["严格定义", "严格定义"], ["举个例子", "举个例子"], ["为什么", "为什么会这样"]] as const).map(([label, q]) => (
                <button key={label} className="btn btn-outline btn-sm" onClick={() => (onAsk ? onAsk(q) : onExplain(q))}>
                  {T(label)}
                </button>
              ))}
            </div>
          </>
        )}

        {/* M1.2：材料类型路由展示 + 手动覆盖 */}
        {panel.kind === "cards" && (
          <div className="ai-route-row" data-testid="ai-route-row">
            <span className="ai-route-label">{T("材料类型")}</span>
            <Dropdown
              align="left"
              title={T("材料类型")}
              value={mode}
              options={[
                { value: "auto", label: T("自动识别") },
                { value: "card-generation", label: T("概念论述") },
                { value: "card-formula", label: T("公式推导") },
                { value: "card-seq", label: T("流程背诵") },
                { value: "card-enum", label: T("枚举清单") },
                { value: "card-literature", label: T("文学/诗歌背诵") }
              ]}
              onChange={(m) => onModeChange(m as CardGenMode)}
            />
            <span className="ai-route-meta mono">
              {panel.routeLabel
                ? mode === "auto"
                  ? T("识别为{label} · 默认形式：{form}", { label: T(panel.routeLabel), form: T(panel.routeForm ?? "") })
                  : T("默认形式：{form}", { form: T(panel.routeForm ?? "") })
                : ""}
            </span>
            {(panel.drafts?.length || panel.error) && !panel.running && (
              <button type="button" className="ai-link ai-route-rerun" title={T("按当前材料类型重新生成")} onClick={onMakeCards}>
                {T("重跑")}
              </button>
            )}
          </div>
        )}

        {/* D123：知识点与后续可补（勾选 · 可编辑条目 · 解释；解释内容行内展开，已并入原「询问 AI 相关内容」区） */}
        {panel.kind === "cards" && followUpGroups.length > 0 && (
          <FollowUpList
            panel={panel}
            groups={followUpGroups}
            onExploration={onExploration}
            onFollowUpCards={onFollowUpCards}
          />
        )}

        {isOcclusion && panel.image && !panel.running && (
          <div className="occlusion-stage occlusion-preview">
            <img src={panel.image.assetPath} alt="" className="occlusion-img" />
            {/* v25：形状化预览（矩形/椭圆/多边形）——与复习端同口径渲染 */}
            <OcclusionShapes
              occlusion={{
                rects: (panel.regions ?? []).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, ord: r.ord })),
                shapes: (panel.regions ?? []).map((r) => r.shape ?? null)
              }}
              cardOrd={0}
              variant="proposal"
            />
            {(panel.regions ?? []).map((r) => (
              <span
                key={r.ord}
                className="occlusion-ord mono"
                style={{ left: `${r.x}%`, top: `${r.y}%` }}
              >
                {r.ord + 1}
              </span>
            ))}
          </div>
        )}

        {(panel.kind === "cards" || isOcclusion) && (
          <CardSuggestions
            panel={panel}
            onAccept={onAccept}
            onAcceptOcclusion={onAcceptOcclusion}
            onEdit={onEdit}
            onSplitReverse={onSplitReverse}
            onRejectAll={onRejectAll}
            onSearchBackground={onSearchBackground}
          />
        )}

      </div>
    </div>
  );
}
