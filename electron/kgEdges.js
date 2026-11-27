"use strict";
// v49.148 / D317 知识图谱连线分三层（设计 docs/design/KG-EDGE-LAYERS.md）——纯函数，不碰数据库（node 可测）。
//   世界层：全谱骨架 / 私有上级 / 也涉及（kgService 现算后传入）
//   材料层：P1–P5 原文术语论证边（v49.170 / D340 取代 M1 导图上下级 / M2 导图同节点）、M3 同一摘录制出的不同知识点卡片、AI 判断（kg-edge-judge 提案）
//   你的层：U1 带 relatedKpId 的自我解释、U2 就地批注提到另一知识点、U3 用户写的定义提到另一知识点
// 实线只来自用户（knowledge_relations）；其余达到门槛的是淡色推断线。
// 解除＝对当时的证据说「不」：证据都在解除快照里时不画；出现快照外的材料层 / 你的层新证据就重新以推断线出现。

// v49.153 / D322 / T2：世界层类型排序——骨架类型在前，情境边（example_of / application_of）随后，related_to 最后
const WORLD_TYPE_ORDER = ["part_of", "prerequisite", "contrasts_with", "analogous_to", "example_of", "application_of", "related_to"];

const TP = require("./termProject");
const { normName } = require("./kgSenseCore");

const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

/** 无序对键 */
function pairKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/**
 * 名称词表 → 在一段文字里找出提到的知识点（≥2 字；纯 ASCII 名称按词边界，其余按子串）。
 * v49.153 / D322 / T3：最长匹配优先——按名称长度从长到短扫描，命中后把该段遮掉，
 * 于是「精英政治」命中后，同一段里的「精英」不会再被算一次（其他位置仍可命中）。
 */
