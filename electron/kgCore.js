"use strict";
// D304（v49.137）知识图谱纯函数核心（设计稿 docs/design/KNOWLEDGE-GRAPH-DESIGN.md §4.3 / §4.4 / §5 / §8）。
// 零 IO、零时钟：所有时刻由调用方传入；同一输入两次输出逐字节相同（G2 验收）。
// 掌握判定只在 lmLevels.computeKpLevel 一处（设计稿 §1-4「同一份事实只有一套解释」），本文件只组装证据。
const lmParams = require("./lmParams");
const lmLevels = require("./lmLevels");
const { learningDayIndex, learningDayStartMs } = require("./fsrsTime");

const DAY = 86400000;
const FACETS = Object.freeze(["definition", "why", "example", "contrast", "relation"]);
const FACET_SET = new Set(FACETS);
const KINDS = Object.freeze(["concept", "principle", "method", "fact"]);
const RELATION_GROUP = Object.freeze({
  prerequisite: "prerequisite",
  part_of: "hierarchy",
  generalization_of: "hierarchy",
  specialization_of: "hierarchy",
  contrasts_with: "contrast",
  example_of: "support",
  application_of: "support",
  related_to: "support",
  analogous_to: "analogy"
});
// 无关系卡时边的固定低强度（设计稿 §8.2 GraphEdge.strength）
const EDGE_BASE_STRENGTH = 0.3;

function normFacet(f) {
  const v = String(f || "").trim();
  return FACET_SET.has(v) ? v : null;
}

/** 评分 → 1..4（again/hard/good/easy；未知 0） */
function gradeOf(rating) {
  const r = String(rating || "").toLowerCase();
  if (r === "again" || r === "1") return 1;
  if (r === "hard" || r === "2") return 2;
  if (r === "good" || r === "3") return 3;
  if (r === "easy" || r === "4") return 4;
  return 0;
}

/**
 * §4.3 延迟回忆闸门：首次复习之后至少隔一个学习日，得到一次「良好 / 简单」（Q1：困难不算）。
 * reviews：[{t, grade}] 按 t 升序。返回点亮时刻或 null。
 */
function cardLitAt(reviews, cutoffHour) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null;
  const d0 = learningDayIndex(reviews[0].t, cutoffHour || 0);
  for (const r of reviews) {
    if (r.grade >= 3 && learningDayIndex(r.t, cutoffHour || 0) >= d0 + 1) return r.t;
  }
  return null;
}

/** 某卡在时刻 t 的 {reviewed, R, S, lastReview}；series：[{t, S}] 升序（每次复习后的稳定性） */
function cardStateAt(card, t) {
  const s = card.series || [];
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return { reviewed: false, R: 0, S: 0, lastReview: null };
  const e = s[lo - 1];
  const R = lmLevels.retrievability((t - e.t) / DAY, e.S, card.decay);
  return { reviewed: true, R, S: e.S, lastReview: e.t };
}

/** 组装 computeKpLevel 在时刻 t 的输入（与 learnerRefresh.stepKp 的卡片证据同口径） */
function kpLevelAt(node, t) {
  const P = lmParams.KP;
  const cards = node.cards.map((c) => {
    const st = cardStateAt(c, t);
    let lapses30 = 0;
    let lastRating = 0;
    let reviewCount = 0;
    const reviewDays = new Set();
    for (const r of c.reviews) {
      if (r.t > t) break;
      reviewCount += 1;
      if (r.grade === 1 && t - r.t <= P.LAPSE_WINDOW_DAYS * DAY) lapses30 += 1;
      const d = new Date(r.t);
      reviewDays.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
      lastRating = r.grade;
    }
    return { cardType: c.cardType, reviewed: st.reviewed, R: st.R, S: st.S, lapses30, lastRating, reviewDays, reviewCount };
  });
  const selfExplainClear90 = node.selfExplain.filter((e) => e.clear && e.t <= t && t - e.t <= P.SELF_EXPLAIN_WINDOW_DAYS * DAY).length;
  const facetInfo = facetCountsAt(node, t);
  return lmLevels.computeKpLevel({
    cards,
    extractCount: node.extractCount,
    passedUnitCount: 0,
    selfExplainClear90,
    passedFacetCount: facetInfo.passed,
    facetAnnotated: facetInfo.annotated
  });
}

