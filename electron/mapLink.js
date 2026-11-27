"use strict";
// v49.146 / D314：导图节点 ↔ 全谱挂靠（主进程，纯逻辑 + db 读写）。
// 流程（D314 修订 起由主进程 mapLinkAuto.js 自动驱动）：buildBatch（本地全谱召回候选）→ AI 只看节点标题封闭选择
//   （另可给 ≤3 个标准条目名 more，逐个经 atlas.searchAsync 精确解析，编号永远来自全谱）→ applyReplyAsync。
// 进度（可续跑，按节点＋标题）：app_meta `mapLink:prog:<mapId>` = {nodeId: titleHash}（旧版数组读作 {id:null}＝不重跑）；
//   pending ＝ 活节点、标题非空，且不在进度里或指纹与当前标题不符。只在必要时调 AI：新节点 / 标题改了。
// 标题改了 → 旧 ai / match 挂靠记 source='stale'（软删）；同文档别的导图版本里同标题节点的挂靠零 AI 复用；
//   `mapLink:match:<mapId>` = {nodeId: titleHash} 记录 matchOnly 已查过的节点（重启不重复在线查名）。
// 软删行（用户拒绝）永不被 ai / match 复活（仅 source='stale' 的软删行可被复活）；`mapLink:done:` 不再参与判定。
const crypto = require("crypto");

let _db = null;
function H() {
  if (!_db) _db = require("./db")._mapLinkDb();
  return _db;
}
const atlas = () => require("./atlas");

