"use strict";
/**
 * v49.170 / D340：移植自 src/lib/kgSense.ts，两边必须同步修改；tests/kg-sense-core.test.cjs 对拍。
 * 纯函数、零 IO：主进程里的 D318 义项本地裁决（senseVerdict）与其辅助（normName / quoteInSource / termMatchOf / formatCandidateLine）。
 */

const SENSE_RELS = ["same", "narrower", "split", "related"];
const MATCH_TYPES = ["label", "syn", "trans", "narrow", "broad", "rel", "split", "noise", "alias"];
/** 判为「等同」时可以静默接受的命中方式 */
const SAFE_SAME = ["label", "syn", "trans"];

function normRel(v) {
  return SENSE_RELS.includes(v) ? v : null;
}
function normMatchType(v) {
  return MATCH_TYPES.includes(v) ? v : null;
}

/** 与 electron/atlas.js norm() 同口径（NFKC + 小写 + 去空白与常见标点） */
const NAME_NORM_RE = /[\s　·・\-_'"()（）[\]【】《》〈〉,，.。:：;；!！?？/]+/g;
function normName(s) {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(NAME_NORM_RE, "");
}

/** 引句核验：去空白与引号后，引句（≥4 字符）必须是材料的子串 */
const QUOTE_NORM_RE = /[\s　"'“”‘’「」『』]+/g;
function quoteInSource(quote, source) {
  const q = String(quote ?? "").normalize("NFKC").replace(QUOTE_NORM_RE, "");
  if ([...q].length < 4) return false;
  const s = String(source ?? "").normalize("NFKC").replace(QUOTE_NORM_RE, "");
  return s.includes(q);
}

/**
 * 本地裁决（设计 §3.3）。
 * @param {{rel: string|null, unsure: boolean, quoteOk: boolean, hasCandidate: boolean, viaFallback?: boolean, termIsLabel: boolean, termMatchType: string|null}} x
 * @returns {{mode: "auto"|"discern", rel: string|null, aiRel: string|null, reasons: string[]}}
 */
function senseVerdict(x) {
  if (!x.hasCandidate) return { mode: "auto", rel: null, aiRel: null, reasons: [] };
  const reasons = [];
  let rel = x.rel;
  if (x.viaFallback && rel == null) {
    if (x.termIsLabel || (x.termMatchType && SAFE_SAME.includes(x.termMatchType))) rel = "same";
    else reasons.push("fallback-alias");
  }
  if (x.unsure) reasons.push("unsure");
  if (rel === "split") reasons.push("split");
  if (rel === "same" && !x.termIsLabel && x.termMatchType != null && !SAFE_SAME.includes(x.termMatchType)) reasons.push("alias-type");
  if ((rel === "same" || rel === "narrower" || rel === "split") && !x.quoteOk && !(x.viaFallback && x.rel == null)) reasons.push("no-quote");
  if (!reasons.length) return { mode: "auto", rel, aiRel: x.rel, reasons };
  const fallbackRel = rel === "narrower" || rel === "split" || rel === "related" ? rel : "narrower";
  return { mode: "discern", rel: fallbackRel, aiRel: x.rel, reasons };
}

function candidateLabels(c) {
  return [c.zh, c.zht, c.en, c.ja].filter((x) => typeof x === "string" && !!x.trim());
}

/** 材料术语相对候选的命中方式：是标签 → label；等于本次命中的名称 → 该命中方式；否则 null */
function termMatchOf(term, c) {
  const k = normName(term);
  if (!k) return { termIsLabel: false, termMatchType: null };
  if (candidateLabels(c).some((l) => normName(l) === k)) return { termIsLabel: true, termMatchType: "label" };
  const hit = (c.matches || []).find((m) => m && normName(m.norm) === k);
  if (hit) return { termIsLabel: hit.type === "label", termMatchType: normMatchType(hit.type) ?? "alias" };
  if (c.matched && normName(c.matched) === k) return { termIsLabel: false, termMatchType: normMatchType(c.matchedType) ?? "alias" };
  return { termIsLabel: false, termMatchType: null };
}

const MATCH_TEXT = {
  label: "名称",
  syn: "又名·同义",
  trans: "又名·译名或写法",
  narrow: "又名·更窄的概念",
  broad: "又名·更宽的概念",
  rel: "又名·相关概念",
  split: "又名·译名分化",
  noise: "又名·存疑",
  alias: "又名（未分类，含义可能不同）"
};

/** 【全谱候选知识点】一行：编号｜名称｜类别，说明｜定义｜命中方式（R22 v11） */
function formatCandidateLine(c) {
  const name = c.zh || c.en || c.ja || c.id;
  const parts = [c.id, name, [c.kindLabel, c.gloss || c.glossEn].filter(Boolean).join("，")];
  const def = c.def || c.defEn;
  parts.push(def ? `定义：${def}` : "");
  const ms = (c.matches && c.matches.length ? c.matches : c.matched ? [{ norm: c.matched, type: c.matchedType ?? null, gloss: c.matchedGloss ?? null }] : [])
    .map((m) => ({ ...m, type: normMatchType(m.type) ?? (candidateLabels(c).some((l) => normName(l) === normName(m.norm)) ? "label" : "alias") }))
    .filter((m) => m.type !== "label");
  parts.push(ms.map((m) => `材料里的「${m.norm}」是它的${MATCH_TEXT[m.type]}${m.type === "split" && m.gloss ? `（该义项：${m.gloss}）` : ""}`).join("；"));
  while (parts.length && !parts[parts.length - 1]) parts.pop();
  return parts.join("｜");
}

module.exports = {
  SENSE_RELS,
  SAFE_SAME,
  normRel,
  normMatchType,
  normName,
  quoteInSource,
  senseVerdict,
  candidateLabels,
  termMatchOf,
  formatCandidateLine
};