function buildMatcher(kps) {
  // 同名（标签 / 别名撞名）合并成一组：遮一次、把组里所有知识点都记为命中
  const groups = new Map();
  for (const k of kps) {
    for (const name of [k.label, ...(k.aliases || [])]) {
      const n = String(name || "").trim().toLowerCase();
      if (n.length < 2) continue;
      const ascii = /^[\x00-\x7f]+$/.test(n);
      const gk = `${ascii ? "a" : "u"}:${n}`;
      if (!groups.has(gk)) {
        const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // v49.153 / D322 / T4 审查修正：正则只在建组时编译一次（原实现每次 findAt 都 new RegExp）
        groups.set(gk, { n, ascii, esc, re: ascii ? new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`) : null, ids: new Set() });
      }
      groups.get(gk).ids.add(String(k.id));
    }
  }
  const terms = [...groups.values()].sort((a, b) => b.n.length - a.n.length);
  const mask = (t, i, len) => `${t.slice(0, i)}\u0000${"\u0000".repeat(len - 1)}${t.slice(i + len)}`;
  const findAt = (t, x) => {
    if (!x.ascii) return t.indexOf(x.n);
    const m = x.re.exec(t); // 非全局正则，lastIndex 不参与匹配，可安全复用
    return m ? m.index + m[1].length : -1;
  };
  return (text) => {
    let t = String(text || "").toLowerCase();
    const hit = new Set();
    if (!t) return hit;
    for (const x of terms) {
      let i = findAt(t, x);
      if (i < 0) continue;
      for (const id of x.ids) hit.add(id);
      // 该名称的全部出现位置都遮掉，避免同一段的短名再次命中
      while (i >= 0) {
        t = mask(t, i, x.n.length);
        i = findAt(t, x);
      }
    }
    return hit;
  };
}

// ───────────────────────── v49.170 / D340 / I6：论证边 P1–P5（KG-SG-IMPL-PLAN §4.2） ─────────────────────────
// 节点间论证关系 ＝ 显式 material_map_edges.code ∪ 按节点类型推导的父子隐含关系（隐含关系不入库，这里现算）。
const ARG_TYPE_ORDER = ["prerequisite", "contrasts_with", "example_of", "related_to"];
/** 子节点类型 → 隐含关系；from 指明关系的声明方（A）是子还是父 */
const IMPLICIT_BY_CHILD = {
  理由: { code: "支", from: "child" },
  证据: { code: "支", from: "child" },
  例证: { code: "例", from: "child" },
  案例: { code: "例", from: "child" },
  反方观点: { code: "驳", from: "child" },
  反驳: { code: "驳", from: "child" },
  定义: { code: "据", from: "parent" },
  前提: { code: "据", from: "parent" },
  引理: { code: "据", from: "parent" },
  推导: { code: "推", from: "parent" },
  结论: { code: "推", from: "parent" }
};
/** 父节点是叙事 / 背景 / 引言时，父子之间只是行文顺序，不产生任何隐含论证关系（设计 §7） */
const NO_IMPLICIT_PARENT_TYPES = new Set(["叙事", "背景", "引言"]);
const COMPARE_PATTERNS = new Set(["compare", "对照"]);

/**
 * ta = { terms:[{id, documentId, blockNo, quote, surface, surfaceNorm, role, atlasId(已链接时的整数，否则 null)}],
 *        nodes:[{documentId, mapId, nodeId, parentId, type, pattern, blockStart, blockEnd}],
 *        edges:[{documentId, mapId, fromId, toId, code}] }
 * 证据对象（推入 p.material）：{ key:"m:<documentId>", kind:"arg", rule:"P1".."P5", code, pred, argType, argFrom, argTo,
 *   documentId, mapId, fromNodeId, toNodeId, quoteA, quoteB, blockA, blockB, kpA, kpB }
 *   A＝关系的声明方（from）节点一侧，B＝to 一侧；kpA / kpB 是 quoteA / quoteB 所讲 / 所用的知识点；
 *   argFrom → argTo 是推断线方向（P2 据：B 的 Y 是 A 的 X 的依据，Y → X；P2 支：A 的 X 是 B 的 Y 的依据，X → Y）；P1 / P5 同块无 code（code=""）。
 */
function collectTermArgs(ta, ctx) {
  const { kps, kpByAtlas, canon, get } = ctx;
  const terms = Array.isArray(ta.terms) ? ta.terms : [];
  if (!terms.length) return;
  const nodes = Array.isArray(ta.nodes) ? ta.nodes : [];
  const nodeMap = new Map();
  for (const n of nodes) nodeMap.set(`${n.mapId}\u0000${n.nodeId}`, n);
  const index = TP.buildIndex(nodes);

  // 术语 → 知识点：atlas_id 命中知识点 atlasId（Q 前缀），或 surface_norm 等于知识点 normName(label)
  const byName = new Map();
  for (const k of kps) {
    const nn = normName(k.label);
    if (!nn) continue;
    if (!byName.has(nn)) byName.set(nn, []);
    byName.get(nn).push(String(k.id));
  }
  const kpsOfTerm = (t) => {
    const out = new Set();
    if (t.atlasId != null) {
      const id = kpByAtlas.get("Q" + t.atlasId);
      if (id) out.add(id);
    }
    for (const id of byName.get(String(t.surfaceNorm || "")) || []) out.add(id);
    return [...out].sort();
  };

  // 术语归属节点（最深覆盖），按 讲 / 用 / 实例 分组
  const sorted = [...terms].sort((x, y) => Number(x.blockNo) - Number(y.blockNo) || String(x.id).localeCompare(String(y.id)));
  const nodeTerms = new Map(); // nodeKey → { node, taught, used, inst }
  for (const t of sorted) {
    if (t.role === "work" || !(Number(t.blockNo) >= 0)) continue;
    const ks = kpsOfTerm(t);
    if (!ks.length) continue;
    for (const o of TP.ownersOf(index, t.documentId, Number(t.blockNo))) {
      const nk = `${o.mapId}\u0000${o.nodeId}`;
      let g = nodeTerms.get(nk);
      if (!g) {
        g = { node: nodeMap.get(nk) || o, taught: [], used: [], inst: [], seen: new Set() };
        nodeTerms.set(nk, g);
      }
      const list = TP.isTeach(t.role) ? g.taught : t.role === "uses" ? g.used : t.role === "instance" ? g.inst : null;
      if (!list) continue;
      for (const kp of ks) {
        const dk = `${t.role === "instance" ? "i" : t.role === "uses" ? "u" : "t"}|${kp}|${t.blockNo}`;
        if (g.seen.has(dk)) continue;
        g.seen.add(dk);
        list.push({ kp, quote: String(t.quote || ""), block: Number(t.blockNo), surface: String(t.surface || ""), termId: String(t.id) });
      }
    }
  }
  if (!nodeTerms.size) return;

  const emitted = new Set();
  const emit = (rule, code, pred, type, A, B, ea, eb, fromKp, toKp) => {
    if (ea.kp === eb.kp) return;
    const p = get(fromKp, toKp);
    if (!p) return;
    const documentId = String(A.documentId);
    const nodePair = rule === "P3" && String(A.nodeId) > String(B.nodeId) ? [B.nodeId, A.nodeId] : [A.nodeId, B.nodeId];
    const dk = `${p.key}|${rule}|${code}|${A.mapId}|${nodePair.join(">")}|${ea.block}|${eb.block}|${[ea.kp, eb.kp].sort().join(",")}`;
    if (emitted.has(dk)) return;
    emitted.add(dk);
    p.docs.add(documentId);
    p.material.push({
      key: `m:${documentId}`,
      kind: "arg",
      rule,
      code,
      pred,
      argType: type,
      argFrom: canon(fromKp),
      argTo: canon(toKp),
      documentId,
      mapId: String(A.mapId),
      fromNodeId: String(A.nodeId),
      toNodeId: String(B.nodeId),
      quoteA: ea.quote,
      quoteB: eb.quote,
      blockA: ea.block,
      blockB: eb.block,
      kpA: ea.kp,
      kpB: eb.kp
    });
  };
  const termsOf = (n) => nodeTerms.get(`${n.mapId}\u0000${n.nodeId}`) || null;

  // P1：同一节点（同块必同节点）内，Y 被讲、X 被 uses → X 前置于 Y
  for (const g of nodeTerms.values()) {
    for (const X of g.used) for (const Y of g.taught) emit("P1", "", null, "prerequisite", g.node, g.node, X, Y, X.kp, Y.kp);
    // P5（同块）：同块 instance X 与讲 Y → X 是 Y 的例子
    for (const X of g.inst) for (const Y of g.taught) if (X.block === Y.block) emit("P5", "", null, "example_of", g.node, g.node, X, Y, X.kp, Y.kp);
  }

  // 节点间关系：显式码 ∪ 父子隐含（答 不产生连线；叙事 / 背景 / 引言 父节点不产生隐含关系）
  const rels = new Map();
  const addRel = (a, b, code) => {
    const rk = `${a.mapId}\u0000${a.nodeId}\u0000${b.nodeId}\u0000${code}`;
    if (!rels.has(rk)) rels.set(rk, { A: a, B: b, code });
  };
  for (const e of ta.edges || []) {
    const a = nodeMap.get(`${e.mapId}\u0000${e.fromId}`);
    const b = nodeMap.get(`${e.mapId}\u0000${e.toId}`);
    if (a && b && a !== b) addRel(a, b, String(e.code));
  }
  for (const n of nodes) {
    if (n.parentId == null) continue;
    const impl = IMPLICIT_BY_CHILD[n.type];
    const parent = nodeMap.get(`${n.mapId}\u0000${n.parentId}`);
    if (!impl || !parent || NO_IMPLICIT_PARENT_TYPES.has(parent.type)) continue;
    if (impl.from === "child") addRel(n, parent, impl.code);
    else addRel(parent, n, impl.code);
  }
  for (const [, r] of [...rels].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    const ga = termsOf(r.A);
    const gb = termsOf(r.B);
    if (!ga || !gb) continue;
    const { A, B, code } = r;
    if (code === "据") {
      // P2（据）：A 依据 B——B 的 Y 是 A 的 X 的依据 → Y 前置于 X
      for (const X of ga.taught) for (const Y of gb.taught) emit("P2", code, null, "prerequisite", A, B, X, Y, Y.kp, X.kp);
    } else if (code === "支") {
      // P2（支）：A 支持 B——A 的 X 是 B 的 Y 的依据 → X 前置于 Y（与「据」方向相反；见交接报告的偏离说明）
      for (const X of ga.taught) for (const Y of gb.taught) emit("P2", code, null, "prerequisite", A, B, X, Y, X.kp, Y.kp);
    } else if (code === "推" || code === "因") {
      for (const X of ga.taught) for (const Y of gb.taught) emit("P2", code, code === "推" ? "推出" : "导致", "related_to", A, B, X, Y, X.kp, Y.kp);
    } else if (code === "比") {
      for (const X of ga.taught) for (const Y of gb.taught) emit("P3", code, null, "contrasts_with", A, B, X, Y, X.kp, Y.kp);
    } else if (code === "驳") {
      for (const X of ga.taught) for (const Y of gb.taught) emit("P4", code, "反驳", "contrasts_with", A, B, X, Y, X.kp, Y.kp);
    } else if (code === "例") {
      for (const X of [...ga.inst, ...ga.taught]) for (const Y of gb.taught) emit("P5", code, null, "example_of", A, B, X, Y, X.kp, Y.kp);
    }
  }

  // P3（兄弟）：同一 {对照} 父节点下的兄弟，分讲 X、Y
  for (const g of nodes) {
    if (!COMPARE_PATTERNS.has(String(g.pattern || ""))) continue;
    const kids = nodes.filter((n) => n.mapId === g.mapId && n.parentId === g.nodeId).sort((x, y) => (String(x.nodeId) < String(y.nodeId) ? -1 : 1));
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const ga = termsOf(kids[i]);
        const gb = termsOf(kids[j]);
        if (!ga || !gb) continue;
        for (const X of ga.taught) for (const Y of gb.taught) emit("P3", "比", null, "contrasts_with", kids[i], kids[j], X, Y, X.kp, Y.kp);
      }
    }
  }
}

/** 论证证据给出的推断类型（仅在无 AI 判断、无世界层时使用）：最多者胜，平手按 prerequisite > contrasts_with > example_of > related_to；方向取该类型里最多的 from→to */
function argSuggestion(p) {
  const entries = p.material.filter((m) => m.kind === "arg" && m.argType);
  if (!entries.length) return null;
  const tally = new Map();
  for (const e of entries) tally.set(e.argType, (tally.get(e.argType) || 0) + 1);
  let type = null;
  for (const t of ARG_TYPE_ORDER) {
    const n = tally.get(t) || 0;
    if (n > 0 && (type == null || n > tally.get(type))) type = t;
  }
  const dirs = new Map();
  for (const e of entries) if (e.argType === type) dirs.set(`${e.argFrom}|${e.argTo}`, (dirs.get(`${e.argFrom}|${e.argTo}`) || 0) + 1);
  const best = [...dirs].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0].split("|");
  return { type, from: best[0], to: best[1] };
}

/**
 * 汇总每个无序对的三层证据。
 * input = { kps, allKps, confirmed, world, defVersions, edgeFacts, cardKp: Map, matchLimit }
 *   kps：图上的知识点（已排除被合并的）{ id, label, aliases, description, atlasId:"Q…" }
 *   allKps：含被合并者的行 { id, mergedInto }（用于把证据归到最终知识点）
 *   confirmed：knowledge_relations 行 { id, fromId, toId, type, createdAt }
 *   world：全谱派生边 { id, fromId, toId, type }
 */
function collectPairs(input) {
  const kps = input.kps || [];
  const present = new Set(kps.map((k) => String(k.id)));
  const merged = new Map();
  for (const k of input.allKps || []) if (k.mergedInto) merged.set(String(k.id), String(k.mergedInto));
  const canon = (id) => {
    let cur = String(id || "");
    const seen = new Set([cur]);
    while (merged.has(cur) && !seen.has(merged.get(cur))) {
      cur = merged.get(cur);
      seen.add(cur);
    }
    return present.has(cur) ? cur : null;
  };
  const pairs = new Map();
  const get = (a0, b0) => {
    const a = canon(a0);
    const b = canon(b0);
    if (!a || !b || a === b) return null;
    const key = pairKey(a, b);
    let p = pairs.get(key);
    if (!p) {
      const [x, y] = key.split("|");
      p = { key, a: x, b: y, world: [], confirmed: [], material: [], ai: [], mine: [], defMatch: [], text: [], cardText: [], docs: new Set() };
      pairs.set(key, p);
    }
    return p;
  };
  const ef = input.edgeFacts || {};

  for (const r of input.confirmed || []) {
    const p = get(r.fromId, r.toId);
    if (p) p.confirmed.push({ id: String(r.id), fromId: canon(r.fromId), toId: canon(r.toId), type: String(r.type), createdAt: Number(r.createdAt) || 0 });
  }
  for (const r of input.world || []) {
    const p = get(r.fromId, r.toId);
    // ctx＝来自全谱情境边（e/u/r）；pred 供证据面板显示；两者都随世界层证据一起保留
    if (p && !p.world.some((w) => w.id === String(r.id))) p.world.push({ key: `w:${r.id}`, id: String(r.id), fromId: canon(r.fromId), toId: canon(r.toId), type: String(r.type), pred: r.pred || null, ctx: Boolean(r.ctx) });
  }

  // 材料层
  const kpByAtlas = new Map();
  for (const k of kps) if (k.atlasId) kpByAtlas.set(String(k.atlasId), String(k.id));
  // v49.170 / D340 / I6：论证边 P1–P5 取代 M1 父↔子 / M2 同节点（设计 KG-SOURCE-GROUNDED §7；契约 KG-SG-IMPL-PLAN §4.2）。
  //   原料 ef.termArgs = { terms, nodes, edges }（db.kgEdgeFacts）；节点上的知识点不再来自挂靠 / 卡片挂靠，而来自原文术语。
  if (ef.termArgs) collectTermArgs(ef.termArgs, { kps, kpByAtlas, canon, get });
  const cardKp = input.cardKp || new Map();
  const kpsByExtract = new Map();
  for (const r of ef.extractCards || []) {
    const kp = canon(cardKp.get(String(r.cardId)));
    if (!kp || !r.extractId) continue;
    const x = String(r.extractId);
    if (!kpsByExtract.has(x)) kpsByExtract.set(x, new Set());
    kpsByExtract.get(x).add(kp);
  }
  for (const [x, set] of kpsByExtract) {
    const ids = [...set].sort();
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const p = get(ids[i], ids[j]);
        if (p) p.material.push({ key: `x:${x}`, kind: "extract", extractId: x });
      }
  }
  for (const j of ef.judgments || []) {
    if (j.status !== "pending") continue;
    const pl = parse(j.payloadJson, {}) || {};
    const p = get(pl.kpA, pl.kpB);
    if (!p || !pl.relationType || pl.relationType === "none") continue;
    p.ai.push({ key: `ai:${j.id}`, id: String(j.id), type: String(pl.relationType), fromId: canon(pl.fromKnowledgePointId) || p.a, toId: canon(pl.toKnowledgePointId) || p.b, quote: String(pl.quote || ""), createdAt: Number(j.createdAt) || 0 });
  }

  // 你的层
  for (const e of ef.explains || []) {
    const pl = parse(e.payloadJson, {}) || {};
    if (!pl.relatedKpId) continue;
    const p = get(e.kpId, pl.relatedKpId);
    if (p) p.mine.push({ key: `u:se:${e.id}`, kind: "explain", eventId: String(e.id), ts: Number(e.ts) || 0 });
  }
  const limit = Number.isFinite(input.matchLimit) ? input.matchLimit : 5000;
  if (kps.length <= limit) {
    const match = buildMatcher(kps);
    for (const an of ef.annotations || []) {
      const hits = [...match(an.comment)];
      const own = [...(kpsByExtract.get(String(an.id)) || [])];
      const seen = new Set();
      const add = (a, b) => {
        const p = get(a, b);
        if (!p || seen.has(p.key)) return;
        seen.add(p.key);
        p.mine.push({ key: `u:an:${an.id}`, kind: "annotation", extractId: String(an.id) });
      };
      for (const o of own) for (const h of hits) add(o, h);
      for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) add(hits[i], hits[j]);
    }
    for (const d of ef.userDefs || []) {
      const self = canon(d.kpId);
      if (!self) continue;
      for (const h of match(d.body)) {
        const p = get(self, h);
        if (p && !p.mine.some((m) => m.key === `u:def:${d.id}`)) p.mine.push({ key: `u:def:${d.id}`, kind: "def", defId: String(d.id), kpId: self });
      }
    }
    // 当前定义不是用户写的（AI / 旧定义）：只作弱证据，单独不达门槛
    const latestAuthor = new Map();
    for (const v of input.defVersions || []) {
      const id = canon(v.kpId);
      if (!id) continue;
      const cur = latestAuthor.get(id);
      if (!cur || Number(v.seq) > cur.seq) latestAuthor.set(id, { seq: Number(v.seq), author: v.author });
    }
    for (const k of kps) {
      const la = latestAuthor.get(String(k.id));
      if (la && la.author === "user") continue; // 已作为 U3 计入
      for (const h of match(k.description)) {
        const p = get(k.id, h);
        if (p && !p.defMatch.some((m) => m.kpId === String(k.id))) p.defMatch.push({ key: `d:${k.id}`, kpId: String(k.id) });
      }
    }
    // v49.153 / D322 / T3：M4——摘录原文 / 卡片正文提到另一个知识点。
    //   只扫「制过卡的摘录」（kpsByExtract 已按卡片关联建好）；一条摘录对同一对知识点只记 1 次。
    const extractTextById = new Map();
    for (const r of ef.extractTexts || []) extractTextById.set(String(r.extractId), String(r.text || ""));
    for (const [x, set] of kpsByExtract) {
      const text = extractTextById.get(x);
      if (!text) continue;
      const own = new Set([...set].map(canon).filter(Boolean));
      const hits = new Set([...match(text)].map(canon).filter(Boolean));
      if (!hits.size) continue;
      const seen = new Set();
      const addText = (a0, b0, strong) => {
        const p = get(a0, b0);
        if (!p || seen.has(p.key)) return;
        seen.add(p.key);
        p.text.push({ key: `t:${x}`, kind: strong ? "text" : "textBoth", extractId: x, strong });
      };
      // M4a（强）：为 A 制卡的摘录，原文提到 B（B 不是这条摘录制过卡的知识点时才算；否则已有 M3）
      for (const a of own) for (const h of hits) if (h !== a && !own.has(h)) addText(a, h, true);
      // M4b（弱）：原文同时提到 A、B，但这条摘录不是为二者中任何一个制的卡
      const hs = [...hits].sort();
      for (let i = 0; i < hs.length; i++)
        for (let j = i + 1; j < hs.length; j++) if (!own.has(hs[i]) && !own.has(hs[j])) addText(hs[i], hs[j], false);
    }
    // 卡片正文：只有显式 generated_by=manual 的卡才算用户自己写的（U3 同级，键 u:card:）；其余（AI / 导入 / 空值）都是弱证据（c:，不能重新出现）。
    // v49.153 / D322 / T4 审查修正：空值不再默认按 manual 处理——落库默认值只是历史口径，不能当作用户手写的证明。
    for (const r of ef.cardTexts || []) {
      const own = canon(r.kpId);
      if (!own) continue;
      const cardId = String(r.cardId);
      const mineCard = String(r.generatedBy ?? "") === "manual";
      const key = `${mineCard ? "u:card" : "c"}:${cardId}`;
      for (const h0 of match(r.text)) {
        const h = canon(h0);
        if (!h || h === own) continue;
        const p = get(own, h);
        if (!p) continue;
        const bucket = mineCard ? p.mine : p.cardText;
        if (!bucket.some((m) => m.key === key)) bucket.push({ key, kind: "card", cardId });
      }
    }
  }
  pairs.canon = canon;
  return pairs;
}

/** 一个对子当前的全部证据键（解除快照用） */
function evidenceKeys(p) {
  const keys = new Set();
  for (const x of [...p.world, ...p.material, ...p.ai, ...p.mine, ...p.defMatch, ...p.text, ...p.cardText]) keys.add(x.key);
  return [...keys].sort();
}

/**
 * 能让解除过的线重新出现的证据：材料层与你的层（全谱是静态参考数据，定义匹配与卡片正文都是弱证据，都不算）。
 * v49.153 / D322 / T3：t:（摘录原文）属于材料层，能让解除过的线重新出现；c:（AI 写的卡片正文）不能。
 */
function canResurface(key) {
  return /^(m|x|t|ai|u):/.test(key);
}

/**
 * 依证据与解除记录得出图上的边。
 * dismissals：[{ a, b, keysJson, count, at }]
 * 返回 { edges, maybe: [{a,b}], pairs }，edges 交给 kgCore（字段见下）。
 */
function resolveEdges(pairs, dismissals) {
  // 合并不改写解除行：按最终知识点归并（同一对有多条时证据快照取并集、次数相加、时间取最近）
  const canon = typeof pairs.canon === "function" ? pairs.canon : (id) => String(id);
  const dis = new Map();
  for (const d of dismissals || []) {
    const a = canon(d.a);
    const b = canon(d.b);
    if (!a || !b || a === b) continue;
    const key = pairKey(a, b);
    const cur = dis.get(key);
    const keys = new Set(parse(d.keysJson, []) || []);
    if (cur) {
      for (const k of keys) cur.keys.add(k);
      cur.count += Number(d.count) || 1;
      cur.at = Math.max(cur.at, Number(d.at) || 0);
    } else dis.set(key, { keys, count: Number(d.count) || 1, at: Number(d.at) || 0 });
  }
  const edges = [];
  const maybe = [];
  for (const p of pairs.values()) {
    const docCount = p.docs.size;
    const nExtract = p.material.filter((m) => m.kind === "extract").length;
    // v49.153 / D322 / T3：摘录原文（M4）与卡片正文（弱）都算材料层证据
    const nMaterial = docCount + nExtract + p.text.length + p.cardText.length + p.ai.length;
    const layers = { w: p.world.length, m: nMaterial, u: p.mine.length };
    const explained = p.mine.some((m) => m.kind === "explain");
    p.layers = layers;
    p.dismissal = null;
    p.newKeys = [];
    if (p.confirmed.length) {
      p.state = "confirmed";
      for (const r of p.confirmed) {
        edges.push({ id: r.id, fromId: r.fromId, toId: r.toId, type: r.type, createdAt: r.createdAt, suggested: false, world: p.world.length > 0, layers, unexplained: !explained, resurfaced: null, pair: p.key });
      }
      continue;
    }
    const d = dis.get(p.key);
    if (d) {
      // v49.153 / D322 / T5：只靠组合规则重新达到门槛时，也必须有快照外的新键能让线重新出现；
      //   新的 c: / d: 不在 canResurface 里，单独出现不会让已解除的线回来。
      const fresh = evidenceKeys(p).filter((k) => canResurface(k) && !d.keys.has(k));
      p.dismissal = { at: d.at, count: d.count };
      p.newKeys = fresh;
      if (!fresh.length) {
        p.state = "dismissed";
        continue;
      }
    }
    // v49.153 / D322 / T5：门槛改写（设计 KG-EDGE-DENSITY §3.3）——强证据，或两类不同的弱证据组合。
    //   强：世界层（骨架 / 私有上级 / 也涉及 / 情境边）/ P1–P5 ≥2 份材料 / M3 / M4a / M4b ≥2 条不同摘录 /
    //       AI 判断 / 你的层任一（U1-U3，含 u:card:）。
    //   弱（同一类别只算一次，不与自己组合）：单份材料的导图证据（docCount = 1）/ M4b / 卡片正文 c: / AI 写的定义 d:。
    const m4bExtracts = new Set(p.text.filter((t) => !t.strong).map((t) => t.extractId));
    const strong = p.world.length > 0 || docCount >= 2 || nExtract >= 1 || p.text.some((t) => t.strong) || m4bExtracts.size >= 2 || p.ai.length > 0 || p.mine.length > 0;
    const weak = new Set();
    if (docCount === 1) weak.add("map");
    if (m4bExtracts.size > 0) weak.add("textBoth");
    if (p.cardText.length) weak.add("cardText");
    if (p.defMatch.length) weak.add("defMatch");
    if (!strong && weak.size < 2) {
      p.state = "none";
      if (weak.size > 0) maybe.push({ a: p.a, b: p.b });
      continue;
    }
    p.state = "inferred";
    let type = "related_to";
    let from = p.a;
    let to = p.b;
    const ai = [...p.ai].sort((x, y) => y.createdAt - x.createdAt)[0];
    if (ai) {
      type = ai.type;
      from = ai.fromId;
      to = ai.toId;
    } else if (p.world.length) {
      const w = [...p.world].sort((x, y) => WORLD_TYPE_ORDER.indexOf(x.type) - WORLD_TYPE_ORDER.indexOf(y.type))[0];
      type = w.type;
      from = w.fromId;
      to = w.toId;
    } else {
      // v49.170 / D340 / I6：只有材料论证证据时用 P1–P5 的建议类型（无 AI 判断、无世界层）
      const sg = argSuggestion(p);
      if (sg) {
        type = sg.type;
        from = sg.from;
        to = sg.to;
      }
    }
    p.inferredType = { type, from, to };
    edges.push({
      id: `inf:${p.key}`,
      fromId: from,
      toId: to,
      type,
      createdAt: 0,
      suggested: true,
      world: p.world.length > 0,
      // v49.153 / D322 / T3：只靠情境边出的世界层证据（锚点分层时排除，行为与 T2 之前一致）
      ctx: p.world.length > 0 && p.world.every((w) => w.ctx),
      // 只有材料层 / AI / 情境边证据的推断线：两端都点亮才画（只看已学的知识点）；骨架边保持现状。
      // v49.153 / D322 / T5：组合规则出线的对子没有世界层 / 你的层证据，因此同样要求两端点亮。
      requireLit: p.mine.length === 0 && (p.world.length === 0 || p.world.every((w) => w.ctx)),
      layers,
      unexplained: false,
      resurfaced: p.dismissal && p.newKeys.length ? { at: p.dismissal.at, count: p.dismissal.count } : null,
      pair: p.key
    });
  }
  edges.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return { edges, maybe, pairs };
}

/**
 * v49.172 / D342：材料论证关系投影到全谱（设计 KG-SOURCE-GROUNDED §8.6 第 1 层旁的「材料投影」，精确率 material 0.92）。
 * 与 collectTermArgs 同一套 P1–P5 规则，但术语不必是知识点：链接了全谱的术语以 "Q<id>" 作端点，
 * 名称等于知识点的术语仍归到该知识点。这样书里「特朗普……美国梦」的论证，即使「唐纳德·特朗普」不是你的知识点也不会被丢掉。
 * @param ta  db.kgEdgeFacts().termArgs（已 dropStale）
 * @param kps [{id, label, atlasId:"Q…"|null}]
 * @returns [{a, b, argType, from, to, pred, docs}]  a/b/from/to＝"Q<id>" 或知识点 id
 */
function projectTermArgs(ta, kps) {
  if (!ta || !Array.isArray(ta.terms) || !ta.terms.length) return [];
  const kpAtlas = new Map();
  for (const k of kps || []) if (k.atlasId) kpAtlas.set(String(k.atlasId), String(k.id));
  const pairs = new Map();
  const get = (a, b) => {
    if (!a || !b || a === b) return null;
    const key = pairKey(a, b);
    let p = pairs.get(key);
    if (!p) {
      p = { key, material: [], docs: new Set() };
      pairs.set(key, p);
    }
    return p;
  };
  // 已有知识点的条目归到知识点；其余链接了全谱的术语直接以条目作端点
  const kpByAtlas = { get: (q) => kpAtlas.get(q) || q };
  collectTermArgs(ta, { kps: kps || [], kpByAtlas, canon: (id) => (id ? String(id) : null), get });
  const out = [];
  for (const p of pairs.values()) {
    const sg = argSuggestion(p);
    if (!sg) continue;
    const pred = (p.material.find((m) => m.argType === sg.type && m.pred) || {}).pred || null;
    const [a, b] = p.key.split("|");
    out.push({ a, b, argType: sg.type, from: sg.from, to: sg.to, pred, docs: p.docs.size });
  }
  return out;
}

module.exports = { collectPairs, resolveEdges, evidenceKeys, canResurface, pairKey, buildMatcher, projectTermArgs };
