// v49.143 / D311 知识全谱（Knowledge Atlas）只读访问层（设计 docs/design/KG-KNOWLEDGE-ATLAS.md §5–§8）。
// 全谱是构建期生成、冻结、可审计的参考数据（scripts/atlas/ 构建），独立只读 SQLite 文件：
//   不进备份、不参与同步、不受「每次落库即落盘」约束（只读）；缺失时一切全谱功能静默降级。
// D315 多源：完整库（NUT_ATLAS_PATH > userData/atlas/atlas.sqlite（下载）> resources/atlas/atlas.sqlite > 开发目录）
//   → 无完整库时用核心库（NUT_ATLAS_CORE_PATH > resources/atlas/atlas-core.sqlite > 开发目录 atlas-core.sqlite，同 schema）；
//   getNodes 查不到再回落用户库快照（atlasSnapshot.js），异步变体再试在线分片（atlasOnline.js）。
// D323：节点的关系只来自对它完整的来源（完整库 → 本地分片缓存 → 在线边分片），统一经 edgesOf / edgesOfMany 取边；核心库边表只作降级。
"use strict";
const fs = require("fs");
const path = require("path");

let db = null;
let dbPath = null;
let dbSource = "none"; // full | core | none
let openErr = null;

function userDataDir() {
  try {
    const { app } = require("electron");
    return app && typeof app.getPath === "function" ? app.getPath("userData") : null;
  } catch {
    return null;
  }
}

/** 完整库候选：NUT_ATLAS_PATH（独占）> userData/atlas/atlas.sqlite（下载）> 打包资源 > 开发目录 */
function fullPaths() {
  // 显式指定时只认这一个路径（不回退；测试与诊断依赖这一点）
  if (process.env.NUT_ATLAS_PATH) return [process.env.NUT_ATLAS_PATH];
  const out = [];
  const ud = userDataDir();
  if (ud) out.push(path.join(ud, "atlas", "atlas.sqlite"));
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "atlas", "atlas.sqlite"));
  out.push(path.join(__dirname, "..", "atlas", "atlas.sqlite"));
  return out;
}
/** 核心库候选（同 schema）：NUT_ATLAS_CORE_PATH（独占）> 打包资源 > 开发目录 */
function corePaths() {
  if (process.env.NUT_ATLAS_CORE_PATH) return [process.env.NUT_ATLAS_CORE_PATH];
  const out = [];
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, "atlas", "atlas-core.sqlite"));
  out.push(path.join(__dirname, "..", "atlas", "atlas-core.sqlite"));
  return out;
}
function candidatesPaths() {
  return fullPaths();
}

function tryOpen(list, source) {
  for (const p of list) {
    try {
      if (!fs.existsSync(p)) continue;
      const Database = require("better-sqlite3");
      db = new Database(p, { readonly: true, fileMustExist: true });
      db.pragma("query_only = ON");
      dbPath = p;
      dbSource = source;
      openErr = null;
      return true;
    } catch (e) {
      openErr = e;
    }
  }
  return false;
}

function open() {
  if (db) return db;
  if (openErr && !process.env.NUT_ATLAS_PATH && !process.env.NUT_ATLAS_CORE_PATH) return null;
  if (tryOpen(fullPaths(), "full") || tryOpen(corePaths(), "core")) return db;
  if (!openErr) openErr = new Error("atlas not found");
  dbSource = "none";
  return null;
}

/** 测试用：切换到指定全谱文件（或关闭）；不带参数＝按默认候选重新打开（下载完成后用） */
function _reset(p) {
  try {
    if (db) db.close();
  } catch {
    /* ignore */
  }
  db = null;
  dbPath = null;
  dbSource = "none";
  openErr = null;
  if (p !== undefined) process.env.NUT_ATLAS_PATH = p || "";
}

