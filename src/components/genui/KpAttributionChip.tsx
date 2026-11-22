// v49.138 / D305（知识图谱设计稿 §4.2 第 3 步）：AI 草稿上的知识点归属标签「名称 · 已有 / 全谱 / 私有」+ 侧面。
// 点名称可改挂：v49.143 / D311 起边输入边列出全谱节点（选中＝按全谱身份挂靠）；直接回车＝私有节点（全谱里没有）。
// ✕ 取消归属（卡仍可接受，不进图谱）；接受卡片即确认归属。
// v49.149 / D318 知识点＝义项：本地裁决为「需辨析」时，标签下方内联辨析卡（材料术语 vs 全谱条目 + AI 给的区别 + 四选一），
// 不是待办队列——随草稿接受或丢弃；不点选时按默认值（偏向不合并）接受。点选写 kg:senseJudged 回流。
import "./genui.css";
import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/ime";
import type { CardDraft, KgFacet, KpAttribution } from "../../lib/cards";
import type { SenseRel } from "../../lib/kgSense";

/** 辨析卡四选一（+ 不相干） */
const SENSE_CHOICES: { v: SenseRel | "none"; label: string }[] = [
  { v: "same", label: "同一个" },
  { v: "narrower", label: "它下面的一个概念" },
  { v: "split", label: "同一外语词的另一义" },
  { v: "none", label: "不相干" }
];
const REL_LABEL: Record<SenseRel, string> = { same: "同一个", narrower: "它下面的一个概念", split: "同一外语词的另一义", related: "相关" };
const LINT_TEXT: Record<string, string> = {
  sentence: "这像一句话，不像一个知识点——可以改名，或只把它当卡片内容",
  "too-long": "名称偏长——知识点通常是一个术语",
  "no-definition": "还没有定义：接受后可在图谱里补"
};

const FACETS: { v: KgFacet; label: string }[] = [
  { v: "definition", label: "是什么" },
  { v: "why", label: "为什么" },
  { v: "example", label: "举例 / 应用" },
  { v: "contrast", label: "区分" },
  { v: "relation", label: "关系" }
];

