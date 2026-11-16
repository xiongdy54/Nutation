// v49.132 / D299（任务卡 T-C1）：制卡建议组件——从 AIPanel「AI 制卡页」原样抽出（行为与样式零变化）：
// 阻断原因 + 联网补背景、逐张草稿（CardLint / 记忆接地 / 归属补限定 / 接受·编辑·转翻转卡）、整批拒绝。
// props 化后可被其他宿主复用（导图节点、复习难点卡、摘录队列……），宿主只需提供 drafts 与回调。
import { useState } from "react";
import { lintCard, needsAttribution, parseCloze, type CardDraft, type CardQualifier } from "../../lib/cards";
import { sanitizeDomain } from "../../lib/udc";
import { IconAlert } from "../icons";
import { useT } from "../../lib/i18n";

// 防 AI 返回字段类型漂移导致渲染崩溃（ruleNotes/warnings 可能是字符串）
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return v.split(/[,;；、]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** D121 §2.6：归属标签文案（模块级纯函数——tr 由调用方传 useT 的 T，node 侧缺省恒等） */
export function qualifierLabel(q: CardQualifier, tr: (s: string) => string = (s) => s): string {
  switch (q.stance) {
    case "author": return tr("作者观点");
    case "reported": return q.holder ? `${tr("转述")}·${q.holder}` : tr("转述");
    case "criticized": return q.holder ? `${tr("批判对象")}·${q.holder}` : tr("批判对象");
    case "consensus": return tr("公认");
    default: return tr("归属未定");
  }
}

export interface CardSuggestionsData {
  kind: "explain" | "cards" | "occlusion";
  drafts?: CardDraft[];
  accepted?: Set<number>;
  supplemental?: Set<number>;
  blockReasons?: string[];
  running: boolean;
  searching?: boolean;
  searched?: boolean;
}

export interface CardSuggestionsProps {
  panel: CardSuggestionsData;
  onAccept: (draft: CardDraft, draftIndex: number, edited?: Partial<CardDraft>) => Promise<void>;
  onAcceptOcclusion: (draft: CardDraft, draftIndex: number) => Promise<void>;
  onEdit: (draftIndex: number, patch: Partial<CardDraft>) => void;
  onSplitReverse: (draftIndex: number) => void;
  onRejectAll: () => void;
  onSearchBackground: () => void;
}

export default function CardSuggestions({ panel, onAccept, onAcceptOcclusion, onEdit, onSplitReverse, onRejectAll, onSearchBackground }: CardSuggestionsProps) {
  const T = useT();
  const isOcclusion = panel.kind === "occlusion";
  const [qualInput, setQualInput] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<number, { front?: string; back?: string }>>({});
  // v46（M14-UM2，§6.7.3）：memoryRef 校验失败的卡「情境来源存疑」默认不勾选——接受按钮需二次点击确认
  const [memoryWarnArmed, setMemoryWarnArmed] = useState<Set<number>>(new Set());

  return (
    <>
      {panel.blockReasons && panel.blockReasons.length > 0 && (
        <div className="ai-block-reasons">
          <p>{T(isOcclusion ? "该图片依赖未建立的理解：" : "该文本依赖未建立的理解：")}</p>
          <ul>{panel.blockReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {!isOcclusion && !panel.searched && (
            <div className="ai-actions">
              <button
                className="btn btn-outline btn-sm"
                disabled={panel.searching || panel.running}
                onClick={onSearchBackground}
              >
                {panel.searching ? T("检索中…") : T("搜索网络补充背景后重试")}
              </button>
            </div>
          )}
          {!isOcclusion && panel.searched && (
            <p className="form-hint">{T("已注入联网检索到的事件背景；若仍提示缺背景，建议手动补充来源文本。")}</p>
          )}
        </div>
      )}
      {panel.drafts?.map((rawDraft, i) => {
        if (panel.accepted?.has(i)) {
          return (
            <div key={i} className="ai-draft card-fill ai-draft-accepted">
              <div className="ai-draft-accepted-badge">{T("已加入 FSRS 队列")}</div>
              <div className="ai-draft-front">
                <div className="ai-draft-text">{String(rawDraft?.front ?? "")}</div>
              </div>
            </div>
          );
        }
        // 深度防御：字段类型强制归一，杜绝渲染期异常
        const d: CardDraft = {
          ...(rawDraft as CardDraft),
          front: String(rawDraft?.front ?? ""),
          back: String(rawDraft?.back ?? ""),
          cloze: rawDraft?.cloze ? String(rawDraft.cloze) : null,
          contextPrefix: rawDraft?.contextPrefix ? String(rawDraft.contextPrefix) : undefined,
          domain: sanitizeDomain((rawDraft as CardDraft)?.domain),
          ruleNotes: toList((rawDraft as CardDraft)?.ruleNotes),
          warnings: toList((rawDraft as CardDraft)?.warnings)
        };
        // v29 D26 逐张分流：面板可混排遮挡卡与看图问答卡——按 draft 自身判断
        // 遮挡 draft = imageOcclusion 且带非空 rects；看图问答 draft = imageOcclusion 且 rects 空（挂图无遮挡）
        const dIsOcc = d.cardType === "imageOcclusion" && !!d.occlusion && d.occlusion.rects.length > 0;
        const issues = lintCard({
          front: d.front,
          back: d.back,
          cardType: d.cardType,
          occlusion: d.occlusion ? { assetPath: d.occlusion.assetPath, rects: d.occlusion.rects } : null,
          cloze: d.cloze || null,
          contextPrefix: d.contextPrefix,
          sourceRef: d.sourceRef,
          dateStamp: d.dateStamp
        });
        const isEditing = editing === i;
        const editText = editValues[i] ?? {};
        const shownFront = editText.front !== undefined ? editText.front : (d.cardType === "cloze" ? d.cloze || d.front : d.front);
        const shownBack = editText.back !== undefined ? editText.back : d.back;
        const occlLabel = d.occlusion?.label ? d.occlusion.label : "";
        return (
          <div key={i} className="ai-draft">
            {isEditing ? (
              <>
                <textarea
                  className="ta-short mono"
                  value={shownFront}
                  onChange={(e) =>
                    setEditValues((v) => ({
                      ...v,
                      [i]: { ...v[i], front: e.target.value }
                    }))
                  }
                />
                <textarea
                  className="ta-short mono"
                  value={shownBack}
                  onChange={(e) =>
                    setEditValues((v) => ({
                      ...v,
                      [i]: { ...v[i], back: e.target.value }
                    }))
                  }
                />
                <div className="ai-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => {
                      // 把编辑写回父组件 state（drafts 数组本体）
                      onEdit(i, {
                        ...(d.cardType === "cloze" ? { cloze: shownFront } : { front: shownFront }),
                        back: shownBack,
                        // 编辑后 front/cloze 变了，同步 noteText 的来源字段
                        front: d.cardType === "cloze" ? d.front : shownFront
                      });
                      setEditValues((v) => {
                        const { [i]: _removed, ...rest } = v;
                        return rest;
                      });
                      setEditing(null);
                    }}
                  >
                    {T("完成")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="ai-draft-front">
                  <span className="ai-draft-type mono">{d.cardType}</span>
                  {/* v30（D27）：分答多空卡徽标——接受时自动拆成每空一张 */}
                  {d.cardType === "cloze" && d.clozeMode === "per-blank" && (
                    <span className="ai-draft-supplement mono">
                      {T("分答·拆{n}张", { n: Math.max(2, parseCloze(d.cloze || d.front || "").ords.length) })}
                    </span>
                  )}
                  {panel.supplemental?.has(i) && <span className="ai-draft-supplement mono">{T("补充")}</span>}
                  {d.contextPrefix && <span className="ai-draft-prefix mono">{d.contextPrefix}</span>}
                  {/* D121 §2.6：R21 归属标签——unknown 用既有 warn 色（lint-warn），其余沿用前缀行同款样式 */}
                  {d.qualifier && (
                    <span
                      className={d.qualifier.stance === "unknown" ? "lint lint-warn mono" : "ai-draft-prefix mono"}
                      title={d.qualifier.note ?? undefined}
                      data-testid="draft-qualifier"
                      data-stance={d.qualifier.stance}
                    >
                      {qualifierLabel(d.qualifier, T)}
                    </span>
                  )}
                  <div className="ai-draft-text">
                    {d.cardType === "cloze"
                      ? (d.cloze || "").replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, "〔$1〕")
                      : d.front}
                  </div>
                </div>
                <div className="ai-draft-back">{d.back}</div>
                {dIsOcc && occlLabel && (
                  <div className="ai-draft-notes mono">{T("区域 {n} · {label}", { n: (d.ord ?? d.occlusion?.ord ?? 0) + 1, label: occlLabel })}</div>
                )}
                {toList(d.ruleNotes).length > 0 && (
                  <div className="ai-draft-notes mono">{toList(d.ruleNotes).join(" · ")}</div>
                )}
                {toList(d.warnings).length > 0 && (
                  <div className="ai-draft-warnings"><IconAlert size={14} /> {toList(d.warnings).join("；")}</div>
                )}
                {/* v46（M14-UM2，§6.7.3）：记忆接地轻标记——成功「情境来自记忆」（点开看引用行），
                    失败「情境来源存疑」（默认不勾选：接受按钮需二次点击确认，不阻断整批） */}
                {d.memoryRef && (
                  <div className="ai-draft-issues">
                    <span
                      className={`lint ${d.memoryRefValid ? "lint-info" : "lint-warn"}`}
                      title={`${T("引用记忆行：")}${d.memoryRef}${d.memoryRefValid ? "" : "\n" + T("（该行未能在本次注入的记忆块中找到——可能记忆已被整理更新）")}`}
                    >
                      {d.memoryRefValid ? T("情境来自记忆") : T("情境来源存疑")}
                    </span>
                  </div>
                )}
                {issues.length > 0 && (
                  <div className="ai-draft-issues">
                    {issues.map((it, j) => (
                      <span key={j} className={`lint lint-${it.severity}`}>
                        {it.ruleId} {it.message}
                      </span>
                    ))}
                  </div>
                )}
                {/* D121 §2.6：归属未定 / 缺 qualifier 且含观点性措辞 → 单行「补限定」，拼到 front（cloze 卡拼到 cloze 文本）开头 */}
                {!dIsOcc && (d.qualifier?.stance === "unknown" || (!d.qualifier && needsAttribution(d.cardType === "cloze" ? d.cloze || d.front : d.front, d.contextPrefix))) && (
                  <div className="ai-actions" data-testid="draft-add-qualifier">
                    <input
                      className="mono"
                      style={{ flex: 1, minWidth: 0 }}
                      placeholder={T("补限定（如：桑德尔认为，）")}
                      value={qualInput[i] ?? ""}
                      onChange={(e) => setQualInput((v) => ({ ...v, [i]: e.target.value }))}
                    />
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={!(qualInput[i] ?? "").trim()}
                      onClick={() => {
                        const text = (qualInput[i] ?? "").trim();
                        if (!text) return;
                        const q: CardQualifier = { stance: "reported", holder: [...text].slice(0, 60).join(""), note: d.qualifier?.note ?? null };
                        onEdit(i, d.cardType === "cloze" ? { cloze: text + (d.cloze || ""), qualifier: q } : { front: text + d.front, qualifier: q });
                        setQualInput((v) => {
                          const { [i]: _r, ...rest } = v;
                          return rest;
                        });
                      }}
                    >
                      {T("补上")}
                    </button>
                  </div>
                )}
                <div className="ai-actions">
                  {dIsOcc ? (
                    <button className="btn btn-primary btn-sm" onClick={() => onAcceptOcclusion(d, i)}>{T("接受")}</button>
                  ) : d.memoryRef && d.memoryRefValid === false && !memoryWarnArmed.has(i) ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      title={T("情境来源存疑：该记忆引用未能校验。再点一次确认接受（可自行决定保留），点「编辑」可删掉情境。")}
                      onClick={() => setMemoryWarnArmed((s) => new Set([...s, i]))}
                    >
                      {T("情境存疑·仍接受？")}
                    </button>
                  ) : (
                    <button className="btn btn-primary btn-sm" onClick={() => onAccept(d, i)}>{T("接受")}</button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditing(i)}>{T("编辑")}</button>
                  {d.cardType === "qa" && (
                    <button
                      className="btn btn-secondary btn-sm"
                      title={T("拆为两张互为翻转的独立问答卡（各自有独立 FSRS 调度状态）")}
                      onClick={() => onSplitReverse(i)}
                    >
                      {T("转翻转卡")}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}
      {(panel.kind === "cards" || isOcclusion) && !panel.running && panel.drafts && panel.drafts.length > 0 && (
        <div className="ai-actions">
          <button className="btn btn-outline btn-sm" onClick={onRejectAll}>{T("整批拒绝")}</button>
        </div>
      )}
    </>
  );
}