/** 与构建器 build_atlas.py 的 norm() 逐字一致（NFKC + 小写 + 去空白与常见标点） */
const NORM_RE = /[\s　·・\-_'"()（）[\]【】《》〈〉,，.。:：;；!！?？/]+/g;
function norm(s) {
  return String(s || "").normalize("NFKC").toLowerCase().replace(NORM_RE, "");
}

const KIND_LABEL = { concept: "概念", person: "人物", work: "作品", event: "事件", place: "地点", organization: "组织", taxon: "物种与类群", artifact: "人造物" };
const TYPE_LAYER = { b: "skeleton", p: "skeleton", c: "skeleton", a: "skeleton", e: "context", u: "context", r: "context" };

function status() {
  let online = { enabled: false, url: "" };
  try {
    online = require("./atlasOnline").config();
  } catch {
    /* ignore */
  }
  let onlineReady = false;
  try {
    onlineReady = require("./atlasOnline").ready_();
  } catch {
    /* ignore */
  }
  const d = open();
  if (!d) return { available: false, reason: openErr ? String(openErr.message || openErr) : "missing", source: "none", core: false, complete: false, onlineReady, nodes: null, online };
  const meta = Object.fromEntries(d.prepare("SELECT k, v FROM meta").all().map((r) => [r.k, r.v]));
  const stats = meta.stats ? JSON.parse(meta.stats) : null;
  let nodes = Number(meta.core_nodes) || null;
  if (!nodes && stats) nodes = Object.entries(stats).reduce((n, [k, v]) => (k !== "edges" && typeof v === "number" ? n + v : n), 0) || null;
  return { available: true, path: dbPath, builtAt: Number(meta.built_at) || null, schema: meta.schema || null, stats, source: dbSource, core: dbSource === "core" || meta.core === "1", complete: dbSource === "full", onlineReady, nodes, online };
}

const NODE_COLS = "id, kind, field, topic, parent, rank, zh, zht, en, ja, mt, gloss_zh, gloss_en, y0, y1, redirect";

// v49.149 / D318：全谱 schema 2 的新列 / 新表按「存在与否」探测（旧库照常可用，新字段返回 null）——
//   name.t（命中方式：L＝标签；syn/trans/narrow/broad/rel/split/noise＝已分类别名；NULL＝未分类别名）、
//   alias(node, lang, text, norm, type, gloss)（译名分化义项说明）、node.def_zh / def_en（属加种差标准定义）。
const capsCache = new WeakMap();
function caps(d) {
  let c = capsCache.get(d);
  if (c) return c;
  const has = (t, col) => {
    try {
      return d.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === col);
    } catch {
      return false;
    }
  };
  c = { nameT: has("name", "t"), alias: has("alias", "gloss"), def: has("node", "def_zh") };
  capsCache.set(d, c);
  return c;
}
const nodeCols = (d) => (caps(d).def ? NODE_COLS + ", def_zh, def_en" : NODE_COLS);
const T_MAP = { L: "label", syn: "syn", trans: "trans", narrow: "narrow", broad: "broad", rel: "rel", split: "split", noise: "noise" };
/** 名称表 t 值 → 命中方式；无 t 时按「是否等于节点的某个标签」判 label / alias（未分类） */
function matchTypeOf(t, nodeObj, k) {
  if (t && T_MAP[t]) return T_MAP[t];
  if (nodeObj && [nodeObj.zh, nodeObj.zht, nodeObj.en, nodeObj.ja].some((x) => x && norm(x) === k)) return "label";
  return "alias";
}
/** 本地库：某节点以规范化名称 k 命中时的命中方式与（译名分化时的）义项说明 */
function matchInfo(d, nodeObj, k) {
  const id = toInt(nodeObj && nodeObj.id);
  const c = caps(d);
  let t = null;
  if (c.nameT && id != null) {
    const r = d.prepare("SELECT t FROM name WHERE norm = ? AND node = ?").get(k, id);
    t = r ? r.t : null;
  }
  const type = matchTypeOf(t, nodeObj, k);
  let gloss = null;
  if (type === "split" && c.alias && id != null) {
    const g = d.prepare("SELECT gloss FROM alias WHERE node = ? AND norm = ? AND gloss IS NOT NULL LIMIT 1").get(id, k);
    gloss = g ? g.gloss : null;
  }
  return { type, gloss };
}

function rowToNode(r) {
  if (!r) return null;
  return {
    id: "Q" + r.id,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] || r.kind,
    zh: r.zh || null,
    zht: r.zht || null,
    en: r.en || null,
    ja: r.ja || null,
    machine: r.mt || 0,
    gloss: r.gloss_zh || null,
    glossEn: r.gloss_en || null,
    def: r.def_zh || null,
    defEn: r.def_en || null,
    years: r.y0 != null || r.y1 != null ? [r.y0 ?? null, r.y1 ?? null] : null,
    rank: r.rank,
    parentId: r.parent != null && r.parent > 0 ? "Q" + r.parent : null,
    topicId: r.topic != null && r.topic > 0 ? "Q" + r.topic : null,
    fieldId: r.field != null ? (r.field > 0 ? "Q" + r.field : String(r.field)) : null
  };
}
const toInt = (id) => {
  const s = String(id || "");
  const n = Number(s[0] === "Q" ? s.slice(1) : s);
  return Number.isInteger(n) ? n : null;
};

const snap = () => require("./atlasSnapshot");
const online = () => require("./atlasOnline");

/** 只查已打开的库（不含快照 / 在线）；返回 { nodes, found:Set<请求的整数编号> } */
function dbNodes(ints) {
  const d = open();
  const out = [];
  const found = new Set();
  if (!d) return { nodes: out, found };
  const st = d.prepare(`SELECT ${nodeCols(d)} FROM node WHERE id = ?`);
  for (const i of ints) {
    let r = st.get(i);
    if (r && r.redirect) r = st.get(r.redirect) || r;
    if (r) {
      out.push(rowToNode(r));
      found.add(i);
    }
  }
  return { nodes: out, found };
}
const uniqInts = (ids) => [...new Set(ids.map(toInt).filter((x) => x != null))];

function getNodesLocal(ids) {
  return dbNodes(uniqInts(ids)).nodes;
}

/** 全谱库 → 用户库快照（同步）。快照只是缓存，库里有的以库为准。 */
function getNodes(ids) {
  const ints = uniqInts(ids);
  const { nodes, found } = dbNodes(ints);
  const missing = ints.filter((i) => !found.has(i));
  if (!missing.length) return nodes;
  let extra = [];
  try {
    extra = snap().get(missing);
  } catch {
    extra = [];
  }
  return nodes.concat(extra);
}

