"use strict";
// v49.170 / D340 / I6：原文术语的读取与手动修正口（KG-SG-IMPL-PLAN §2 IPC 清单 / §4.1 / §4.4）。
//   kg:sourceTermsForMap / kg:termAppearances / kg:sourceTermReject / kg:sourceTermLink / kg:workAnchor / kg:workAnchorConfirm
// 依赖注入（node 可测）：h = { db:{queryAll,run,withTransaction}, atlas?:{getNodes,search}, engine?:{graphNodeText}, broadcast?:({documentId})=>void }
//   写入后 broadcast（main.js 里负责向窗口推 sourceTerms:changed 并让图谱缓存失效）。
const TP = require("./termProject");
const ST = require("./sourceTerms");

const CAP = 50;
const LINKED = "('linked','user')";

const atlasInt = (v) => {
  if (v == null || v === "") return null;
  const s = String(v);
  const n = Number(s[0] === "Q" || s[0] === "q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function labelsFor(h, ints) {
  const out = new Map();
  if (!h.atlas || !h.atlas.getNodes || !ints.length) return out;
  try {
    for (const n of h.atlas.getNodes(ints.map((n) => "Q" + n)) || []) if (n) out.set(n.id, n.zh || n.en || n.ja || null);
  } catch {
    /* 全谱不可用：退回术语写法 */
  }
  return out;
}

/** 目录骨架行（source='toc'）不作为术语归属节点（S2，与引擎 unitBlocks 同口径）；仍保留在 nodeRows 里用于深度 / 路径 */
const notToc = (n) => n.source !== "toc";

/**
 * S4：会话就绪的单元上，丢弃 block_hash 与现文不符的过期行；会话不在 / 单元未就绪 → 原样保留。
 * terms 需含 documentId（或由 documentId 参数给出）、unitAnchor、blockNo、blockHash。
 */
function dropStale(engine, terms, documentId) {
  if (!engine || typeof engine.unitBlocks !== "function" || !terms || !terms.length) return terms || [];
  const hashes = new Map(); // `${doc}\u0000${anchor}` → Map<no, hash> | null
  const hashesOf = (doc, anchor) => {
    const k = `${doc}\u0000${anchor}`;
    if (!hashes.has(k)) {
      let m = null;
      try {
        const ub = engine.unitBlocks({ documentId: doc, unitAnchor: anchor });
        if (ub && ub.ready) m = new Map((ub.blocks || []).map((b) => [b.no, ST.blockHash(b.text)]));
      } catch {
        m = null;
      }
      hashes.set(k, m);
    }
    return hashes.get(k);
  };
  return terms.filter((t) => {
    const doc = t.documentId || documentId;
    if (!t.unitAnchor || !doc) return true;
    const m = hashesOf(doc, t.unitAnchor);
    if (!m) return true;
    const h = m.get(t.blockNo);
    return h == null || h === t.blockHash;
  });
}

function nodeRows(db, mapId) {
  return db.queryAll(
    `SELECT m.document_id AS documentId, n.map_id AS mapId, n.node_id AS nodeId, n.parent_id AS parentId, n.title, n.type,
            n.block_start AS blockStart, n.block_end AS blockEnd, n.source AS source
       FROM material_map_nodes n JOIN material_maps m ON m.id = n.map_id
      WHERE n.map_id = ? AND n.is_deleted = 0`,
    [String(mapId)]
  );
}

/**
 * 导图 mapId 上每个节点的原文术语（最深覆盖节点归属）。
 * 返回 { documentId, nodes:[{ nodeId, unitAnchor, lowDensity, taught:[…], used:[…] }] }（只含有术语或低密度的节点；节点按块区间排序）。
 * unitAnchor：会话就绪时取引擎 graphNodeText 的单元锚；否则取节点块区间内任一术语行的 unit_anchor；都没有 null。
 * lowDensity：unitAnchor 已知且 source_term_coverage.status = 'low_density'。
 */
function sourceTermsForMap(h, mapId) {
  const db = h.db;
  const map = db.queryAll("SELECT id, document_id AS documentId FROM material_maps WHERE id = ? AND is_deleted = 0", [String(mapId)])[0];
  if (!map) return { documentId: null, nodes: [] };
  const documentId = map.documentId;
  const allNodes = TP.withDepths(nodeRows(db, mapId).map((n) => ({ ...n, documentId })));
  const nodes = allNodes.filter(notToc);
  const index = TP.buildIndex(nodes);
  const terms = dropStale(h.engine, db.queryAll(
    `SELECT id, unit_anchor AS unitAnchor, block_hash AS blockHash, block_no AS blockNo, quote, surface, surface_norm AS surfaceNorm, role, atlas_id AS atlasId, link_state AS linkState
       FROM source_terms WHERE document_id = ? AND is_deleted = 0 AND link_state != 'rejected' AND role != 'work' AND block_no >= 0
      ORDER BY block_no, created_at, id`,
    [documentId]
  ), documentId);
  const linkedInts = [...new Set(terms.filter((t) => t.atlasId != null && (t.linkState === "linked" || t.linkState === "user")).map((t) => Number(t.atlasId)))];
  const labels = labelsFor(h, linkedInts);
  const byNode = new Map(); // nodeId → { node, taught, used, anchors:Set }
  const ensure = (n) => {
    let g = byNode.get(n.nodeId);
    if (!g) {
      g = { node: n, taught: [], used: [], anchors: new Set() };
      byNode.set(n.nodeId, g);
    }
    return g;
  };
  for (const t of terms) {
    const owner = TP.ownersOf(index, documentId, Number(t.blockNo))[0];
    if (!owner) continue;
    const g = ensure(owner);
    if (t.unitAnchor) g.anchors.add(t.unitAnchor);
    const linked = t.atlasId != null && (t.linkState === "linked" || t.linkState === "user");
    const item = {
      termId: t.id,
      surface: t.surface,
      atlasId: linked ? "Q" + t.atlasId : null,
      label: (linked && labels.get("Q" + t.atlasId)) || t.surface,
      role: t.role,
      quote: t.quote,
      linkState: t.linkState
    };
    (TP.isTeach(t.role) ? g.taught : g.used).push(item);
  }
  // 低密度：只有该文档存在 low_density 覆盖行时才需要为没有术语的节点解析单元锚
  const lowUnits = new Set(
    db.queryAll("SELECT unit_anchor AS a FROM source_term_coverage WHERE document_id = ? AND status = 'low_density'", [documentId]).map((r) => r.a)
  );
  const engineAnchor = (n) => {
    if (!h.engine || typeof h.engine.graphNodeText !== "function") return null;
    try {
      const r = h.engine.graphNodeText({ mapId: String(mapId), nodeId: String(n.nodeId) });
      return r && r.unitAnchor ? String(r.unitAnchor) : null;
    } catch {
      return null;
    }
  };
  const termAnchorIn = (n) => {
    for (const t of terms) if (t.unitAnchor && t.blockNo >= n.blockStart && t.blockNo <= n.blockEnd) return t.unitAnchor;
    return null;
  };
  const wanted = new Map(byNode);
  if (lowUnits.size) {
    for (const n of nodes) {
      if (n.blockStart == null || n.blockEnd == null || wanted.has(n.nodeId)) continue;
      wanted.set(n.nodeId, { node: n, taught: [], used: [], anchors: new Set(), probe: true });
    }
  }
  const out = [];
  for (const g of wanted.values()) {
    const n = g.node;
    let unitAnchor = null;
    if (n.blockStart != null && n.blockEnd != null) unitAnchor = engineAnchor(n) || (g.anchors.size ? [...g.anchors][0] : termAnchorIn(n));
    const lowDensity = unitAnchor != null && lowUnits.has(unitAnchor);
    if (!g.taught.length && !g.used.length && !lowDensity) continue;
    out.push({ nodeId: n.nodeId, unitAnchor, lowDensity, taught: g.taught, used: g.used, _s: n.blockStart ?? 0 });
  }
  out.sort((x, y) => x._s - y._s || (x.nodeId < y.nodeId ? -1 : 1));
  for (const o of out) delete o._s;
  return { documentId, nodes: out };
}

/** 全谱节点出现在哪些材料：讲 / 用到两组（各 ≤50），带引句、材料、块号、节点路径、是否读过（unit_reads） */
function termAppearances(h, atlasId) {
  const db = h.db;
  const n = atlasInt(atlasId);
  const empty = { taught: [], used: [] };
  if (n == null) return empty;
  const rows = dropStale(h.engine, db.queryAll(
    `SELECT t.id, t.document_id AS documentId, t.unit_anchor AS unitAnchor, t.block_no AS blockNo, t.block_hash AS blockHash, t.quote, t.role,
            EXISTS (SELECT 1 FROM unit_reads u WHERE u.document_id = t.document_id AND u.unit_anchor = t.unit_anchor) AS isRead
       FROM source_terms t
      WHERE t.atlas_id = ? AND t.link_state IN ${LINKED} AND t.is_deleted = 0 AND t.role != 'work' AND t.block_no >= 0
      ORDER BY isRead DESC, t.document_id, t.block_no, t.id LIMIT 2000`,
    [n]
  ));
  if (!rows.length) return empty;
  const docIds = [...new Set(rows.map((r) => r.documentId))];
  const ph = docIds.map(() => "?").join(",");
  const titles = new Map(
    db.queryAll(`SELECT d.id AS id, li.title AS title FROM documents d JOIN library_items li ON li.id = d.library_item_id WHERE d.id IN (${ph})`, docIds).map((r) => [r.id, r.title])
  );
  const idxByDoc = new Map();
  const nodesById = new Map(); // `${mapId}\0${nodeId}` → node
  for (const docId of docIds) {
    const maps = db.queryAll("SELECT id FROM material_maps WHERE document_id = ? AND is_active = 1 AND is_deleted = 0", [docId]);
    const all = [];
    for (const m of maps) for (const nd of nodeRows(db, m.id)) all.push(nd);
    const withD = TP.withDepths(all);
    for (const nd of withD) nodesById.set(`${nd.mapId}\u0000${nd.nodeId}`, nd);
    idxByDoc.set(docId, TP.buildIndex(withD.filter(notToc)));
  }
  const pathOf = (nd) => {
    const out = [];
    let cur = nd;
    const seen = new Set();
    while (cur && !seen.has(cur.nodeId)) {
      seen.add(cur.nodeId);
      out.unshift(cur.title);
      cur = cur.parentId == null ? null : nodesById.get(`${cur.mapId}\u0000${cur.parentId}`);
    }
    return out;
  };
  const taught = [];
  const used = [];
  const seen = new Set();
  for (const r of rows) {
    const bucket = TP.isTeach(r.role) ? taught : used;
    if (bucket.length >= CAP) continue;
    const dk = `${bucket === taught ? "t" : "u"}|${r.documentId}|${r.blockNo}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const owner = TP.ownersOf(idxByDoc.get(r.documentId), r.documentId, r.blockNo)[0] || null;
    bucket.push({
      documentId: r.documentId,
      title: titles.get(r.documentId) || "",
      blockNo: r.blockNo,
      quote: r.quote,
      role: r.role,
      nodePath: owner ? pathOf(owner) : [],
      mapId: owner ? owner.mapId : null,
      nodeId: owner ? owner.nodeId : null,
      read: Number(r.isRead) === 1
    });
  }
  return { taught, used };
}

function docOfTerm(db, termId) {
  const r = db.queryAll("SELECT id, document_id AS documentId FROM source_terms WHERE id = ?", [String(termId)])[0];
  return r || null;
}
function changed(h, documentId) {
  try {
    if (h.broadcast) h.broadcast({ documentId });
  } catch {
    /* 通知失败不影响落账 */
  }
}

/** 用户拒绝一条术语：软删（落账者不复活同自然键的已删行） */
function sourceTermReject(h, termId, now) {
  const row = docOfTerm(h.db, termId);
  if (!row) return { ok: false };
  const ts = Number.isFinite(now) ? now : Date.now();
  h.db.run("UPDATE source_terms SET is_deleted = 1, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [ts, row.id]);
  changed(h, row.documentId);
  return { ok: true, documentId: row.documentId };
}

/** 用户手动对照：atlasId → link_state 'user'；null → 'unlinked'（atlas_id 清空） */
function sourceTermLink(h, termId, atlasId, now) {
  const row = docOfTerm(h.db, termId);
  if (!row) return { ok: false };
  const ts = Number.isFinite(now) ? now : Date.now();
  const n = atlasId == null ? null : atlasInt(atlasId);
  if (atlasId != null && n == null) return { ok: false };
  if (n == null) {
    h.db.run("UPDATE source_terms SET atlas_id = NULL, atlas_rel = NULL, link_state = 'unlinked', updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [ts, row.id]);
  } else {
    h.db.run("UPDATE source_terms SET atlas_id = ?, atlas_rel = 'same', link_state = 'user', updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [n, ts, row.id]);
  }
  changed(h, row.documentId);
  return { ok: true, documentId: row.documentId, linkState: n == null ? "unlinked" : "user" };
}

/** 作品 / 作者候选（无 AI 也可用）+ 已确认的作品级挂靠行 */
async function workAnchor(h, documentId) {
  const doc = h.db.queryAll(
    "SELECT d.id AS id, li.title AS title, li.author AS author FROM documents d JOIN library_items li ON li.id = d.library_item_id WHERE d.id = ?",
    [String(documentId)]
  )[0];
  if (!doc) return { documentId: String(documentId), title: "", author: "", works: [], persons: [], confirmed: [] };
  const prop = await ST.proposeWorkAnchors({ atlas: h.atlas, title: doc.title, author: doc.author });
  const confirmed = h.db
    .queryAll(
      "SELECT surface, atlas_id AS atlasId, link_state AS linkState FROM source_terms WHERE document_id = ? AND role = 'work' AND block_no = -1 AND is_deleted = 0",
      [doc.id]
    )
    .map((r) => ({ surface: r.surface, atlasId: r.atlasId == null ? null : "Q" + r.atlasId, linkState: r.linkState }));
  return { documentId: doc.id, title: doc.title || "", author: doc.author || "", works: prop.works, persons: prop.persons, confirmed };
}

function workAnchorConfirm(h, documentId, atlasId, surface, now) {
  const r = ST.confirmWorkAnchor({ db: h.db, documentId: String(documentId), atlasId, surface, now });
  changed(h, String(documentId));
  return { ok: true, ...r };
}

module.exports = { dropStale, sourceTermsForMap, termAppearances, sourceTermReject, sourceTermLink, workAnchor, workAnchorConfirm };