function facetCountsAt(node, t) {
  let passed = 0;
  for (const f of FACETS) if (node.facetPassedAt[f] != null && node.facetPassedAt[f] <= t) passed += 1;
  return { passed, annotated: node.cards.some((c) => c.facet && c.series.length && c.series[0].t <= t) };
}

/**
 * 由事实组装图谱模型（一次构建，供 snapshotAt / timeline / keyframes 多次查询）。
 * input = { now, cutoffHour, kps, cards, relations, defVersions, selfExplain, extractCounts, kpStates, kgEvents }
 *  - kps：[{id, label, description, status, aliases, kind, domainId, createdAt, mergeLog?}]（只给根 KP 与已归档 KP）
 *  - cards：[{id, kpId, facet, cardType, reviews:[{t,grade}], series:[{t,S}], decay, due}]
 *  - kpStates：Map kpId → {level, fading, confidence, metrics}（LM-1 当前态，唯一真源）
 */
function buildModel(input) {
  const now = Number(input.now);
  const cutoffHour = Number(input.cutoffHour) || 0;
  const nodes = new Map();
  for (const kp of input.kps || []) {
    nodes.set(String(kp.id), {
      id: String(kp.id),
      label: String(kp.label || ""),
      definition: String(kp.description || ""),
      defVersion: 0,
      defVersionTimes: [],
      kind: KINDS.includes(kp.kind) ? kp.kind : "concept",
      status: String(kp.status || "active"),
      aliases: Array.isArray(kp.aliases) ? kp.aliases.map(String) : [],
      domainId: kp.domainId ? String(kp.domainId) : null,
      atlasId: kp.atlasId ? String(kp.atlasId) : null,
      atlasParent: kp.atlasParent ? String(kp.atlasParent) : null,
      atlasAlso: Array.isArray(kp.atlasAlso) ? kp.atlasAlso.map(String) : [],
      atlasSplit: Array.isArray(kp.atlasSplit) ? kp.atlasSplit.map(String) : [],
      atlasTopic: kp.atlasTopic ? String(kp.atlasTopic) : null,
      createdAt: Number(kp.createdAt) || 0,
      archivedAt: null,
      cards: [],
      selfExplain: [],
      extractCount: Number((input.extractCounts && input.extractCounts.get(String(kp.id))) || 0),
      // v49.170 / D340 / I6 证据阶梯第 1 级：读过讲了它的单元（由 kgService 按 unit_reads × source_terms 算好传入）
      readExplained: kp.readExplained === true,
      litAt: null,
      firstReviewAt: null,
      facetPassedAt: {},
      levelHistory: [],
      anchorId: null
    });
  }
  for (const c of input.cards || []) {
    const n = nodes.get(String(c.kpId));
    if (!n) continue;
    const reviews = (c.reviews || []).slice().sort((a, b) => a.t - b.t);
    const series = (c.series || []).slice().sort((a, b) => a.t - b.t);
    n.cards.push({
      id: String(c.id),
      facet: normFacet(c.facet),
      cardType: String(c.cardType || "qa"),
      reviews,
      series,
      decay: Number(c.decay) || lmParams.FSRS_DEFAULT_DECAY,
      due: c.due == null ? null : Number(c.due)
    });
  }
  for (const e of input.selfExplain || []) {
    const n = nodes.get(String(e.kpId));
    if (n) n.selfExplain.push({ t: Number(e.t), clear: Boolean(e.clear) });
  }
  for (const v of (input.defVersions || []).slice().sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)) {
    const n = nodes.get(String(v.kpId));
    if (!n) continue;
    n.defVersion = Math.max(n.defVersion, Number(v.seq) || 0);
    n.defVersionTimes.push({ t: Number(v.createdAt), version: Number(v.seq) });
  }
  const kgEvents = (input.kgEvents || []).slice().sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  for (const e of kgEvents) {
    const n = nodes.get(String(e.kpId));
    if (!n) continue;
    if (e.kind === "archived") n.archivedAt = Number(e.ts);
    if (e.kind === "restored") n.archivedAt = null;
  }
  for (const n of nodes.values()) {
    if (n.status === "deprecated" && n.archivedAt == null) n.archivedAt = n.createdAt; // 无事件的存量归档：视为一直归档
    if (n.status !== "deprecated") n.archivedAt = null;
    n.cards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    n.selfExplain.sort((a, b) => a.t - b.t);
    // 点亮与侧面（§4.3 / §5.3）
    for (const c of n.cards) {
      if (c.reviews.length && (n.firstReviewAt == null || c.reviews[0].t < n.firstReviewAt)) n.firstReviewAt = c.reviews[0].t;
      const lit = cardLitAt(c.reviews, cutoffHour);
      c.litAt = lit;
      if (lit != null) {
        if (n.litAt == null || lit < n.litAt) n.litAt = lit;
        if (c.facet && (n.facetPassedAt[c.facet] == null || lit < n.facetPassedAt[c.facet])) n.facetPassedAt[c.facet] = lit;
      }
    }
    const firstClear = n.selfExplain.find((e) => e.clear);
    if (firstClear && (n.facetPassedAt.why == null || firstClear.t < n.facetPassedAt.why)) n.facetPassedAt.why = firstClear.t;
    // 等级史：只在复习时刻（与自评时刻）重评（等级只在新证据到来时跳变；衰减引起的变化由关键帧的褪色表达）
    const times = new Set();
    for (const c of n.cards) for (const r of c.reviews) if (r.t <= now) times.add(r.t);
    for (const e of n.selfExplain) if (e.t <= now) times.add(e.t);
    let prev = -1;
    for (const t of [...times].sort((a, b) => a - b)) {
      const lv = kpLevelAt(n, t).level;
      if (lv !== prev) {
        n.levelHistory.push({ t, level: lv });
        prev = lv;
      }
    }
  }
  // 边
  const edges = [];
  for (const r of input.relations || []) {
    const from = String(r.fromId);
    const to = String(r.toId);
    if (!nodes.has(from) || !nodes.has(to) || from === to) continue;
    // v49.148 / D317：只有材料层 / AI 证据的推断线，两端都点亮才画
    if (r.requireLit && (nodes.get(from).litAt == null || nodes.get(to).litAt == null)) continue;
    edges.push({
      id: String(r.id),
      from,
      to,
      type: String(r.type),
      group: RELATION_GROUP[r.type] || "support",
      status: r.suggested ? "suggested" : "confirmed",
      createdAt: Number(r.createdAt) || 0,
      // v49.148 / D317：world＝有全谱证据（结构用途：锚点 / 主题仍可沿用）；layers＝三层证据计数
      world: Boolean(r.world),
      // v49.153 / D322 / T3：只靠情境边出的世界层边不参与锚点分层（行为与 T2 之前一致）
      ctx: Boolean(r.ctx),
      requireLit: Boolean(r.requireLit),
      layers: r.layers || null,
      unexplained: Boolean(r.unexplained),
      resurfaced: r.resurfaced || null
    });
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 锚点（§8.2）：点亮时已点亮的邻居中，优先前置关系的源 → 层级上位 → 任一已确认邻居
  for (const n of nodes.values()) {
    if (n.litAt == null) continue;
    const before = (id) => {
      const m = nodes.get(id);
      return m && m.litAt != null && (m.litAt < n.litAt || (m.litAt === n.litAt && m.id < n.id));
    };
    const tiers = [[], [], []];
    for (const e of edges) {
      // 已确认边始终参与；世界层边只算骨架（只靠情境边的推断线不作锚点，与 T2 之前一致）
      if (e.status !== "confirmed" && !(e.world && !e.ctx)) continue;
      let other = null;
      let tier = 2;
      if (e.to === n.id) other = e.from;
      else if (e.from === n.id) other = e.to;
      else continue;
      if (e.type === "prerequisite" && e.to === n.id) tier = 0;
      else if ((e.type === "part_of" || e.type === "specialization_of") && e.from === n.id) tier = 1;
      else if (e.type === "generalization_of" && e.to === n.id) tier = 1;
      if (before(other)) tiers[tier].push(other);
    }
    for (const tier of tiers) {
      if (!tier.length) continue;
      tier.sort((a, b) => nodes.get(a).litAt - nodes.get(b).litAt || (a < b ? -1 : 1));
      n.anchorId = tier[0];
      break;
    }
  }
  // 主题（§3）：part_of 链的顶端（有下位者时）；否则领域
  const parentOf = new Map();
  for (const e of edges) if (e.type === "part_of" && (e.status === "confirmed" || e.world) && !parentOf.has(e.from)) parentOf.set(e.from, e.to);
  const hasChild = new Set(parentOf.values());
  for (const n of nodes.values()) {
    let cur = n.id;
    const seen = new Set([cur]);
    while (parentOf.has(cur) && !seen.has(parentOf.get(cur))) {
      cur = parentOf.get(cur);
      seen.add(cur);
    }
    // v49.143 / D311：挂了全谱的节点以全谱主题为主题（有名字、跨用户一致）
    n.themeId = n.atlasTopic ? `atlas:${n.atlasTopic}` : cur !== n.id || hasChild.has(n.id) ? `kp:${cur}` : n.domainId ? `domain:${n.domainId}` : null;
  }
  return {
    now,
    cutoffHour,
    nodes,
    edges,
    kpStates: input.kpStates || new Map(),
    kgEvents: kgEvents.map((e) => ({ id: String(e.id), kind: String(e.kind), ts: Number(e.ts), kpId: e.kpId ? String(e.kpId) : null, payload: e.payload || {} })),
    themeLabels: input.themeLabels || new Map()
  };
}