/** getNodes + 在线分片（仍缺的编号；结果写在线缓存，不写快照） */
async function getNodesAsync(ids) {
  const ints = uniqInts(ids);
  const have = getNodes(ints);
  const haveSet = new Set(have.map((n) => toInt(n.id)));
  const still = ints.filter((i) => !haveSet.has(i));
  if (!still.length) return have;
  let extra = [];
  try {
    extra = await online().fetchNodes(still);
  } catch {
    extra = [];
  }
  return have.concat(extra.map(onlineRowToNode).filter(Boolean));
}
function onlineRowToNode(r) {
  return r ? rowToNode(r) : null;
}

function fieldLabel(fid) {
  const d = open();
  if (!d || fid == null) return null;
  const n = Number(String(fid).replace(/^Q/, ""));
  const f = d.prepare("SELECT f.id, f.en, f.pseudo, f.domain, dm.zh AS dzh FROM field f LEFT JOIN domain dm ON dm.id = f.domain WHERE f.id = ?").get(n);
  if (!f) return null;
  const node = f.id > 0 ? d.prepare("SELECT zh, en FROM node WHERE id = ?").get(f.id) : null;
  return { id: fid, label: f.pseudo ? f.en : (node && (node.zh || node.en)) || f.en, domain: f.dzh };
}

/** 节点详情：自身 + 主题链（向上至学科）。库里没有时回落快照（含当时存下的主题链） */
function nodeLocal(id) {
  const [n] = getNodesLocal([id]);
  if (!n) return null;
  const d = open();
  const chain = [];
  let cur = toInt(id);
  const st = d.prepare("SELECT id, parent, zh, en FROM node WHERE id = ?");
  for (let i = 0; i < 12; i++) {
    const r = st.get(cur);
    if (!r || r.parent == null || r.parent <= 0) break;
    const p = st.get(r.parent);
    if (!p) break;
    chain.push({ id: "Q" + p.id, label: p.zh || p.en });
    cur = p.id;
  }
  return { ...n, chain, field: fieldLabel(n.fieldId) };
}

function node(id) {
  const n = nodeLocal(id);
  if (n) return n;
  try {
    return snap().getDetail(id);
  } catch {
    return null;
  }
}

/** node() + 在线分片：本地全无时拉节点与其上级链（每级一次分片请求，已缓存的不再联网） */
async function nodeAsync(id) {
  const n = node(id);
  if (n) return n;
  const [x] = await getNodesAsync([id]);
  if (!x) return null;
  const chain = [];
  let cur = x;
  for (let i = 0; i < 12; i++) {
    const pid = cur.parentId;
    if (!pid) break;
    const [p] = await getNodesAsync([pid]);
    if (!p) break;
    chain.push({ id: p.id, label: p.zh || p.en });
    cur = p;
  }
  return { ...x, chain, field: null };
}

/**
 * 搜索：规范化名称的精确 + 前缀匹配（四语名称与别名都在 name 表里）。
 * 排序：完全相同优先，其次按重要度；同一节点只出现一次。
 */
function search(q, opts = {}) {
  const d = open();
  const k = norm(q);
  if (!d || !k) return [];
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  const exact = d.prepare("SELECT node, w FROM name WHERE norm = ? ORDER BY w DESC LIMIT ?").all(k, limit);
  const pref = d.prepare("SELECT node, max(w) AS w FROM name WHERE norm > ? AND norm < ? GROUP BY node ORDER BY w DESC LIMIT ?").all(k, k + "￿", limit * 2);
  const seen = new Set();
  const ids = [];
  const exactSet = new Set(exact.map((r) => r.node));
  for (const r of [...exact, ...pref]) {
    if (seen.has(r.node)) continue;
    seen.add(r.node);
    ids.push(r.node);
    if (ids.length >= limit) break;
  }
  const nodes = getNodes(ids);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return ids
    .map((i) => {
      const n = byId.get("Q" + i);
      if (!n) return null;
      if (!exactSet.has(i)) return { ...n, exact: false };
      const m = matchInfo(d, n, k);
      return { ...n, exact: true, matched: k, matchedType: m.type, matchedGloss: m.gloss };
    })
    .filter(Boolean)
    .filter((n) => !opts.kinds || opts.kinds.includes(n.kind));
}

/**
 * search + 在线精确名称查找（仅当前没有完整库、且在线已启用时）。请求只含名称哈希前缀；
 * 在线命中的节点排在本地「完全相同」命中之后、前缀命中之前。
 */