export default function KpAttributionChip({ draft, onChange }: { draft: CardDraft; onChange: (patch: Partial<CardDraft>) => void }) {
  const T = useT();
  const a = draft.kpAttribution;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(a?.label ?? "");
  const [hits, setHits] = useState<AtlasHit[]>([]);
  useEffect(() => {
    if (!editing) return;
    const q = val.trim();
    if (!q) {
      setHits([]);
      return;
    }
    let alive = true;
    const h = window.setTimeout(() => {
      void atlasApi()?.atlasSearch(q, { limit: 6 }).then((r) => alive && setHits(r || [])).catch(() => undefined);
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [val, editing]);
  if (!a) return null;
  const pickAtlas = async (h: AtlasHit) => {
    setEditing(false);
    setHits([]);
    const label = h.zh || h.en || h.ja || h.id;
    let next: KpAttribution = { ...a, label, atlasId: h.id, atlasGloss: h.gloss ?? h.glossEn ?? null, atlasRel: "same", kpId: null, kpLabel: null, suggest: null, sense: null };
    try {
      const r = (await kgResolve()?.resolveAttribution([{ key: a.key, label, atlasId: h.id }]))?.[0];
      if (r) next = { ...next, kpId: r.kpId, kpLabel: r.kpLabel };
    } catch {
      /* 裁决失败：按「全谱新点亮」处理 */
    }
    onChange({ kpAttribution: next });
  };
  /** v49.149 / D318：辨析卡点选——同一个＝按全谱身份挂靠（名称对齐全谱）；其余保留材料术语并记对照类型 */
  const chooseSense = async (rel: SenseRel | "none") => {
    const sn = a.sense;
    if (!sn) return;
    const term = a.term || a.label;
    const same = rel === "same";
    const label = same ? sn.candidate.label : term;
    let next: KpAttribution = {
      ...a,
      label,
      kpId: null,
      kpLabel: null,
      suggest: null,
      atlasId: rel === "none" ? null : sn.candidate.id,
      atlasGloss: rel === "none" ? null : sn.candidate.gloss,
      atlasRel: rel === "none" ? null : rel,
      sense: { ...sn, chosen: rel }
    };
    try {
      const r = (await kgResolve()?.resolveAttribution([{ key: a.key, label, atlasId: rel === "none" ? null : sn.candidate.id, atlasRel: rel === "none" ? null : rel }]))?.[0];
      if (r) next = { ...next, kpId: r.kpId, kpLabel: r.kpLabel };
    } catch {
      /* 裁决失败：按「新」处理 */
    }
    onChange({ kpAttribution: next });
    void senseApi()?.senseJudged({ term, atlasId: sn.candidate.id, atlasLabel: sn.candidate.label, aiRel: sn.aiRel, userRel: rel }).catch(() => undefined);
  };
  const commit = async () => {
    const label = val.trim();
    setEditing(false);
    if (!label || label === a.label) return;
    let next: KpAttribution = { ...a, label, kpId: null, kpLabel: null, atlasId: null, atlasGloss: null, atlasRel: null, sense: null };
    try {
      const r = (await kgResolve()?.resolveAttribution([{ key: a.key, label }]))?.[0];
      if (r) next = { ...next, kpId: r.kpId, kpLabel: r.kpLabel };
    } catch {
      /* 裁决失败：按「新」处理 */
    }
    onChange({ kpAttribution: next });
  };
  const rel: SenseRel | null = a.atlasId ? a.atlasRel ?? "same" : null;
  const state = a.kpId ? "existing" : rel === "same" ? "atlas" : rel === "split" ? "split" : "new";
  const sn = a.sense;
  const discernOpen = !!sn && !sn.chosen;
  return (
    <span className="ai-kp-chip" data-testid="draft-kp" data-kp-state={state}>
      {editing ? (
        <span className="ai-kp-chip-edit">
          <input
            className="ai-kp-input"
            value={val}
            autoFocus
            aria-label={T("知识点名称")}
            placeholder={T("搜索全谱，或直接写名称")}
            onChange={(e) => setVal(e.target.value)}
            onBlur={() => window.setTimeout(() => void commit(), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isImeComposing(e)) void commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          {hits.length > 0 && (
            <span className="ai-kp-hits" role="listbox" aria-label={T("全谱")}>
              {hits.map((h) => (
                <button key={h.id} type="button" role="option" className="ai-kp-hit" onMouseDown={(e) => e.preventDefault()} onClick={() => void pickAtlas(h)}>
                  <b>{h.zh || h.en || h.ja}</b>
                  {(h.gloss || h.glossEn) && <small>{h.gloss || h.glossEn}</small>}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <button type="button" className="ai-kp-name" title={a.atlasGloss ?? a.definition ?? T("改挂到别的知识点")} onClick={() => { setVal(a.kpLabel ?? a.label); setEditing(true); }}>
          {a.kpLabel ?? a.label}
        </button>
      )}
      <span
        className="ai-kp-state"
        title={
          rel === "narrower" || rel === "split" || rel === "related"
            ? T("与全谱条目的关系：{rel}", { rel: T(REL_LABEL[rel]) }) + (a.atlasGloss ? ` · ${a.atlasGloss}` : "")
            : state === "new"
              ? T("全谱里没有含义相同的节点：接受后作为私有知识点")
              : undefined
        }
      >
        {state === "existing" ? T("已有") : state === "atlas" ? T("全谱") : state === "split" ? T("译名分化") : T("私有")}
      </span>
      {sn && sn.chosen && (
        <button type="button" className="ai-kp-suggest" data-testid="draft-kp-rediscern" onClick={() => onChange({ kpAttribution: { ...a, sense: { ...sn, chosen: null } } })}>
          {T("重新辨析")}
        </button>
      )}
      {!a.kpId && a.suggest && (
        <button
          type="button"
          className="ai-kp-suggest"
          title={T("语义上最相近的已有知识点；点一下改挂到它")}
          onClick={() => onChange({ kpAttribution: { ...a, kpId: a.suggest!.kpId, kpLabel: a.suggest!.label, suggest: null } })}
        >
          {T("可能是：{x}？", { x: a.suggest.label })}
        </button>
      )}
      <select
        className="ai-kp-facet"
        value={draft.facet ?? ""}
        aria-label={T("这张卡考的是")}
        onChange={(e) => onChange({ facet: (e.target.value || null) as KgFacet | null })}
      >
        <option value="">{T("不标注")}</option>
        {FACETS.map((f) => (
          <option key={f.v} value={f.v}>{T(f.label)}</option>
        ))}
      </select>
      <button type="button" className="ai-kp-clear" aria-label={T("取消归属")} title={T("取消归属")} onClick={() => onChange({ kpAttribution: null })}>
        ✕
      </button>
      {a.lint && a.lint.length > 0 && !editing && (
        <span className="ai-kp-lint" data-testid="draft-kp-lint">
          {a.lint.map((c) => T(LINT_TEXT[c] || c)).join("；")}
        </span>
      )}
      {discernOpen && sn && (
        <span className="ai-kp-discern" data-testid="draft-kp-discern" role="group" aria-label={T("辨析：它和全谱条目是同一个吗？")}>
          <span className="ai-kp-discern-cols">
            <span className="ai-kp-discern-col">
              <b>{T("材料中的「{x}」", { x: a.term || a.label })}</b>
              <small>{a.definition || T("（没有定义）")}</small>
            </span>
            <span className="ai-kp-discern-col">
              <b>{T("全谱「{x}」", { x: sn.candidate.label })}</b>
              <small>{sn.candidate.def || sn.candidate.gloss || T("（没有说明）")}</small>
              {sn.candidate.matchedGloss && <small>{T("这个译名在全谱里指：{x}", { x: sn.candidate.matchedGloss })}</small>}
            </span>
          </span>
          {sn.contrast && <span className="ai-kp-discern-ai">{T("AI：{x}", { x: sn.contrast })}</span>}
          <span className="ai-kp-discern-ai">
            {sn.aiRel ? T("AI 判断：{rel}", { rel: T(REL_LABEL[sn.aiRel]) }) : T("AI 没有判断它们的关系")}
            {sn.reasons.includes("unsure") ? T("（AI 拿不准）") : ""}
            {" · "}
            {T("不选就按「{rel}」接受", { rel: T(REL_LABEL[rel ?? "narrower"]) })}
          </span>
          <span className="ai-kp-discern-acts">
            <span>{T("它和全谱条目是：")}</span>
            {SENSE_CHOICES.map((c) => (
              <button key={c.v} type="button" className="ai-kp-discern-btn" data-sense={c.v} onClick={() => void chooseSense(c.v)}>
                {T(c.label)}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}

interface AtlasHit {
  id: string;
  zh: string | null;
  en: string | null;
  ja: string | null;
  gloss: string | null;
  glossEn?: string | null;
}
function atlasApi() {
  return (window as unknown as { kgAPI?: { atlasSearch(q: string, o?: { limit?: number }): Promise<AtlasHit[]> } }).kgAPI ?? null;
}
function senseApi() {
  return (window as unknown as { kgAPI?: { senseJudged(p: { term: string; atlasId: string; atlasLabel: string; aiRel: SenseRel | null; userRel: SenseRel | "none" }): Promise<unknown> } }).kgAPI ?? null;
}
function kgResolve() {
  return (window as unknown as { kgAPI?: { resolveAttribution(i: { key: string; label: string; atlasId?: string | null; atlasRel?: SenseRel | null }[]): Promise<{ kpId: string | null; kpLabel: string | null }[]> } }).kgAPI ?? null;
}