const LEVEL_STATE = { 2: "lit", 3: "solid", 4: "firm" };

function levelAt(n, t) {
  let lv = 0;
  for (const h of n.levelHistory) {
    if (h.t > t) break;
    lv = h.level;
  }
  if (lv === 0 && (n.cards.length || n.extractCount) && n.createdAt <= t) lv = 1;
  return lv;
}

/** 保持度与褪色在时刻 t（与 computeKpLevel 的 meanR / fading 同式） */
function retentionAt(n, t) {
  let sum = 0;
  let k = 0;
  let stable = 0;
  let sSum = 0;
  for (const c of n.cards) {
    const st = cardStateAt(c, t);
    if (!st.reviewed) continue;
    k += 1;
    sum += st.R;
    sSum += st.S;
    if (st.S >= lmParams.KP.STABLE_S) stable += 1;
  }
  const meanR = k ? sum / k : 0;
  const fading = k >= 1 && stable / k >= lmParams.KP.STABLE_RATIO && meanR < lmParams.KP.R_FADING;
  return { n: k, meanR, fading, meanS: k ? sSum / k : 0 };
}

function stateOf(n, t, lv, fading) {
  if (n.archivedAt != null && n.archivedAt <= t) return "archived";
  if (lv <= 1) return "ghost";
  if (n.litAt == null || n.litAt > t) return "outline";
  if (fading) return "fading";
  return LEVEL_STATE[Math.min(4, lv)] || "lit";
}