async function searchAsync(q, opts = {}) {
  const local = search(q, opts);
  open();
  if (dbSource === "full") return local;
  const k = norm(q);
  if (!k) return local;
  // 核心库不是全谱：本地没有「完全相同」命中就继续查在线（本地前缀命中不代表精确名称不存在）
  if (local.some((n) => n.exact)) return local;
  let hits = [];
  try {
    hits = await online().lookupName(k);
  } catch {
    hits = [];
  }
  if (!hits.length) return local;
  const have = new Set(local.map((n) => n.id));
  const ids = hits.map((h) => "Q" + h[0]).filter((i) => !have.has(i));
  const tById = new Map(hits.map((h) => ["Q" + h[0], h[2] || null]));
  const nodes = ids.length ? await getNodesAsync(ids) : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seenX = new Set();
  const extra = ids
    .map((i) => byId.get(i))
    .filter(Boolean)
    .filter((n) => !opts.kinds || opts.kinds.includes(n.kind))
    .filter((n) => (seenX.has(n.id) || have.has(n.id) ? false : (seenX.add(n.id), true))) // 重定向解析后可能落到同一节点
    .map((n) => ({ ...n, exact: true, remote: true, matched: k, matchedType: matchTypeOf(tById.get(n.id), n, k), matchedGloss: null }));
  const exact = local.filter((n) => n.exact);
  const rest = local.filter((n) => !n.exact);
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  return [...exact, ...extra, ...rest].slice(0, limit);
}

// ---- v49.154 / D323：关系读取按节点完整（设计 docs/design/KG-ATLAS-DELIVERY-ENRICH.md §3） ----
// 一个节点的关系列表只能来自对它完整的来源：完整库 → 本地分片缓存（atlas-cache/<version>/edge/…）→ 在线边分片（仅异步）。
// 随包核心库只保留两端都在核心集里的边（约 4%），它的边表不再算答案，只在没有完整来源时作降级显示并标 complete:false。
const SKEL_TYPES = ["b", "p", "c", "a"];
const CTX_TYPES = ["e", "u", "r"];
const WORLD_TYPES = [...SKEL_TYPES, ...CTX_TYPES];

/**
 * 取边入口（同步、零网络）：一批节点各自的完整关系。
 * 返回 Map<整数编号, { o:[[dst,type,pred,conf,source]], i:[[src,type,pred,conf,source]], source:"full"|"cache" } | null>；
 * null＝本地没有对该节点完整的来源（未下载完整库、边分片也未缓存）。
 * opts.dir：out | in | both（默认 both）；opts.types：只取这些边类型（完整库在 SQL 里过滤）。
 * opts.maxFiles：非完整库时最多从磁盘同步解压这么多个缓存边分片（记忆 / LRU 命中不计），超出的节点返回 null。
 */
function edgesOfMany(ids, opts = {}) {
  const ints = [...new Set((ids || []).map(toInt).filter((x) => x != null))];
  const out = new Map();
  if (!ints.length) return out;
  const dir = opts.dir || "both";
  const types = Array.isArray(opts.types) ? opts.types.filter((t) => TYPE_LAYER[t]) : null;
  const d = open();
  if (d && dbSource === "full") {
    const tf = types ? (types.length ? ` AND type IN (${types.map((t) => `'${t}'`).join(",")})` : " AND 0") : "";
    const so = d.prepare(`SELECT dst, type, pred, conf, source FROM edge WHERE src = ?${tf}`).raw();
    const si = d.prepare(`SELECT src, type, pred, conf, source FROM edge WHERE dst = ?${tf}`).raw();
    for (const n of ints) out.set(n, { o: dir === "in" ? [] : so.all(n), i: dir === "out" ? [] : si.all(n), source: "full" });
    return out;
  }
  let cached;
  try {
    cached = online().edgesCachedSync(ints, { maxFiles: opts.maxFiles });
  } catch {
    cached = new Map();
  }
  const keep = types ? (r) => types.includes(r[1]) : () => true;
  for (const n of ints) {
    const e = cached.get(n);
    // 无类型过滤时直接用（共享、只读）数组，不为枢纽节点的几十万条边做拷贝
    const pick = (a) => (types ? a.filter(keep) : a);
    out.set(n, e ? { o: dir === "in" ? [] : pick(e.o), i: dir === "out" ? [] : pick(e.i), source: "cache" } : null);
  }
  return out;
}
/** 单个节点的 edgesOfMany；null＝未知 */
function edgesOf(id, opts = {}) {
  const n = toInt(id);
  return n == null ? null : edgesOfMany([n], opts).get(n) || null;
}

