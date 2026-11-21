"use strict";
// v49.148 / D317 知识图谱连线分三层（设计 docs/design/KG-EDGE-LAYERS.md）——纯函数，不碰数据库（node 可测）。
//   世界层：全谱骨架 / 私有上级 / 也涉及（kgService 现算后传入）
//   材料层：M1 导图上下级、M2 导图同节点、M3 同一摘录制出的不同知识点卡片、AI 判断（kg-edge-judge 提案）
//   你的层：U1 带 relatedKpId 的自我解释、U2 就地批注提到另一知识点、U3 用户写的定义提到另一知识点
// 实线只来自用户（knowledge_relations）；其余达到门槛的是淡色推断线。
// 解除＝对当时的证据说「不」：证据都在解除快照里时不画；出现快照外的材料层 / 你的层新证据就重新以推断线出现。

// v49.153 / D322 / T2：世界层类型排序——骨架类型在前，情境边（example_of / application_of）随后，related_to 最后
const WORLD_TYPE_ORDER = ["part_of", "prerequisite", "contrasts_with", "analogous_to", "example_of", "application_of", "related_to"];

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
  const kpOfAtlasInt = (n) => kpByAtlas.get("Q" + n) || null;
  // M1 父↔子 / M2 同节点（v49.153 / D322 / T4）：节点上的知识点 = 全谱挂靠 ∪ 卡片挂靠
  //   （卡片 context_ref_json.mindmapNodeId = "v2:<mapId>:<nodeId>" 落在该节点上，私有知识点也适用）。
  //   真实 kgEdgeFacts 提供 mapRefs（全谱挂靠）时按并集重算；只注入 mapParent / mapSame 的旧调用走原路径。
  if (Array.isArray(ef.mapRefs)) {
    const nodes = new Map(); // `${mapId}\u0000${nodeId}` → { documentId, mapId, nodeId, parentNodeId, kps }
    const attach = (r, kpId) => {
      if (!kpId) return;
      const key = `${r.mapId}\u0000${r.nodeId}`;
      let n = nodes.get(key);
      if (!n) {
        n = { documentId: String(r.documentId), mapId: String(r.mapId), nodeId: String(r.nodeId), parentNodeId: r.parentNodeId == null ? null : String(r.parentNodeId), kps: new Set() };
        nodes.set(key, n);
      }
      n.kps.add(String(kpId));
    };
    for (const r of ef.mapRefs) attach(r, kpOfAtlasInt(r.atlasId));
    for (const r of ef.mapCardNodes || []) attach(r, canon(r.kpId));
    const addMapPair = (a, b, material) => {
      const p = get(a, b);
      if (!p) return;
      p.docs.add(material.documentId);
      p.material.push(material);
    };
    for (const n of nodes.values()) {
      const ids = [...n.kps].sort();
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
          addMapPair(ids[i], ids[j], { key: `m:${n.documentId}`, kind: "node", documentId: n.documentId, mapId: n.mapId, nodeId: n.nodeId });
      if (n.parentNodeId == null) continue;
      const parent = nodes.get(`${n.mapId}\u0000${n.parentNodeId}`);
      if (!parent) continue;
      for (const a of parent.kps)
        for (const b of n.kps)
          addMapPair(a, b, { key: `m:${n.documentId}`, kind: "map", documentId: n.documentId, mapId: n.mapId, parentNodeId: parent.nodeId, childNodeId: n.nodeId });
    }
  } else {
    for (const r of ef.mapParent || []) {
      const p = get(kpOfAtlasInt(r.parentAtlas), kpOfAtlasInt(r.childAtlas));
      if (!p) continue;
      p.docs.add(String(r.documentId));
      p.material.push({ key: `m:${r.documentId}`, kind: "map", documentId: String(r.documentId), mapId: String(r.mapId), parentNodeId: String(r.parentNodeId), childNodeId: String(r.childNodeId) });
    }
    for (const r of ef.mapSame || []) {
      const p = get(kpOfAtlasInt(r.atlasA), kpOfAtlasInt(r.atlasB));
      if (!p) continue;
      p.docs.add(String(r.documentId));
      p.material.push({ key: `m:${r.documentId}`, kind: "node", documentId: String(r.documentId), mapId: String(r.mapId), nodeId: String(r.nodeId) });
    }
  }
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
    //   强：世界层（骨架 / 私有上级 / 也涉及 / 情境边）/ M1-M2 ≥2 份材料 / M3 / M4a / M4b ≥2 条不同摘录 /
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

module.exports = { collectPairs, resolveEdges, evidenceKeys, canResurface, pairKey, buildMatcher };