function dailyCostOf(n, t) {
  let cost = 0;
  for (const c of n.cards) {
    const st = cardStateAt(c, t);
    if (st.reviewed) cost += 1 / Math.max(1, st.S);
  }
  return cost;
}

const r3 = lmLevels.round3;

/**
 * graphAt(t)：任意时刻的图谱快照（设计稿 §8.2）。t === model.now 时等级 / 褪色 / 置信度取 LM-1 当前态（唯一真源）。
 */
function snapshotAt(model, t) {
  const at = Math.min(Number(t), model.now);
  const isNow = at === model.now;
  const nodes = [];
  let lit = 0;
  let fadingCount = 0;
  let outline = 0;
  let dailyCost = 0;
  for (const n of [...model.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (n.createdAt > at) continue;
    const ret = retentionAt(n, at);
    const cur = isNow ? model.kpStates.get(n.id) : null;
    const lv = cur ? Number(cur.level) : levelAt(n, at);
    const fading = cur ? Boolean(cur.fading) : ret.fading;
    const retention = cur && cur.metrics && cur.metrics.meanR != null ? Number(cur.metrics.meanR) : ret.meanR;
    const state = stateOf(n, at, lv, fading);
    const facets = {};
    let depth = 0;
    for (const f of FACETS) {
      if (n.facetPassedAt[f] != null && n.facetPassedAt[f] <= at) {
        facets[f] = "passed";
        depth += 1;
      } else facets[f] = n.cards.some((c) => c.facet === f && (c.reviews[0] ? c.reviews[0].t <= at : isNow)) ? "pending" : "none";
    }
    const cost = state === "archived" ? 0 : dailyCostOf(n, at);
    const isLit = n.litAt != null && n.litAt <= at;
    if (state !== "archived") {
      if (isLit && retention >= lmParams.KP.R_FADING) lit += 1;
      if (state === "fading") fadingCount += 1;
      if (state === "outline") outline += 1;
      dailyCost += cost;
    }
    const conf = cur ? String(cur.confidence) : ret.n >= 3 ? "high" : ret.n >= 1 ? "medium" : "low";
    const defVersion = n.defVersionTimes.filter((v) => v.t <= at).reduce((m, v) => Math.max(m, v.version), 0);
    nodes.push({
      id: n.id,
      label: n.label,
      definition: n.definition,
      defVersion: isNow ? n.defVersion : defVersion,
      kind: n.kind,
      state,
      retention: r3(retention),
      stability: r3(ret.meanS),
      depth,
      facets,
      confidence: conf,
      due: isNow ? n.cards.some((c) => c.due != null && c.due <= at) : false,
      dailyCost: r3(cost),
      litAt: isLit ? n.litAt : null,
      anchorId: isLit ? n.anchorId : null,
      themeId: n.themeId,
      atlasId: n.atlasId,
      atlasParent: n.atlasParent,
      atlasAlso: n.atlasAlso,
      atlasSplit: n.atlasSplit,
      cardCount: n.cards.length,
      extractCount: n.extractCount,
      readExplained: n.readExplained === true
    });
  }
  const present = new Set(nodes.map((x) => x.id));
  const retById = new Map(nodes.map((x) => [x.id, x]));
  const edges = [];
  for (const e of model.edges) {
    if (!present.has(e.from) || !present.has(e.to) || e.createdAt > at) continue;
    const relCards = model.nodes.get(e.from).cards.filter((c) => c.facet === "relation");
    let strength = EDGE_BASE_STRENGTH;
    if (relCards.length) {
      const rs = relCards.map((c) => cardStateAt(c, at)).filter((s) => s.reviewed);
      if (rs.length) strength = rs.reduce((s, x) => s + x.R, 0) / rs.length;
    }
    if (!retById.get(e.from) || !retById.get(e.to)) continue;
    if (e.requireLit && (retById.get(e.from).litAt == null || retById.get(e.to).litAt == null)) continue;
    const out = { id: e.id, from: e.from, to: e.to, type: e.type, group: e.group, status: e.status, strength: r3(strength) };
    if (e.layers) out.layers = e.layers;
    if (e.unexplained) out.unexplained = true;
    if (e.resurfaced) out.resurfaced = e.resurfaced;
    edges.push(out);
  }
  const themeMap = new Map();
  for (const x of nodes) {
    if (!x.themeId) continue;
    if (!themeMap.has(x.themeId)) themeMap.set(x.themeId, []);
    themeMap.get(x.themeId).push(x.id);
  }
  const themes = [...themeMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, nodeIds]) => {
      const root = id.startsWith("kp:") ? model.nodes.get(id.slice(3)) : null;
      const label = root ? root.label : model.themeLabels.get(id) || id.replace(/^domain:/, "");
      return { id, label, nodeIds, domain: root ? root.domainId || "" : id.replace(/^domain:/, "") };
    });
  return {
    at,
    lmVersion: `${lmParams.LM_VERSION}.${lmParams.PARAM_VERSION}`,
    summary: { lit, fading: fadingCount, outline, dailyCost: r3(dailyCost) },
    nodes,
    edges,
    themes
  };
}