/** 降级：核心库边表里该节点的边（不完整，只在没有完整来源时显示） */
function coreEdges(n) {
  const d = open();
  if (!d || dbSource !== "core") return { o: [], i: [] };
  return {
    o: d.prepare("SELECT dst, type, pred, conf, source FROM edge WHERE src = ?").raw().all(n),
    i: d.prepare("SELECT src, type, pred, conf, source FROM edge WHERE dst = ?").raw().all(n)
  };
}
/** 边元组 → 邻居行；strict＝丢弃未知类型（非完整库来源） */
function edgeRows(e, layer, strict) {
  return [
    ...e.o.map((x) => ({ other: x[0], type: x[1], pred: x[2], conf: x[3], out: true })),
    ...e.i.map((x) => ({ other: x[0], type: x[1], pred: x[2], conf: x[3], out: false }))
  ].filter((r) => (!strict || TYPE_LAYER[r.type]) && (layer === "all" || TYPE_LAYER[r.type] === layer));
}
function finishRows(rows, nodes) {
  const others = new Map(nodes.map((x) => [x.id, x]));
  return rows
    .map((r) => ({ type: r.type, pred: r.pred || null, out: r.out, conf: r.conf, layer: TYPE_LAYER[r.type], node: others.get("Q" + r.other) }))
    .filter((r) => r.node)
    .sort((a, b) => b.node.rank - a.node.rank);
}
// 非完整库来源的工作量上限（枢纽节点如「美国」入边约 38 万，不能逐个解析对端）：
//   MAX_ENDS：先在边元组上选出最多这么多个不同对端（骨架边 b p c a 的对端优先，其余按边表顺序），之后的本地解析与在线补取只针对它们；
//   MAX_CACHED_NODE_FILES：同步解析对端时最多从磁盘解压这么多个缓存节点分片（LRU 命中不计）；
//   MAX_REMOTE_ENDS / MAX_REMOTE_FILES：本地缺的对端最多联网补这么多个、落在这么多个节点分片里（并发取）。
// 任何一步截掉了对端，结果标 truncated。联网前不知道对端的重要度，无法按 rank 挑；要按 rank 需构建侧把边按对端 rank 排序。
// 完整库模式不受影响（结果与 D323 之前一致）。
const MAX_ENDS = 300;
const MAX_CACHED_NODE_FILES = 12;
const MAX_REMOTE_ENDS = 40;
const MAX_REMOTE_FILES = 6;
// A2：skeletonAmong（图谱重建，主进程同步）一次最多从磁盘解压这么多个缓存边分片；其余节点记入 incomplete，
// 由后台预取（atlasOnline.prefetchEdges，异步、逐文件让出）写进逐节点记忆后，下一次重建直接命中。
const MAX_SYNC_EDGE_FILES = 16;
/**
 * 在边元组上选对端：按 layer（strict＝丢弃未知类型）过滤，骨架边对端优先、其余保持边表顺序，最多 MAX_ENDS 个不同对端；
 * 只为选中的对端构造邻居行。返回 { rows, ends（优先序）, truncated }。
 */
function pickRows(e, layer, strict) {
  const ok = (t) => (!strict || TYPE_LAYER[t]) && (layer === "all" || TYPE_LAYER[t] === layer);
  const chosen = new Set();
  let truncated = false;
  scan: for (const skel of [true, false]) {
    for (const list of [e.o, e.i]) {
      for (const x of list) {
        if (!ok(x[1]) || (TYPE_LAYER[x[1]] === "skeleton") !== skel || chosen.has(x[0])) continue;
        if (chosen.size >= MAX_ENDS) {
          truncated = true;
          break scan;
        }
        chosen.add(x[0]);
      }
    }
  }
  const rows = [];
  for (const [list, out] of [[e.o, true], [e.i, false]]) {
    for (const x of list) if (chosen.has(x[0]) && ok(x[1])) rows.push({ other: x[0], type: x[1], pred: x[2], conf: x[3], out });
  }
  return { rows, ends: [...chosen], truncated };
}
/** 对端节点（同步、零网络）：库 → 快照 → 本地缓存的节点分片（最多解压 MAX_CACHED_NODE_FILES 个文件）。ints 应已按 MAX_ENDS 截断 */
function endNodesSync(ints) {
  const have = getNodes(ints);
  const got = new Set(have.map((x) => toInt(x.id)));
  const miss = ints.filter((i) => !got.has(i));
  if (!miss.length) return { nodes: have, truncated: false };
  let rows = [];
  try {
    rows = online().nodesCachedSync(miss, { maxFiles: MAX_CACHED_NODE_FILES });
  } catch {
    rows = [];
  }
  return { nodes: have.concat(rows.map(rowToNode).filter(Boolean)), truncated: (rows.skipped || 0) > 0 };
}
async function endNodesAsync(ints) {
  const local = endNodesSync(ints);
  const got = new Set(local.nodes.map((x) => toInt(x.id)));
  const miss = ints.filter((i) => !got.has(i));
  if (!miss.length) return { nodes: local.nodes, truncated: false };
  let rows = [];
  try {
    rows = await online().fetchNodes(miss, { maxIds: MAX_REMOTE_ENDS, maxFiles: MAX_REMOTE_FILES });
  } catch {
    rows = [];
  }
  return { nodes: local.nodes.concat(rows.map(rowToNode).filter(Boolean)), truncated: (rows.skipped || 0) > 0 };
}
/** 非完整库来源的邻居：选对端 → 解析对端（同步或异步）→ 邻居行；数组带 complete，截断时带 truncated */
function boundedRows(pick, res, complete) {
  const out = withComplete(finishRows(pick.rows, res.nodes), complete);
  if (pick.truncated || res.truncated) out.truncated = true;
  return out;
}
/** 结果数组上挂 complete（关系是否来自对该节点完整的来源）；数组本身的形状不变 */
const withComplete = (rows, complete) => Object.assign(rows, { complete });

/**
 * 邻居：layer = skeleton | context | all；返回边方向（out＝本节点在 src 侧）与对端节点。
 * D323：边经 edgesOf（完整库 / 本地分片缓存）；都没有时降级用核心库边表，结果数组带 complete:false。
 */