const MAX_CANDS = 12;
const MAX_PICK = 8; // 每节点挂靠上限（pick + more 合计）
const MAX_MORE = 3;
const DEFAULT_CONF = 0.7;
const atlasInt = (v) => {
  const s = String(v == null ? "" : v);
  const n = Number(s[0] === "Q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
const doneKey = (m) => `mapLink:done:${m}`;
const progKey = (m) => `mapLink:prog:${m}`;
const matchKey = (m) => `mapLink:match:${m}`;
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
/** 标题指纹：trim 后 sha1 前 12 位十六进制（节点标题变了 → 指纹变 → 重新挂靠） */
const thash = (title) => crypto.createHash("sha1").update(String(title == null ? "" : title).trim()).digest("hex").slice(0, 12);
/** 读 {nodeId: titleHash|null}；旧版数组格式读成 {id: null}（null＝匹配当前任何标题，不重跑） */
function readMap(key) {
  const v = parse(H().readAppMeta(key), null);
  const out = {};
  if (Array.isArray(v)) for (const id of v) out[String(id)] = null;
  else if (v && typeof v === "object") for (const [id, h] of Object.entries(v)) out[id] = typeof h === "string" ? h : null;
  return out;
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** 节点已处理 ＝ 在进度里，且指纹为 null（旧版）或等于当前指纹 */
const isSettled = (prog, id, h) => has(prog, id) && (prog[id] === null || prog[id] === h);
/** 标题改过（进度里有旧指纹）且本标题还没被 matchOnly 处理过 → 旧的 ai / match 挂靠需要作废 */
const needsStale = (prog, memo, id, h) => has(prog, id) && prog[id] !== null && prog[id] !== h && memo[id] !== h;
function staleNode(run, mapId, nodeId, now) {
  run(
    "UPDATE material_map_node_refs SET is_deleted = 1, source = 'stale', updated_at = ?, sync_version = sync_version + 1 WHERE map_id = ? AND node_id = ? AND is_deleted = 0 AND source IN ('ai','match')",
    [now, String(mapId), String(nodeId)]
  );
}

// D315：已挂靠的全谱节点写快照（用户库缓存；必须在事务之外调用，失败静默）
function snapshotIds(ids) {
  try {
    void require("./atlasSnapshot").ensureAsync(ids).catch(() => {});
  } catch { /* ignore */ }
}
function snapshotMap(mapId) {
  try {
    snapshotIds(H().queryAll("SELECT DISTINCT atlas_id AS a FROM material_map_node_refs WHERE map_id = ? AND is_deleted = 0", [String(mapId)]).map((r) => r.a));
  } catch { /* ignore */ }
}

function liveNodes(mapId) {
  return H().queryAll(
    "SELECT node_id, parent_id, title FROM material_map_nodes WHERE map_id = ? AND is_deleted = 0 ORDER BY rowid",
    [String(mapId)]
  );
}

/** 活动导图中还有未处理节点的：[{mapId, documentId, title, nodeCount, pendingNodes}]（按节点，新增节点会让已跑完的图重新 pending） */
function pendingMaps() {
  const { queryAll } = H();
  const maps = queryAll(
    "SELECT m.id, m.document_id, m.title FROM material_maps m WHERE m.is_active = 1 AND m.is_deleted = 0 ORDER BY m.created_at DESC, m.rowid DESC"
  );
  const out = [];
  for (const m of maps) {
    const nodes = liveNodes(m.id).filter((n) => String(n.title || "").trim());
    if (!nodes.length) continue;
    const prog = readMap(progKey(m.id));
    const left = nodes.filter((n) => !isSettled(prog, n.node_id, thash(n.title))).length;
    if (!left) continue;
    out.push({ mapId: m.id, documentId: m.document_id, title: m.title, nodeCount: nodes.length, pendingNodes: left });
  }
  return out;
}

function labelOf(n) {
  return n.zh || n.zht || n.en || n.ja || n.id;
}

/**
 * 取一批未处理节点（按出现顺序，≤limit 个）。空标题的节点直接记为已处理；
 * 本地没有候选的节点也照样发给 AI（只给标题，AI 可用 more 给标准条目名走全谱名称查找——核心库不是全谱）。
 * 返回 {user, keys, state, remaining}；keys 为空 = 没有可发给 AI 的节点。
 */
function buildBatch(mapId, opts = {}) {
  const limit = Math.max(1, Math.min(60, Number(opts.limit) || 20));
  const reused = reuseOnly(mapId).reused; // 零 AI：先复用同文档别的导图版本里同标题节点的挂靠，并清掉空标题
  const nodes = liveNodes(mapId);
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const prog = readMap(progKey(mapId));
  const memo = readMap(matchKey(mapId));
  const lines = [];
  const keys = [];
  const cands = {}; // key -> [atlasId int…]（按展示编号 1..n 的顺序；可为空）
  const keyNode = {};
  const titleHash = {};
  const staleIds = [];
  let taken = 0;
  let remaining = 0;
  const A = atlas();
  const nm = (s) => {
    try {
      return A.norm(s);
    } catch {
      return String(s || "").toLowerCase();
    }
  };
  for (const n of nodes) {
    const title = String(n.title || "").trim();
    const h = thash(title);
    if (!title || isSettled(prog, n.node_id, h)) continue;
    if (taken >= limit) {
      remaining++;
      continue;
    }
    if (needsStale(prog, memo, n.node_id, h)) staleIds.push(n.node_id);
    const parent = n.parent_id ? byId.get(n.parent_id) : null;
    let found = [];
    try {
      // 候选只按节点标题召回（上级只用于消歧展示，不参与召回）
      found = A.candidates(title, { limit: MAX_CANDS }) || [];
    } catch {
      found = [];
    }
    found = trimCands(found.filter((c) => atlasInt(c.id)), nm(title), nm).slice(0, MAX_CANDS);
    taken++;
    const key = String(taken);
    keys.push(key);
    keyNode[key] = n.node_id;
    titleHash[n.node_id] = h;
    cands[key] = found.map((c) => atlasInt(c.id));
    const pt = parent ? String(parent.title || "").trim() : "";
    lines.push(`k=${key} 标题：${title}${pt ? `｜上级：${pt}` : ""}`);
    if (!found.length) lines.push("  （本地无候选）");
    const labelCount = new Map();
    for (const c of found) labelCount.set(labelOf(c), (labelCount.get(labelOf(c)) || 0) + 1);
    found.forEach((c, i) => {
      const dup = labelCount.get(labelOf(c)) > 1;
      const en = dup && c.en && c.en !== labelOf(c) ? `（${c.en}）` : "";
      lines.push(`  ${i + 1}. ${labelOf(c)}${en}${c.gloss ? ` — ${String(c.gloss).slice(0, 20)}` : ""}`);
    });
  }
  if (staleIds.length) {
    const { run, withTransaction } = H();
    const now = Date.now();
    withTransaction(() => {
      for (const id of staleIds) staleNode(run, mapId, id, now);
    });
  }
  return {
    user: lines.join("\n"),
    keys,
    remaining,
    reused,
    // 候选表留在主进程，渲染层只拿令牌：封闭选择的校验不依赖回传的候选
    state: stash({ mapId: String(mapId), cands, keyNode, titleHash })
  };
}

/** 候选瘦身（省 token）：标题里根本没出现的名称丢掉；被同表更长候选名包含的「≤2 个 CJK 字 / 单个拉丁词」短名丢掉 */
function trimCands(list, normTitle, nm) {
  const names = (c) => [c.zh, c.zht, c.en, c.ja].filter(Boolean).map(nm);
  const kept = list.filter((c) => names(c).some((x) => x && normTitle.includes(x)));
  const labels = kept.map((c) => nm(labelOf(c)));
  return kept.filter((c, i) => {
    const l = labels[i];
    const short = CJK.test(l) ? [...l].length <= 2 : !/\s/.test(String(labelOf(c)).trim());
    if (!short) return true;
    return !labels.some((o, j) => j !== i && o.length > l.length && o.includes(l));
  });
}

/**
 * 零 AI 的进度结算：空标题记为已处理；同文档别的导图（任何版本，未删）里同标题（trim 后相同）且已按同指纹（或旧版 null）处理过的节点，
 * 把它的挂靠复制过来（活行带 source / 置信度；用户移除的行以软删复制，拒绝随之延续；跳过 stale），本节点记为已处理。
 */
function reuseOnly(mapId) {
  const { run, queryAll, withTransaction } = H();
  const mid = String(mapId);
  const nodes = liveNodes(mid);
  const prog = readMap(progKey(mid));
  const memo = readMap(matchKey(mid));
  const pend = nodes.filter((n) => String(n.title || "").trim() && !isSettled(prog, n.node_id, thash(n.title)));
  const blanks = nodes.filter((n) => !String(n.title || "").trim() && !has(prog, n.node_id));
  let reused = 0;
  let dirty = false;
  const doc = pend.length ? (queryAll("SELECT document_id FROM material_maps WHERE id = ?", [mid])[0] || {}).document_id : null;
  const others = doc
    ? queryAll("SELECT id FROM material_maps WHERE document_id = ? AND id <> ? AND is_deleted = 0 ORDER BY updated_at DESC, rowid DESC", [doc, mid]).map((r) => r.id)
    : [];
  const progOf = new Map();
  const now = Date.now();
  withTransaction(() => {
    for (const n of blanks) {
      prog[n.node_id] = thash("");
      dirty = true;
    }
    for (const n of pend) {
      const title = String(n.title || "").trim();
      const h = thash(title);
      let src = null;
      for (const om of others) {
        if (!progOf.has(om)) progOf.set(om, readMap(progKey(om)));
        const op = progOf.get(om);
        const cand = queryAll("SELECT node_id FROM material_map_nodes WHERE map_id = ? AND is_deleted = 0 AND trim(title) = ? ORDER BY rowid", [om, title]).find((r) => isSettled(op, r.node_id, h));
        if (cand) {
          src = { mapId: om, nodeId: cand.node_id };
          break;
        }
      }
      if (!src) continue;
      if (needsStale(prog, memo, n.node_id, h)) staleNode(run, mid, n.node_id, now);
      const refs = queryAll(
        "SELECT atlas_id, source, confidence, is_deleted FROM material_map_node_refs WHERE map_id = ? AND node_id = ? AND source <> 'stale' ORDER BY rowid",
        [src.mapId, src.nodeId]
      );
      for (const r of refs) insertRef(run, mid, n.node_id, r.atlas_id, r.source, r.confidence, now, r.is_deleted ? 1 : 0);
      prog[n.node_id] = h;
      dirty = true;
      reused++;
    }
    if (dirty) H().writeAppMeta(progKey(mid), JSON.stringify(prog));
  });
  if (reused) snapshotMap(mid);
  return { reused };
}


const pending = new Map();
function stash(st) {
  const token = crypto.randomUUID();
  pending.set(token, st);
  if (pending.size > 200) pending.delete(pending.keys().next().value);
  return token;
}

function insertRef(run, mapId, nodeId, atlasId, source, conf, now, deleted = 0) {
  // 唯一索引 (map_id,node_id,atlas_id)：已有行（含软删＝用户拒绝）一律占位不覆盖；只有 source='stale' 的软删行可被复活
  const ex = H().queryAll(
    "SELECT id, is_deleted, source FROM material_map_node_refs WHERE map_id = ? AND node_id = ? AND atlas_id = ?",
    [mapId, nodeId, atlasId]
  );
  if (ex.length) {
    if (ex[0].is_deleted === 1 && ex[0].source === "stale") {
      run(
        "UPDATE material_map_node_refs SET is_deleted = ?, source = ?, confidence = ?, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?",
        [deleted, source, conf, now, ex[0].id]
      );
    }
    return;
  }
  run(
    `INSERT OR IGNORE INTO material_map_node_refs
       (id, user_id, map_id, node_id, atlas_id, source, confidence, created_at, updated_at, sync_version, is_deleted)
     VALUES (?, 'local-user', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [crypto.randomUUID(), mapId, nodeId, atlasId, source, conf, now, now, deleted]
  );
}

function resolveState(token) {
  // 主进程内调用（测试）可直接传状态对象；IPC 一律传令牌
  const state = token && typeof token === "object" ? token : pending.get(String(token));
  if (!state) throw new Error("mapLink: unknown or expired batch");
  return state;
}

function parseItems(raw) {
  const t = String(raw || "");
  let j;
  try {
    j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    throw new Error("mapLink: AI reply is not valid JSON");
  }
  return Array.isArray(j && j.items) ? j.items : [];
}

/** items → Map<nodeId, {ids:[atlasInt], conf, more:[name]}>（只认候选内编号；pick 与 more 合计 ≤MAX_PICK） */
function collectPicks(state, items) {
  const out = new Map();
  for (const it of items) {
    const key = String(it && it.k);
    const list = state.cands[key];
    const nodeId = state.keyNode[key];
    if (!list || !nodeId) continue;
    const conf = Number.isFinite(Number(it.confidence)) ? Math.max(0, Math.min(1, Number(it.confidence))) : DEFAULT_CONF;
    const ids = [];
    for (const p of Array.isArray(it.pick) ? it.pick : []) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 1 || idx > list.length) continue;
      const aid = list[idx - 1];
      if (!ids.includes(aid)) ids.push(aid);
      if (ids.length >= MAX_PICK) break;
    }
    const more = [];
    for (const m of Array.isArray(it.more) ? it.more : []) {
      const name = String(m == null ? "" : m).trim();
      if (name && name.length <= 120 && !more.includes(name)) more.push(name);
      if (more.length >= MAX_MORE) break;
    }
    out.set(nodeId, { ids, conf, more });
  }
  return out;
}

/** 单个条目名 → 全谱编号：只认 exact===true 且恰好一个（重定向落到同一节点算一个）；否则 null。编号来自全谱，不来自 AI。 */
async function resolveName(name) {
  let r = [];
  try {
    r = (await atlas().searchAsync(name, { limit: 10 })) || [];
  } catch {
    return null;
  }
  const ids = [...new Set(r.filter((x) => x.exact).map((x) => atlasInt(x.id)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

function commitPicks(state, picks) {
  const { writeAppMeta, run, withTransaction } = H();
  const now = Date.now();
  let added = 0;
  withTransaction(() => {
    const q = () => H().queryAll("SELECT COUNT(*) AS n FROM material_map_node_refs WHERE map_id = ? AND is_deleted = 0", [state.mapId])[0].n;
    const before = q();
    for (const [nodeId, p] of picks) for (const aid of p.ids) insertRef(run, state.mapId, nodeId, aid, "ai", p.conf, now);
    added = q() - before;
    const prog = readMap(progKey(state.mapId));
    const cur = new Map(liveNodes(state.mapId).map((n) => [n.node_id, n.title]));
    for (const nid of Object.values(state.keyNode)) prog[nid] = (state.titleHash && state.titleHash[nid]) || thash(cur.get(nid));
    writeAppMeta(progKey(state.mapId), JSON.stringify(prog));
  });
  snapshotMap(state.mapId); // D315：事务提交后补节点快照（缓存，失败静默）
  return { added, nodes: Object.keys(state.keyNode).length };
}

/**
 * 同步路径：只处理 pick（封闭选择，序号 1 起，只认该节点候选内；每节点 ≤8；写 source='ai'）；忽略 more。
 * 解析失败抛错且不标记进度（可重试）；成功后本批所有节点记为已处理（AI 漏掉的也算，避免死循环）。
 */
function applyReply(token, raw) {
  const state = resolveState(token);
  return commitPicks(state, collectPicks(state, parseItems(raw)));
}

/** 异步路径：pick + more（more 逐个经 searchAsync 精确解析，只认唯一 exact；总数仍 ≤8） */
async function applyReplyAsync(token, raw) {
  const state = resolveState(token);
  const picks = collectPicks(state, parseItems(raw));
  for (const p of picks.values()) {
    for (const name of p.more) {
      if (p.ids.length >= MAX_PICK) break;
      const aid = await resolveName(name);
      if (aid && !p.ids.includes(aid)) p.ids.push(aid);
    }
  }
  return commitPicks(state, picks);
}

function markDone(mapId) {
  const { writeAppMeta, withTransaction } = H();
  const n = liveNodes(mapId).length;
  withTransaction(() => {
    writeAppMeta(doneKey(mapId), JSON.stringify({ t: Date.now(), nodes: n }));
  });
  return true;
}

/** 无 AI 时的保底：节点标题与全谱名称精确相等且唯一（本地没有时经 searchAsync 查在线）→ source='match'。不动进度（之后仍可跑 AI）。 */
async function matchOnly(mapId) {
  const { run, writeAppMeta, withTransaction } = H();
  const A = atlas();
  const mid = String(mapId);
  const now = Date.now();
  let added = 0;
  const prog = readMap(progKey(mid));
  const memo = readMap(matchKey(mid));
  const hits = [];
  const stale = [];
  const tried = {};
  for (const n of liveNodes(mid)) {
    const title = String(n.title || "").trim();
    if (!title) continue;
    const h = thash(title);
    if (isSettled(prog, n.node_id, h) || memo[n.node_id] === h) continue; // 已处理 / 已查过：不重复
    let r = [];
    let ok = true;
    try {
      r = (await A.searchAsync(title, { limit: 5 })) || [];
    } catch {
      r = [];
      ok = false; // 查询失败不记备忘，下次再试
    }
    if (needsStale(prog, memo, n.node_id, h)) stale.push(n.node_id);
    if (ok) tried[n.node_id] = h;
    const ex = [...new Set(r.filter((x) => x.exact).map((x) => atlasInt(x.id)).filter(Boolean))];
    if (ex.length === 1) hits.push([n.node_id, ex[0]]);
  }
  if (hits.length || stale.length || Object.keys(tried).length) {
    withTransaction(() => {
      const q = () => H().queryAll("SELECT COUNT(*) AS n FROM material_map_node_refs WHERE map_id = ? AND is_deleted = 0", [mid])[0].n;
      for (const id of stale) staleNode(run, mid, id, now);
      const before = q();
      for (const [nid, aid] of hits) insertRef(run, mid, nid, aid, "match", 1, now);
      added = q() - before;
      if (Object.keys(tried).length) writeAppMeta(matchKey(mid), JSON.stringify({ ...readMap(matchKey(mid)), ...tried }));
    });
    if (hits.length) snapshotIds(hits.map((h) => h[1]));
  }
  return { added };
}

function refsForMap(mapId) {
  const rows = H().queryAll(
    // v49.170 / D340：ai / match 来源的挂靠已停用（改由原文术语 source_terms 提供），读取处隐藏、不删；user 照常
    "SELECT node_id, atlas_id, source, confidence FROM material_map_node_refs WHERE map_id = ? AND is_deleted = 0 AND source NOT IN ('ai','match') ORDER BY rowid",
    [String(mapId)]
  );
  const names = new Map();
  try {
    for (const n of atlas().getNodes(rows.map((r) => r.atlas_id))) names.set(n.id, labelOf(n));
  } catch { /* 全谱不可用：只给编号 */ }
  return rows.map((r) => ({
    nodeId: r.node_id,
    atlasId: "Q" + r.atlas_id,
    label: names.get("Q" + r.atlas_id) || null,
    source: r.source,
    confidence: r.confidence
  }));
}

/** 全谱编号 → 出现在哪些（活动）导图的哪些节点 */
function refsForAtlas(atlasIds) {
  const ids = [...new Set((Array.isArray(atlasIds) ? atlasIds : []).map(atlasInt).filter(Boolean))];
  if (!ids.length) return [];
  const rows = H().queryAll(
    `SELECT r.atlas_id, r.map_id, r.node_id, r.source, m.document_id, m.title AS map_title
       FROM material_map_node_refs r JOIN material_maps m ON m.id = r.map_id
      WHERE r.is_deleted = 0 AND m.is_deleted = 0 AND r.atlas_id IN (${ids.map(() => "?").join(",")})
      ORDER BY r.rowid`,
    ids
  );
  return rows.map((r) => ({
    atlasId: "Q" + r.atlas_id,
    mapId: r.map_id,
    nodeId: r.node_id,
    source: r.source,
    documentId: r.document_id,
    mapTitle: r.map_title
  }));
}

/** 用户手动挂 / 取消。on=true 可复活软删行（source 记为 user）；on=false 软删（保留行＝已拒绝）。 */
function setUserRef(mapId, nodeId, atlasId, on) {
  const aid = atlasInt(atlasId);
  if (!aid) throw new Error("mapLink: bad atlas id");
  const { run, queryAll, withTransaction } = H();
  const now = Date.now();
  withTransaction(() => {
    const ex = queryAll(
      "SELECT id FROM material_map_node_refs WHERE map_id = ? AND node_id = ? AND atlas_id = ?",
      [String(mapId), String(nodeId), aid]
    );
    if (on) {
      if (ex.length) {
        run("UPDATE material_map_node_refs SET is_deleted = 0, source = 'user', confidence = NULL, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [now, ex[0].id]);
      } else {
        insertRef(run, String(mapId), String(nodeId), aid, "user", null, now);
      }
    } else if (ex.length) {
      run("UPDATE material_map_node_refs SET is_deleted = 1, updated_at = ?, sync_version = sync_version + 1 WHERE id = ?", [now, ex[0].id]);
    }
  });
  if (on) snapshotIds([aid]);
  return true;
}

module.exports = { pendingMaps, buildBatch, reuseOnly, applyReply, applyReplyAsync, markDone, matchOnly, refsForMap, refsForAtlas, setUserRef, _peek: (t) => pending.get(String(t)) };