/** 学习日序列 [from, to] 的每日终点时刻（含当日 now） */
function dayEnds(model, from, to) {
  const out = [];
  let start = learningDayStartMs(from, model.cutoffHour);
  const end = Math.min(to, model.now);
  let guard = 0;
  while (start <= end && guard++ < 40000) {
    const next = learningDayStartMs(start + DAY + 3 * 3600000, model.cutoffHour);
    out.push(Math.min(next - 1, model.now));
    start = next;
  }
  return out;
}

/**
 * timeline(from, to)：按时间排序的事件流（设计稿 §8.3）。全部来自落库事实或 review_logs 重放，无装饰事件。
 */
function timeline(model, from, to) {
  const lo = Number(from);
  const hi = Math.min(Number(to), model.now);
  const ev = [];
  const push = (e) => {
    if (e.t >= lo && e.t <= hi) ev.push(e);
  };
  for (const n of model.nodes.values()) {
    if (n.litAt != null) push({ t: n.litAt, kind: "lit", nodeId: n.id, anchorId: n.anchorId });
    for (const f of FACETS) if (n.facetPassedAt[f] != null) push({ t: n.facetPassedAt[f], kind: "facet_passed", nodeId: n.id, facet: f });
    let best = 0;
    for (const h of n.levelHistory) {
      if (h.level >= 3 && h.level > best && n.litAt != null && h.t >= n.litAt) {
        push({ t: h.t, kind: "level_up", nodeId: n.id, to: h.level >= 4 ? "firm" : "solid" });
      }
      best = Math.max(best, h.level);
    }
    for (const v of n.defVersionTimes) if (v.version >= 2) push({ t: v.t, kind: "def_revised", nodeId: n.id, version: v.version });
    // 褪色 / 回亮：按学习日终点采样（关键帧同口径），只在已点亮之后
    if (n.litAt != null) {
      let wasFading = false;
      for (const t of dayEnds(model, Math.max(n.litAt, lo - DAY), hi)) {
        const f = retentionAt(n, t).fading;
        if (f !== wasFading) push({ t, kind: f ? "fade" : "restore", nodeId: n.id });
        wasFading = f;
      }
    }
  }
  for (const e of model.edges) {
    if (e.status === "confirmed" && model.nodes.has(e.from) && model.nodes.has(e.to)) push({ t: e.createdAt, kind: "edge_confirmed", edgeId: e.id });
  }
  for (const e of model.kgEvents) {
    if (e.kind === "merged") push({ t: e.ts, kind: "merged", fromId: String(e.payload.fromId || ""), intoId: String(e.kpId || e.payload.intoId || "") });
    else if (e.kind === "split") push({ t: e.ts, kind: "split", fromId: String(e.kpId || ""), newId: String(e.payload.newId || "") });
    else if (e.kind === "archived") push({ t: e.ts, kind: "archived", nodeId: String(e.kpId || "") });
  }
  const ORDER = { lit: 0, facet_passed: 1, level_up: 2, edge_confirmed: 3, def_revised: 4, restore: 5, fade: 6, merged: 7, split: 8, archived: 9 };
  ev.sort((a, b) => a.t - b.t || ORDER[a.kind] - ORDER[b.kind] || String(a.nodeId || a.edgeId || a.fromId).localeCompare(String(b.nodeId || b.edgeId || b.fromId)));
  return ev;
}