function neighbors(id, opts = {}) {
  const n = toInt(id);
  if (n == null) return withComplete([], false);
  const layer = opts.layer || "all";
  const e = edgesOf(n);
  if (e && e.source === "full") {
    const rows = edgeRows(e, layer, false);
    return withComplete(finishRows(rows, getNodes(rows.map((r) => r.other))), true);
  }
  if (e) {
    const pick = pickRows(e, layer, true);
    return boundedRows(pick, endNodesSync(pick.ends), true);
  }
  const pick = pickRows(coreEdges(n), layer, false);
  return boundedRows(pick, endNodesSync(pick.ends), false);
}

/**
 * neighbors + 在线边分片。D323：非完整库时总是走「本地分片缓存 → 在线边分片」（缓存命中零网络），
 * 不再以本地核心库有没有结果为条件；在线关闭 / 取不到时降级为核心库边表并标 complete:false。
 */
async function neighborsAsync(id, opts = {}) {
  const n = toInt(id);
  if (n == null) return withComplete([], false);
  open();
  if (dbSource === "full") return neighbors(id, opts);
  let e = edgesOf(n);
  if (!e) {
    let f = null;
    try {
      f = await online().fetchEdges(n);
    } catch {
      f = null;
    }
    if (f && f.complete) e = { o: f.o, i: f.i, source: "online" };
  }
  if (!e) return neighbors(id, opts); // 降级（complete:false）
  const pick = pickRows(e, opts.layer || "all", true);
  return boundedRows(pick, await endNodesAsync(pick.ends), true);
}

/**
 * 一组节点之间的骨架边（用户图谱用）：type ∈ b p c a。返回 [{from,to,type,conf}]（形状不变），
 * 数组另带 complete 与 incomplete（没有完整来源的节点编号，"Q…"）。
 * D323：完整库 → 本地分片缓存（同步读，零网络）；某节点未知时，仍可从已知端的入边列表补出它连向已知端的边；
 *   两端都未知的边才降级用核心库边表。
 */
function skeletonAmong(ids) {
  const set = new Set(ids.map(toInt).filter((x) => x != null));
  const out = [];
  const done = (unknown) => Object.assign(out, { complete: !unknown.length, incomplete: unknown.map((i) => "Q" + i) });
  if (!set.size) return done([]);
  open();
  if (dbSource === "full") {
    const m = edgesOfMany([...set], { dir: "out", types: SKEL_TYPES });
    for (const s of set) for (const r of m.get(s).o) if (set.has(r[0])) out.push({ from: "Q" + s, to: "Q" + r[0], type: r[1], conf: r[3] });
    return done([]);
  }
  const m = edgesOfMany([...set], { types: SKEL_TYPES, maxFiles: MAX_SYNC_EDGE_FILES });
  const unknown = [...set].filter((s) => !m.get(s));
  const unk = new Set(unknown);
  const push = (s, t, type, conf) => out.push({ from: "Q" + s, to: "Q" + t, type, conf });
  for (const s of set) {
    const e = m.get(s);
    if (e) for (const r of e.o) if (set.has(r[0])) push(s, r[0], r[1], r[3]);
  }
  if (unk.size) {
    for (const t of set) {
      const e = m.get(t);
      if (e) for (const r of e.i) if (unk.has(r[0])) push(r[0], t, r[1], r[3]);
    }
    const d = open();
    if (d && dbSource === "core") {
      const st = d.prepare("SELECT src, dst, type, pred, conf FROM edge WHERE src = ? AND type IN ('b','p','c','a')");
      for (const s of unk) for (const r of st.all(s)) if (unk.has(r.dst)) push(s, r.dst, r.type, r.conf);
    }
  }
  return done(unknown);
}

/**
 * 一组节点之间的情境边（用户图谱用，v49.153 / D322 / T2）：type ∈ e u r。
 * 返回 [{from,to,type,conf,pred}]（pred 供证据面板显示「全谱：A 与 B——<谓词>」），
 * 数组另带 complete 与 incomplete（没有完整来源的节点编号，"Q…"）。
 * 取边入口、同步上限、核心库降级与 skeletonAmong 完全一致（D323）；skeletonAmong 的语义与输出不变。
 */
function contextAmong(ids) {
  const set = new Set(ids.map(toInt).filter((x) => x != null));
  const out = [];
  const done = (unknown) => Object.assign(out, { complete: !unknown.length, incomplete: unknown.map((i) => "Q" + i) });
  if (!set.size) return done([]);
  open();
  if (dbSource === "full") {
    const m = edgesOfMany([...set], { dir: "out", types: CTX_TYPES });
    for (const s of set) for (const r of m.get(s).o) if (set.has(r[0])) out.push({ from: "Q" + s, to: "Q" + r[0], type: r[1], conf: r[3], pred: r[2] || null });
    return done([]);
  }
  const m = edgesOfMany([...set], { types: CTX_TYPES, maxFiles: MAX_SYNC_EDGE_FILES });
  const unknown = [...set].filter((s) => !m.get(s));
  const unk = new Set(unknown);
  const push = (s, t, type, conf, pred) => out.push({ from: "Q" + s, to: "Q" + t, type, conf, pred: pred || null });
  for (const s of set) {
    const e = m.get(s);
    if (e) for (const r of e.o) if (set.has(r[0])) push(s, r[0], r[1], r[3], r[2]);
  }
  if (unk.size) {
    for (const t of set) {
      const e = m.get(t);
      if (e) for (const r of e.i) if (unk.has(r[0])) push(r[0], t, r[1], r[3], r[2]);
    }
    const d = open();
    if (d && dbSource === "core") {
      const st = d.prepare("SELECT src, dst, type, pred, conf FROM edge WHERE src = ? AND type IN ('e','u','r')");
      for (const s of unk) for (const r of st.all(s)) if (unk.has(r.dst)) push(s, r.dst, r.type, r.conf, r.pred);
    }
  }
  return done(unknown);
}

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
/**
 * 世界层一次性取边（图谱重建用，v49.153 / D322 / T3 审查修正）：同一次 edgesOfMany 里取骨架 + 情境边，
 * 共享同一个 MAX_SYNC_EDGE_FILES 同步预算（分别调用 skeletonAmong + contextAmong 会各花一份预算，合计可达 32 个分片）。
 * 返回 { skeleton, context, complete, incomplete }：两个数组各自带 complete / incomplete 属性，元素形状与
 * skeletonAmong / contextAmong 完全一致（情境边带 pred）。skeletonAmong / contextAmong 的语义与输出不变。
 */
function worldAmong(ids) {
  const set = new Set(ids.map(toInt).filter((x) => x != null));
  const skel = [];
  const ctx = [];
  const done = (unknown) => {
    const meta = { complete: !unknown.length, incomplete: unknown.map((i) => "Q" + i) };
    Object.assign(skel, meta);
    Object.assign(ctx, meta);
    return { skeleton: skel, context: ctx, complete: meta.complete, incomplete: meta.incomplete };
  };
  if (!set.size) return done([]);
  open();
  const push = (s, d, type, pred, conf) => {
    if (CTX_TYPES.includes(type)) ctx.push({ from: "Q" + s, to: "Q" + d, type, conf, pred: pred || null });
    else skel.push({ from: "Q" + s, to: "Q" + d, type, conf });
  };
  if (dbSource === "full") {
    const m = edgesOfMany([...set], { dir: "out", types: WORLD_TYPES });
    for (const s of set) for (const r of m.get(s).o) if (set.has(r[0])) push(s, r[0], r[1], r[2], r[3]);
    return done([]);
  }
  const m = edgesOfMany([...set], { types: WORLD_TYPES, maxFiles: MAX_SYNC_EDGE_FILES });
  const unknown = [...set].filter((s) => !m.get(s));
  const unk = new Set(unknown);
  for (const s of set) {
    const e = m.get(s);
    if (e) for (const r of e.o) if (set.has(r[0])) push(s, r[0], r[1], r[2], r[3]);
  }
  if (unk.size) {
    for (const t of set) {
      const e = m.get(t);
      if (e) for (const r of e.i) if (unk.has(r[0])) push(r[0], t, r[1], r[2], r[3]);
    }
    const d = open();
    if (d && dbSource === "core") {
      const st = d.prepare("SELECT src, dst, type, pred, conf FROM edge WHERE src = ? AND type IN ('b','p','c','a','e','u','r')");
      for (const s of unk) for (const r of st.all(s)) if (unk.has(r.dst)) push(s, r.dst, r.type, r.pred, r.conf);
    }
  }
  return done(unknown);
}

/**
 * 制卡候选召回（§6.2 第 1 步）：在材料文本里做全谱名称的字典匹配。
 * CJK 连续段取长度 2–12 的子串，拉丁文本取 1–4 词的 n-gram；按「出现次数 × 长度 × 重要度」排序，每个名称最多取 3 个同名节点。
 */