/**
 * 按学习日的保持度关键帧（设计稿 §9.2）：{ dayEnds:number[], nodes:{ [id]: { r:number[], f:number[] } } }
 * r 为 0..100 的整数保持度（未复习 = -1），f 为褪色 0/1。回放时插值。
 */
function keyframes(model, from, to) {
  const ends = dayEnds(model, from, to);
  const nodes = {};
  for (const n of [...model.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const r = [];
    const f = [];
    for (const t of ends) {
      const x = retentionAt(n, t);
      r.push(x.n ? Math.round(x.meanR * 100) : -1);
      f.push(x.fading ? 1 : 0);
    }
    nodes[n.id] = { r, f };
  }
  return { dayEnds: ends, nodes };
}

/** 今日回放摘要（设计稿 §9.3）：from 起的新点亮、回亮、侧面、边由虚变实 */
function todaySummary(model, from) {
  const ev = timeline(model, from, model.now);
  const count = (k) => ev.filter((e) => e.kind === k).length;
  let refreshed = 0;
  for (const n of model.nodes.values()) {
    if (n.litAt == null || n.litAt >= from) continue;
    if (n.cards.some((c) => c.reviews.some((r) => r.t >= from && r.grade >= 3))) refreshed += 1;
  }
  return { from, to: model.now, lit: count("lit"), refreshed, facets: count("facet_passed"), edges: count("edge_confirmed"), levelUps: count("level_up"), events: ev };
}

module.exports = {
  FACETS,
  KINDS,
  RELATION_GROUP,
  normFacet,
  gradeOf,
  cardLitAt,
  cardStateAt,
  buildModel,
  snapshotAt,
  timeline,
  keyframes,
  todaySummary,
  retentionAt,
  levelAt
};