function candidates(text, opts = {}) {
  const d = open();
  if (!d) return [];
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 60));
  const src = String(text || "").slice(0, 20000); // 制卡选区通常几千字；上限防止长材料拖慢（每个 CJK 位置最多 11 次索引查找）
  const counts = new Map();
  const bump = (s) => {
    const k = norm(s);
    if (k.length < 2) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const run of src.match(/[぀-ヿ㐀-鿿豈-﫿\w·・\-]+/g) || []) {
    if (CJK.test(run)) {
      const cs = [...run];
      for (let i = 0; i < cs.length; i++) for (let L = 2; L <= 12 && i + L <= cs.length; L++) bump(cs.slice(i, i + L).join(""));
    }
  }
  const words = src.toLowerCase().match(/[a-z][a-z0-9'\-]*/g) || [];
  for (let i = 0; i < words.length; i++) for (let L = 1; L <= 4 && i + L <= words.length; L++) {
    const w = words.slice(i, i + L).join(" ");
    if (w.length >= 3) bump(w);
  }
  const st = d.prepare("SELECT node, w FROM name WHERE norm = ? ORDER BY w DESC LIMIT 3");
  const hits = new Map(); // norm -> rows
  for (const k of counts.keys()) {
    const rows = st.all(k);
    if (rows.length) hits.set(k, rows);
  }
  // 降噪（真实全谱实测：「判断」「中区」这类泛词会挤占名额）：
  //   ① 两字同名多义的 CJK 名称整体降权（保留，附消歧说明由 AI 选）；② 被更长的命中名称包含的短名降权（「判断」在「分析判断」里）；
  //   ③ 长度权重用 L^1.5（封顶 8 字），偏向具体术语。
  const keys = [...hits.keys()];
  const matchedKey = new Map();
  // v49.149 / D318（审查修正）：同一节点在材料里可能以多个名称命中（标签与别名同时出现），全部记下，裁决按材料术语逐个比对
  const allKeys = new Map();
  for (const [k, rows0] of hits) for (const r of rows0) (allKeys.get(r.node) || allKeys.set(r.node, []).get(r.node)).push(k);
  const score = new Map();
  for (const [k, rows0] of hits) {
    const cjk = CJK.test(k);
    const rows = rows0;
    // 两字同名多义：保留（附消歧说明交给 AI 选），但整体降权，让具体术语排在前面
    const amb = cjk && k.length <= 2 && rows.length > 1 ? 0.3 : 1;
    let s0 = counts.get(k) * Math.pow(Math.min(8, k.length), 1.5) * amb;
    if (cjk && keys.some((o) => o.length > k.length && o.includes(k))) s0 *= 0.4;
    for (const r of rows) {
      const s = s0 * (1 + r.w);
      if ((score.get(r.node) || 0) < s) {
        score.set(r.node, s);
        matchedKey.set(r.node, k);
      }
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map((e) => e[0]);
  const byId = new Map(getNodes(ranked).map((n) => [n.id, n]));
  // matched：命中的规范化名称（可能是别名，如「优绩主义」→「精英政治」），界面据此注明「又名」
  // v49.149 / D318：matchedType＝命中方式（标签 / 同义 / 译名分化 / 未分类别名…），matchedGloss＝译名分化义项说明
  return ranked
    .map((i) => {
      const n = byId.get("Q" + i);
      if (!n) return null;
      const k = matchedKey.get(i) || null;
      const m = k ? matchInfo(d, n, k) : { type: null, gloss: null };
      const matches = (allKeys.get(i) || []).slice(0, 8).map((x) => {
        const mi = matchInfo(d, n, x);
        return { norm: x, type: mi.type, gloss: mi.gloss };
      });
      return { ...n, matched: k, matchedType: m.type, matchedGloss: m.gloss, matches };
    })
    .filter(Boolean);
}

/**
 * 学习路线缺口（§8）：目标沿「前置」边（type p：src 是 dst 的前置）向上取闭包，减去已掌握集合。
 * 返回拓扑序（先学的在前）；同层内「前置已全部掌握」的排前面。
 */
function roadmap(targetIds, masteredIds, opts = {}) {
  const d = open();
  if (!d) return { available: false, gap: [], closure: 0 };
  const mastered = new Set((masteredIds || []).map(toInt).filter((x) => x != null));
  const maxN = Math.min(2000, Number(opts.max) || 400);
  const pre = d.prepare("SELECT src FROM edge WHERE dst = ? AND type = 'p'");
  const need = new Map(); // node -> its prereqs (in closure)
  const stack = (targetIds || []).map(toInt).filter((x) => x != null);
  const targets = new Set(stack);
  const seen = new Set(stack);
  while (stack.length && seen.size < maxN) {
    const x = stack.pop();
    const ps = pre.all(x).map((r) => r.src);
    need.set(x, ps);
    for (const p of ps) if (!seen.has(p)) {
      seen.add(p);
      stack.push(p);
    }
  }
  // Kahn 拓扑排序（只看未掌握的）
  const todo = [...seen].filter((x) => !mastered.has(x));
  const todoSet = new Set(todo);
  const indeg = new Map(todo.map((x) => [x, (need.get(x) || []).filter((p) => todoSet.has(p)).length]));
  const order = [];
  let layer = todo.filter((x) => indeg.get(x) === 0);
  const visited = new Set();
  while (layer.length) {
    order.push(...layer);
    for (const x of layer) visited.add(x);
    const next = [];
    for (const y of todo) {
      if (visited.has(y) || next.includes(y)) continue;
      if ((need.get(y) || []).filter((p) => todoSet.has(p)).every((p) => visited.has(p))) next.push(y);
    }
    layer = next;
  }
  for (const x of todo) if (!visited.has(x)) order.push(x); // 残余（数据有环时兜底，构建闸门保证无环）
  const nodes = new Map(getNodes(order).map((n) => [n.id, n]));
  const gap = order.map((x) => {
    const n = nodes.get("Q" + x);
    const ps = (need.get(x) || []).filter((p) => todoSet.has(p)).map((p) => "Q" + p);
    return n ? { ...n, target: targets.has(x), ready: ps.length === 0, prereqs: ps } : null;
  }).filter(Boolean);
  return { available: true, gap, closure: seen.size, mastered: [...seen].filter((x) => mastered.has(x)).length };
}

module.exports = { status, search, searchAsync, node, nodeAsync, nodeLocal, getNodes, getNodesAsync, getNodesLocal, neighbors, neighborsAsync, skeletonAmong, contextAmong, worldAmong, edgesOf, edgesOfMany, _limits: { MAX_ENDS, MAX_CACHED_NODE_FILES, MAX_REMOTE_ENDS, MAX_REMOTE_FILES, MAX_SYNC_EDGE_FILES }, candidates, roadmap, norm, _reset, KIND_LABEL };
