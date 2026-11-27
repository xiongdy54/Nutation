"use strict";
// D304（v49.137）知识图谱服务：事实 → kgCore 模型 → 快照 / 事件流 / 关键帧（设计稿 §8 / §9）。
// 只读主库与 learner.db（v49.143 / D310 起不再写布局缓存）。
// 历史保持度：按 review_logs 用 ts-fsrs 重放每张卡的稳定性（末段以 fsrs_json 实际状态为准，保证「现在」与 LM-1 一致）。
const { fsrs, generatorParameters, createEmptyCard } = require("ts-fsrs");
const kgCore = require("./kgCore");
const kgEdges = require("./kgEdges");
const { normName } = require("./kgSenseCore");
const lmParams = require("./lmParams");
const learnerDb = require("./learnerDb");
const { learningDayStartMs } = require("./fsrsTime");

let dbModule = null;
function db() {
  if (!dbModule) dbModule = require("./db");
  return dbModule;
}

// S4：过期原文术语行（block_hash 与会话现文不符）过滤用的引擎句柄（main.js 注入；未注入 / 会话不在 → 不过滤）
let engineGetter = null;
function setEngineGetter(fn) {
  engineGetter = typeof fn === "function" ? fn : null;
}
function currentEngine() {
  try {
    return engineGetter ? engineGetter() : null;
  } catch {
    return null;
  }
}

const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

function engineFor(cfgRow) {
  const w = cfgRow ? parse(cfgRow.weightsJson, null) : null;
  const opts = cfgRow ? parse(cfgRow.schedulerOptionsJson, {}) || {} : {};
  try {
    return fsrs(
      generatorParameters({
        enable_fuzz: false,
        w: Array.isArray(w) && w.length >= 19 ? w : undefined,
        enable_short_term: typeof opts.enableShortTerm === "boolean" ? opts.enableShortTerm : undefined
      })
    );
  } catch {
    return fsrs(generatorParameters({ enable_fuzz: false }));
  }
}

function decayOf(cfgRow) {
  const w = cfgRow ? parse(cfgRow.weightsJson, null) : null;
  return Array.isArray(w) && w.length >= 21 && Number.isFinite(Number(w[20])) ? Number(w[20]) : lmParams.FSRS_DEFAULT_DECAY;
}

/** 重放一张卡的复习史 → [{t, S}]（每次复习后的稳定性） */
function replaySeries(reviews, engine, actual) {
  const out = [];
  if (!reviews.length) return out;
  let card = createEmptyCard(new Date(reviews[0].t));
  for (const r of reviews) {
    if (r.grade < 1 || r.grade > 4) continue;
    try {
      card = engine.next(card, new Date(r.t), r.grade).card;
      out.push({ t: r.t, S: Number(card.stability) || 0 });
    } catch {
      /* 非法时间序列：跳过该条 */
    }
  }
  // 末段对齐事实：fsrs_json 的 lastReview / stability 是调度真源
  if (actual && Number(actual.lastReview) && Number(actual.stability) > 0) {
    const lr = Number(actual.lastReview);
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - lr) < 60000) last.S = Number(actual.stability);
    else if (!last || lr > last.t) out.push({ t: lr, S: Number(actual.stability) });
  }
  return out;
}

let cache = null; // { fp, model }

// v49.153 / D322 / T1：密度报告——每次重建往应用日志写**一行只含计数**（绝不写知识点名称 / 正文，§7.5）。
// 键固定：kind / pairsByKind / edges / edgesConfirmed / edgesInferred / maybe / dismissed / lit / atlasMode / ms。
function writeDensityReport(pairs, resolved, model, ms) {
  try {
    const byKind = { world: 0, confirmed: 0, map: 0, extract: 0, ai: 0, mine: 0, defMatch: 0 };
    let dismissed = 0;
    for (const p of pairs.values()) {
      if (p.world.length) byKind.world++;
      if (p.confirmed.length) byKind.confirmed++;
      if (p.material.some((m) => m.kind === "map" || m.kind === "node" || m.kind === "arg")) byKind.map++;
      if (p.material.some((m) => m.kind === "extract")) byKind.extract++;
      if (p.ai.length) byKind.ai++;
      if (p.mine.length) byKind.mine++;
      if (p.defMatch.length) byKind.defMatch++;
      if (p.state === "dismissed") dismissed++;
    }
    let edgesConfirmed = 0;
    let edgesInferred = 0;
    for (const e of resolved.edges) {
      if (e.suggested) edgesInferred++;
      else edgesConfirmed++;
    }
    let lit = 0;
    for (const n of model.nodes.values()) if (n.litAt != null) lit++;
    let atlasMode = "none";
    try {
      atlasMode = require("./atlas").status().source || "none";
    } catch {
      atlasMode = "none";
    }
    const line = {
      kind: "kg-density",
      pairsByKind: byKind,
      edges: resolved.edges.length,
      edgesConfirmed,
      edgesInferred,
      maybe: resolved.maybe.length,
      dismissed,
      lit,
      atlasMode,
      ms: Math.round(ms)
    };
    require("./appLog").log("INFO", "kg-density", JSON.stringify(line));
  } catch {
    /* 日志失败绝不影响建模（D119） */
  }
}

function fingerprint() {
  const d = db();
  const f = d.kgFingerprint ? d.kgFingerprint() : String(Date.now());
  return `${f}|${lmParams.PARAM_VERSION}`;
}

/**
 * v49.170 / D340 / I6：给 kps 逐个写 readExplained（就地），返回 readTerms。
 * 读过的单元＝unit_reads；讲类术语＝defines / explains / argues。term → 知识点：atlas_id 命中知识点 atlasId（Q 前缀），或 surface_norm ＝ normName(label)。
 */
function computeReadExplained(d, kps) {
  const rows = d.kgReadTermFacts ? require("./kgTerms").dropStale(currentEngine(), d.kgReadTermFacts()) : [];
  if (!rows.length) {
    for (const k of kps) k.readExplained = false;
    return [];
  }
  const readAtlas = new Set();
  const readNames = new Set();
  for (const r of rows) {
    if (r.atlasId != null) readAtlas.add(Number(r.atlasId));
    readNames.add(String(r.surfaceNorm || ""));
  }
  const kpAtlas = new Set();
  const kpNames = new Set();
  for (const k of kps) {
    const nn = normName(k.label);
    if (nn) kpNames.add(nn);
    const n = k.atlasId ? Number(String(k.atlasId).slice(1)) : 0;
    if (n) kpAtlas.add(n);
    k.readExplained = Boolean((n && readAtlas.has(n)) || (nn && readNames.has(nn)));
  }
  const groups = new Map(); // atlasInt → { docs:Set, surface, names:Set }
  for (const r of rows) {
    if (r.atlasId == null) continue;
    const n = Number(r.atlasId);
    if (kpAtlas.has(n)) continue;
    let g = groups.get(n);
    if (!g) {
      g = { docs: new Set(), surface: String(r.surface || ""), names: new Set() };
      groups.set(n, g);
    }
    g.docs.add(String(r.documentId));
    g.names.add(String(r.surfaceNorm || ""));
  }
  const list = [...groups]
    .filter(([, g]) => ![...g.names].some((nm) => kpNames.has(nm)))
    .sort((x, y) => y[1].docs.size - x[1].docs.size || x[0] - y[0])
    .slice(0, 200);
  if (!list.length) return [];
  const labels = new Map();
  try {
    for (const n of require("./atlas").getNodes(list.map(([n]) => "Q" + n))) if (n) labels.set(n.id, n.zh || n.en || n.ja || null);
  } catch {
    /* 全谱不可用：用术语写法当标签 */
  }
  return list.map(([n, g]) => ({ atlasId: "Q" + n, label: labels.get("Q" + n) || g.surface, documentIds: [...g.docs].sort() }));
}

async function loadModel(now) {
  const d = db();
  const fp = fingerprint();
  if (cache && cache.fp === fp && now - cache.builtAt < 60000) return cache.model;
  const facts = d.kgFacts();
  const cardKp = d.resolveCardKpMap();
  const cfgById = new Map((facts.fsrsConfigs || []).map((c) => [String(c.id), c]));
  const engines = new Map();
  const reviewsByCard = new Map();
  for (const r of facts.reviewLogs || []) {
    const id = String(r.cardId);
    if (!reviewsByCard.has(id)) reviewsByCard.set(id, []);
    reviewsByCard.get(id).push({ t: Number(r.reviewedAt) || 0, grade: kgCore.gradeOf(r.rating) });
  }
  const cards = [];
  for (const c of facts.cards || []) {
    const kpId = cardKp.get(String(c.id));
    if (!kpId) continue;
    const leech = parse(c.leechJson, null);
    if (leech && leech.suspended && leech.reason !== "kp_archived") continue;
    const cfg = cfgById.get(String(c.fsrsConfigId || "")) || null;
    const key = cfg ? String(cfg.id) : "";
    if (!engines.has(key)) engines.set(key, engineFor(cfg));
    const reviews = (reviewsByCard.get(String(c.id)) || []).filter((r) => r.grade >= 1);
    const actual = parse(c.fsrsJson, null) || {};
    cards.push({
      id: c.id,
      kpId,
      facet: c.facet,
      cardType: c.cardType,
      reviews,
      series: replaySeries(reviews, engines.get(key), actual),
      decay: decayOf(cfg),
      due: Number(actual.due) || null
    });
  }
  let kpStates = new Map();
  try {
    await learnerDb.open();
    kpStates = new Map(
      (await learnerDb.all("SELECT kp_id, level, confidence, fading, metrics_json FROM kp_states")).map((r) => [
        String(r.kp_id),
        { level: Number(r.level), confidence: r.confidence, fading: Boolean(r.fading), metrics: parse(r.metrics_json, {}) }
      ])
    );
  } catch {
    /* 学习者模型关闭或库不可用：历史重算口径兜底（kgCore.levelAt） */
  }
  const kps = [];
  const extractCounts = new Map();
  for (const k of facts.kps || []) {
    if (k.mergedInto) continue;
    const meta = parse(k.metadataJson, {}) || {};
    kps.push({
      id: k.id,
      label: k.label,
      description: k.description,
      status: k.status,
      aliases: parse(k.aliasJson, []),
      kind: meta.kgKind || meta.kind,
      domainId: k.domainId,
      createdAt: k.createdAt,
      atlasId: k.atlasId ? "Q" + k.atlasId : null,
      atlasParent: k.atlasParent ? "Q" + k.atlasParent : null,
      atlasAlso: (facts.atlasAlso && facts.atlasAlso[k.id]) || [],
      atlasSplit: (facts.atlasSplit && facts.atlasSplit[k.id]) || []
    });
    const st = kpStates.get(String(k.id));
    if (st && st.metrics && st.metrics.extractCount) extractCounts.set(String(k.id), Number(st.metrics.extractCount));
  }
  const selfExplain = (facts.selfExplain || []).map((e) => ({ kpId: e.kpId, t: Number(e.ts), clear: (parse(e.payloadJson, {}) || {}).selfRating === "clear" }));
  // v49.170 / D340 / I6 证据阶梯第 1 级：读过的单元里讲了它（atlas 命中或名称命中）＝ readExplained；
  //   readTerms ＝ 还不是知识点的、已链接全谱的讲类术语（≤200，按出现材料数降序），供图谱「显示读过的」画空心轮廓
  const readTerms = computeReadExplained(d, kps);
  // 关系：用户确认的边 + 全谱派生边（世界层证据）；三层汇总见下方 kgEdges（v49.148 / D317）
  const relations = (facts.relations || []).map((r) => ({ ...r }));
  // v49.143 / D311：挂了全谱的知识点之间的全谱骨架边（属于 / 前置 / 区分 / 类比）；主题取全谱主题。
  // v49.148 / D317 修订：骨架边不再是已确认边，作为世界层证据画成淡色推断线
  const themeLabels = new Map();
  // v49.154 / D323 / A2：世界层骨架边是否完整（incomplete＝本地没有完整关系来源的挂靠节点）
  let world = { complete: true, incomplete: [] };
  const atlasIds = new Set();
  for (const k of kps) for (const q of [k.atlasId, k.atlasParent, ...(k.atlasAlso || [])]) if (q) atlasIds.add(q);
  try {
    const atlas = require("./atlas");
    const mapped = kps.filter((k) => k.atlasId);
    if (mapped.length) {
      const info = new Map(atlas.getNodes(mapped.map((k) => k.atlasId)).map((n) => [n.id, n]));
      const topics = new Map(atlas.getNodes([...new Set([...info.values()].map((n) => n.topicId).filter(Boolean))]).map((n) => [n.id, n]));
      for (const k of mapped) {
        const n = info.get(k.atlasId);
        if (n && n.topicId) {
          k.atlasTopic = n.topicId;
          const t = topics.get(n.topicId);
          if (t) themeLabels.set(`atlas:${n.topicId}`, t.zh || t.en || n.topicId);
        }
      }
      const kpOf = new Map(mapped.map((k) => [k.atlasId, k]));
      // v49.144 / D312：私有知识点挂在全谱上级下——上级也是用户的知识点时画「属于」，主题随上级
      for (const k of kps) {
        if (k.atlasId || !k.atlasParent) continue;
        const parent = kpOf.get(k.atlasParent);
        if (parent && parent.id !== k.id) {
          relations.push({ id: `atlasParent:${k.id}`, fromId: String(k.id), toId: String(parent.id), type: "part_of", createdAt: Math.max(Number(k.createdAt) || 0, Number(parent.createdAt) || 0), source: "atlas" });
        }
        const pn = atlas.getNodes([k.atlasParent])[0];
        const topicId = pn ? pn.topicId || pn.id : null;
        if (topicId) {
          k.atlasTopic = topicId;
          if (!themeLabels.has(`atlas:${topicId}`)) {
            const t = atlas.getNodes([topicId])[0];
            if (t) themeLabels.set(`atlas:${topicId}`, t.zh || t.en || topicId);
          }
        }
      }
      // v49.145 / D313：「也涉及」的全谱节点也是用户知识点时画「相关」（不影响主题与路线）
      for (const k of kps) {
        for (const q of k.atlasAlso || []) {
          const o = kpOf.get(q);
          if (!o || o.id === k.id) continue;
          relations.push({ id: `atlasAlso:${k.id}>${q}`, fromId: String(k.id), toId: String(o.id), type: "related_to", createdAt: Math.max(Number(k.createdAt) || 0, Number(o.createdAt) || 0), source: "atlas" });
        }
      }
      const TYPE = { b: "part_of", p: "prerequisite", c: "contrasts_with", a: "analogous_to" };
      // v49.153 / D322 / T2：世界层收情境边 e/u/r（只用于两个都是用户已学知识点之间；淡色推断线，§3.4）
      const CTX = { e: "example_of", u: "application_of", r: "related_to" };
      const have = new Set(relations.map((r) => `${r.fromId}|${r.toId}|${r.type}`));
      const mappedAtlas = mapped.map((k) => k.atlasId);
      // v49.153 / D322 / T3 审查修正：骨架 + 情境边一次取，共用一份同步分片预算（合计不超 MAX_SYNC_EDGE_FILES）
      const w = atlas.worldAmong ? atlas.worldAmong(mappedAtlas) : { skeleton: atlas.skeletonAmong(mappedAtlas), context: atlas.contextAmong(mappedAtlas) };
      const skel = w.skeleton;
      const ctx = w.context;
      world = {
        complete: skel.complete !== false && ctx.complete !== false,
        incomplete: [...new Set([...(Array.isArray(skel.incomplete) ? skel.incomplete : []), ...(Array.isArray(ctx.incomplete) ? ctx.incomplete : [])])]
      };
      for (const e of skel) {
        const a = kpOf.get(e.from);
        const b = kpOf.get(e.to);
        if (!a || !b || a.id === b.id) continue;
        const type = TYPE[e.type];
        if (!type || have.has(`${a.id}|${b.id}|${type}`)) continue;
        have.add(`${a.id}|${b.id}|${type}`);
        relations.push({ id: `atlas:${e.from}>${e.to}:${e.type}`, fromId: String(a.id), toId: String(b.id), type, createdAt: Math.max(Number(a.createdAt) || 0, Number(b.createdAt) || 0), source: "atlas" });
      }
      for (const e of ctx) {
        const a = kpOf.get(e.from);
        const b = kpOf.get(e.to);
        if (!a || !b || a.id === b.id) continue;
        const type = CTX[e.type];
        if (!type || have.has(`${a.id}|${b.id}|${type}`)) continue;
        have.add(`${a.id}|${b.id}|${type}`);
        relations.push({ id: `atlas:${e.from}>${e.to}:${e.type}`, fromId: String(a.id), toId: String(b.id), type, createdAt: Math.max(Number(a.createdAt) || 0, Number(b.createdAt) || 0), source: "atlas", pred: e.pred || null, ctx: true });
      }
    }
  } catch {
    /* 全谱缺失或损坏：退回用户关系 */
  }
  // v49.148 / D317：连线分三层——全谱派生边只是世界层证据（淡色推断线），实线只来自用户（knowledge_relations）
  const worldRels = relations.filter((r) => r.source === "atlas");
  const edgeFacts = d.kgEdgeFacts ? d.kgEdgeFacts() : {};
  if (edgeFacts.termArgs && Array.isArray(edgeFacts.termArgs.terms) && edgeFacts.termArgs.terms.length) {
    edgeFacts.termArgs = { ...edgeFacts.termArgs, terms: require("./kgTerms").dropStale(currentEngine(), edgeFacts.termArgs.terms) };
  }
  const edgesStarted = Date.now();
  const pairs = kgEdges.collectPairs({ kps, allKps: facts.kps, confirmed: facts.relations, world: worldRels, defVersions: facts.defVersions, edgeFacts, cardKp });
  const resolved = kgEdges.resolveEdges(pairs, edgeFacts.dismissals);
  const edgesMs = Date.now() - edgesStarted;
  const model = kgCore.buildModel({
    now,
    cutoffHour: facts.cutoffHour,
    kps,
    cards,
    relations: resolved.edges,
    defVersions: facts.defVersions,
    selfExplain,
    extractCounts,
    kpStates,
    kgEvents: facts.kgEvents,
    themeLabels
  });
  const worldInfo = { complete: world.complete, incomplete: world.incomplete.length, incompleteIds: world.incomplete };
  cache = { fp, model, builtAt: now, pairs, maybe: resolved.maybe, edgeFacts, world: worldInfo, atlasIds: [...atlasIds], readTerms };
  writeDensityReport(pairs, resolved, model, edgesMs);
  kickAtlasPrefetch([...atlasIds], worldInfo);
  return model;
}

function invalidate() {
  cache = null;
}

// ---- v49.154 / D323 / A2：后台预取挂靠节点的边分片；取完让图谱缓存失效一次 ----
// 触发：① 启动后空闲（main.js 定时调 prefetchAtlasEdges）；② 图谱重建发现世界层不完整、或挂靠节点集合变了
// （同一集合 10 分钟内只因重建触发一次，防止记忆容量不够时「重建 → 预取 → 失效 → 重建」打转）。
// 完整库模式不预取；联网关闭时 atlasOnline 不发请求（只把磁盘缓存读进记忆）。
const PREFETCH_REKICK_MS = 10 * 60 * 1000;
let prefetchRun = null; // 进行中的预取（单飞）
let prefetchRunSig = null; // 进行中这一轮的 id 集合签名
let prefetchQueued = null; // 进行中收到的、id 集合不同的预取请求：本轮结束后补跑一次
let lastKick = { sig: null, at: 0 };
let prefetchInvalidations = 0; // 测试观测用
let prefetchRuns = 0; // 测试观测用：实际开跑的轮数

function atlasIsFull() {
  try {
    return require("./atlas").status().source === "full";
  } catch {
    return true; // 全谱不可用：没有可预取的
  }
}

/** 预取一批全谱节点的边分片；本轮有新落盘的分片或新写入记忆的节点时让图谱缓存失效（恰好一次）。同一时刻只跑一轮。 */
function runAtlasPrefetch(ids) {
  const sig = ids.slice().sort().join(",");
  if (prefetchRun) {
    // 进行中又来了一批不同的 id：记下来，本轮结束后补跑一次（否则新 id 要等下一次重建 / 启动）
    if (sig !== prefetchRunSig && (!prefetchQueued || prefetchQueued.sig !== sig)) prefetchQueued = { ids: ids.slice(), sig };
    return prefetchRun;
  }
  if (!ids.length || atlasIsFull()) return Promise.resolve(null);
  prefetchRuns++;
  prefetchRunSig = sig;
  prefetchRun = (async () => {
    try {
      const r = await require("./atlasOnline").prefetchEdges(ids);
      if (r && (r.fetched > 0 || r.warmed > 0)) {
        prefetchInvalidations++;
        invalidate();
      }
      return r;
    } catch {
      return null;
    } finally {
      prefetchRun = null;
      prefetchRunSig = null;
      const q = prefetchQueued;
      prefetchQueued = null;
      if (q) setImmediate(() => void runAtlasPrefetch(q.ids));
    }
  })();
  return prefetchRun;
}

function kickAtlasPrefetch(ids, worldInfo) {
  if (!ids.length) return;
  const sig = ids.slice().sort().join(",");
  const t = Date.now();
  if (!(worldInfo.incomplete > 0) && sig === lastKick.sig) return;
  if (sig === lastKick.sig && t - lastKick.at < PREFETCH_REKICK_MS) return;
  lastKick = { sig, at: t };
  setImmediate(() => void runAtlasPrefetch(ids));
}

/** 启动后空闲调用：取挂靠节点集合（必要时先建一次模型），预取其边分片。返回本轮结果（null＝没有可做的）。 */
async function prefetchAtlasEdges() {
  if (atlasIsFull()) return null;
  if (!cache) await loadModel(Date.now());
  const ids = cache ? cache.atlasIds : [];
  if (cache) lastKick = { sig: ids.slice().sort().join(","), at: Date.now() };
  return runAtlasPrefetch(ids);
}

/**
 * v49.154 / D323 / A3：atlas:neighbors 的 IPC 主体——原样补 kp；
 * opts.withMeta === true 时另包一层 { rows, complete, truncated }（rows 即原数组元素），否则返回值不变。
 */
async function atlasNeighbors(id, opts) {
  const o = opts || {};
  const rows = await require("./atlas").neighborsAsync(String(id || ""), o);
  const kps = db().kpsByAtlasIds(rows.map((r) => r.node.id));
  const out = rows.map((r) => ({ ...r, kp: kps[r.node.id] || null }));
  if (o.withMeta === true) return { rows: out, complete: rows.complete !== false, truncated: rows.truncated === true };
  return out;
}

/** 世界层完整性（最近一次建模）：{ complete, incomplete: 计数, incompleteIds }；尚未建模＝null。界面提示与 IPC 标记见 A3。 */
function worldStatus() {
  return cache ? cache.world : null;
}

/** 图谱页一次取齐：当前快照 + 全史事件流 + 按日关键帧 + 今日摘要 */
async function getGraph(opts) {
  const now = Date.now();
  const model = await loadModel(now);
  // 「now」以 model.now 为准（缓存期内快照时刻一致，保证快照与事件流同一时点）
  const snapshot = kgCore.snapshotAt(model, model.now);
  let start = model.now;
  for (const n of model.nodes.values()) {
    if (n.firstReviewAt != null && n.firstReviewAt < start) start = n.firstReviewAt;
    if (n.createdAt && n.createdAt < start) start = n.createdAt;
  }
  const withHistory = !opts || opts.history !== false;
  const todayFrom = learningDayStartMs(model.now, model.cutoffHour);
  const ws = worldStatus();
  return {
    snapshot,
    start,
    events: withHistory ? kgCore.timeline(model, start, model.now) : [],
    keyframes: withHistory ? kgCore.keyframes(model, start, model.now) : null,
    today: kgCore.todaySummary(model, todayFrom),
    history: withHistory ? historyIndex(model) : null,
    maybe: maybeIndex(model),
    // v49.170 / D340 / I6：读过讲了、但还不是知识点的全谱术语（≤200）；图谱「显示读过的」画成空心轮廓
    readTerms: (cache && cache.model === model && cache.readTerms) || [],
    // v49.154 / D323 / A3：世界层完整性（界面据此提示「部分关系需要联网」）；只给计数，不传 id 列表
    world: { complete: !ws || ws.complete !== false, incomplete: ws ? Number(ws.incomplete) || 0 : 0 }
  };
}

/** v49.148 / D317：只在一份材料导图里出现过的对子（不画线），节点详情里列为「可能相关」；两端都已点亮 */
function maybeIndex(model) {
  const out = {};
  const list = (cache && cache.model === model && cache.maybe) || [];
  for (const { a, b } of list) {
    const na = model.nodes.get(a);
    const nb = model.nodes.get(b);
    if (!na || !nb || na.litAt == null || nb.litAt == null) continue;
    (out[a] = out[a] || []).push(b);
    (out[b] = out[b] || []).push(a);
  }
  return out;
}

const ASK_COOLDOWN_MS = 30 * 86400000;

/** 对子在 30 天内问过吗（kg_events relation_asked） */
function askedRecently(edgeFacts, key, now) {
  for (const e of (edgeFacts && edgeFacts.relationAsked) || []) {
    const p = parse(e.payloadJson, {}) || {};
    if (p.pair === key && now - Number(e.ts) < ASK_COOLDOWN_MS) return true;
  }
  return false;
}

/**
 * v49.148 / D317 复习页关系提问的选题：当前知识点的连线里，另一端已点亮、未归档；
 * 优先已确认但还没说明的线，其次证据最多的推断线；30 天内问过的不问；解除后重新出现的距解除须满 30 天。
 */
function pickRelationAsk(model, kpId) {
  const now = model.now;
  const self = model.nodes.get(kpId);
  if (!self || self.litAt == null) return null;
  const ef = cache && cache.model === model ? cache.edgeFacts : null;
  const cands = [];
  for (const e of model.edges) {
    const other = e.from === kpId ? e.to : e.to === kpId ? e.from : null;
    if (!other) continue;
    const m = model.nodes.get(other);
    if (!m || m.litAt == null || m.archivedAt != null) continue;
    let tier;
    if (e.status === "confirmed") {
      if (!e.unexplained) continue;
      tier = 0;
    } else tier = 1;
    if (e.resurfaced && now - Number(e.resurfaced.at) < ASK_COOLDOWN_MS) continue;
    const key = kgEdges.pairKey(kpId, other);
    if (askedRecently(ef, key, now)) continue;
    const L = e.layers || { w: 0, m: 0, u: 0 };
    cands.push({ e, m, tier, score: (L.w || 0) + (L.m || 0) + (L.u || 0) });
  }
  cands.sort((x, y) => x.tier - y.tier || y.score - x.score || (x.m.id < y.m.id ? -1 : 1));
  const c = cands[0];
  if (!c) return null;
  return { edgeId: c.e.id, status: c.e.status, type: c.e.type, from: c.e.from, to: c.e.to, other: { id: c.m.id, label: c.m.label, definition: c.m.definition } };
}

/** v49.148 / D317 关系面板：一对知识点的三层证据明细（只读） */
async function edgeEvidence(a, b) {
  const d = db();
  const model = await loadModel(Date.now());
  const key = kgEdges.pairKey(a, b);
  const p = cache && cache.pairs ? cache.pairs.get(key) : null;
  const [x, y] = key.split("|");
  const na = model.nodes.get(x);
  const nb = model.nodes.get(y);
  if (!na || !nb) return null;
  const base = { a: { id: x, label: na.label }, b: { id: y, label: nb.label } };
  if (!p) return { ...base, state: "none", confirmed: [], inferred: null, world: [], material: [], ai: [], mine: [], text: [], cardText: [], dismissal: null };
  const fresh = new Set(p.newKeys || []);
  const mapNodes = [];
  for (const m of p.material) {
    if (m.kind === "map") mapNodes.push({ mapId: m.mapId, nodeId: m.parentNodeId }, { mapId: m.mapId, nodeId: m.childNodeId });
    if (m.kind === "node") mapNodes.push({ mapId: m.mapId, nodeId: m.nodeId });
    if (m.kind === "arg") mapNodes.push({ mapId: m.mapId, nodeId: m.fromNodeId }, { mapId: m.mapId, nodeId: m.toNodeId });
  }
  const look = d.kgEvidenceLookup({
    docIds: [...p.docs],
    mapNodes,
    extractIds: [
      ...p.material.filter((m) => m.kind === "extract").map((m) => m.extractId),
      ...p.mine.filter((m) => m.kind === "annotation").map((m) => m.extractId),
      ...p.text.map((m) => m.extractId)
    ],
    eventIds: p.mine.filter((m) => m.kind === "explain").map((m) => m.eventId),
    defIds: p.mine.filter((m) => m.kind === "def").map((m) => m.defId),
    proposalIds: p.ai.map((m) => m.id)
  });
  // 摘录所在材料的标题（摘录 / 批注的材料不一定在导图证据里）
  const missingDocs = [...new Set(Object.values(look.extracts).map((e) => e.documentId).filter((id) => id && !look.docs[id]))];
  if (missingDocs.length) Object.assign(look.docs, d.kgEvidenceLookup({ docIds: missingDocs }).docs);
  const docTitle = (id) => (look.docs && look.docs[id]) || "";
  const material = [];
  const seenMap = new Set();
  for (const m of p.material) {
    if (m.kind === "arg") {
      const k = `arg|${m.rule}|${m.code}|${m.mapId}|${m.fromNodeId}|${m.toNodeId}|${m.blockA}|${m.blockB}|${m.kpA}|${m.kpB}`;
      if (seenMap.has(k)) continue;
      seenMap.add(k);
      material.push({
        kind: "arg",
        rule: m.rule,
        code: m.code,
        pred: m.pred || null,
        documentId: m.documentId,
        title: docTitle(m.documentId),
        mapId: m.mapId,
        fromNodeId: m.fromNodeId,
        toNodeId: m.toNodeId,
        nodeId: m.toNodeId,
        path: [look.nodes[`${m.mapId}|${m.fromNodeId}`] || "", look.nodes[`${m.mapId}|${m.toNodeId}`] || ""],
        quoteA: m.quoteA,
        quoteB: m.quoteB,
        blockA: m.blockA,
        blockB: m.blockB,
        kpA: m.kpA,
        kpB: m.kpB,
        isNew: fresh.has(m.key)
      });
    } else if (m.kind === "map" || m.kind === "node") {
      const k = m.kind === "map" ? `${m.mapId}|${m.parentNodeId}|${m.childNodeId}` : `${m.mapId}|${m.nodeId}`;
      if (seenMap.has(k)) continue;
      seenMap.add(k);
      const path = m.kind === "map" ? [look.nodes[`${m.mapId}|${m.parentNodeId}`] || "", look.nodes[`${m.mapId}|${m.childNodeId}`] || ""] : [look.nodes[`${m.mapId}|${m.nodeId}`] || ""];
      material.push({ kind: m.kind, documentId: m.documentId, title: docTitle(m.documentId), mapId: m.mapId, nodeId: m.kind === "map" ? m.childNodeId : m.nodeId, path, isNew: fresh.has(m.key) });
    } else if (m.kind === "extract") {
      const ex = look.extracts[m.extractId];
      if (!ex) continue;
      material.push({ kind: "extract", extractId: m.extractId, documentId: ex.documentId, title: docTitle(ex.documentId), snippet: ex.snippet, anchor: ex.anchor, isNew: fresh.has(m.key) });
    }
    if (material.length >= 30) break;
  }
  material.sort((u, v) => Number(v.isNew) - Number(u.isNew));
  // v49.153 / D322 / T3：M4 摘录原文（t:，前 60 字 + 摘录 id）与卡片正文（c:，卡片 id）。
  // 单独成数组（不塞进 material）：本项只提供数据，面板渲染是 T7；旧面板按「非 extract 即导图」渲染 material。
  const text = [];
  for (const m of p.text) {
    if (text.length >= 30) break;
    const ex = look.extracts[m.extractId];
    text.push({
      kind: m.kind, // "text"（M4a 强）/ "textBoth"（M4b 弱）
      extractId: m.extractId,
      documentId: ex ? ex.documentId : null,
      title: ex ? docTitle(ex.documentId) : "",
      snippet: ex && ex.text ? String(ex.text).slice(0, 60) : "",
      anchor: ex ? ex.anchor : null,
      isNew: fresh.has(m.key)
    });
  }
  const cardText = p.cardText.slice(0, 30).map((m) => ({ kind: "card", cardId: m.cardId, isNew: fresh.has(m.key) }));
  const ai = p.ai.map((j) => ({ type: j.type, from: j.fromId, to: j.toId, quote: j.quote, isNew: fresh.has(j.key) }));
  const mine = [];
  for (const m of p.mine) {
    if (m.kind === "explain") {
      const ev = look.events[m.eventId];
      if (ev) mine.push({ kind: "explain", ts: ev.ts, text: ev.text, rating: ev.rating, kpId: ev.kpId, isNew: fresh.has(m.key) });
    } else if (m.kind === "annotation") {
      const ex = look.extracts[m.extractId];
      if (ex) mine.push({ kind: "annotation", extractId: m.extractId, documentId: ex.documentId, title: docTitle(ex.documentId), text: ex.comment, anchor: ex.anchor, isNew: fresh.has(m.key) });
    } else if (m.kind === "def") {
      const df = look.defs[m.defId];
      if (df) mine.push({ kind: "def", kpId: df.kpId, text: df.body, ts: df.createdAt, isNew: fresh.has(m.key) });
    } else if (m.kind === "card") {
      // 用户自己写的卡（generated_by=manual）提到另一知识点：U3 同级
      mine.push({ kind: "card", cardId: m.cardId, isNew: fresh.has(m.key) });
    }
  }
  mine.sort((u, v) => Number(v.isNew) - Number(u.isNew) || (Number(v.ts) || 0) - (Number(u.ts) || 0));
  return {
    ...base,
    state: p.state || "none",
    confirmed: p.confirmed.map((r) => ({ id: r.id, type: r.type, from: r.fromId, to: r.toId, createdAt: r.createdAt })),
    inferred: p.state === "inferred" && p.inferredType ? p.inferredType : null,
    world: p.world.map((w) => ({ type: w.type, from: w.fromId, to: w.toId, pred: w.pred || null })),
    material,
    ai,
    mine,
    text,
    cardText,
    dismissal: p.dismissal && (p.newKeys || []).length ? p.dismissal : null
  };
}

// ---------- v49.153 / D322 / T6：AI 判断的片段（设计 KG-EDGE-DENSITY §3.5） ----------
const SNIPPET_MAX = 300;
const SENTENCE_END = new Set(["。", "！", "？", ".", "!", "?"]);

/**
 * 按句末标点 / 换行切句，返回每句在**原文里的 [start,end) 偏移**（首尾空白不计）。
 * 片段一律用 text.slice(start, end) 取原文，绝不把各句拼回去——拼接会插入分隔符，
 * 拼出的串不是原文子串，AI 引文校验就会放行作者没说过的字。
 */
function sentenceSpans(text) {
  const src = String(text || "");
  const out = [];
  const push = (s, e) => {
    while (s < e && /\s/.test(src[s])) s++;
    while (e > s && /\s/.test(src[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  let start = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n" || ch === "\r") {
      if (start >= 0) {
        push(start, i);
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
    if (SENTENCE_END.has(ch)) {
      push(start, i + 1);
      start = -1;
    }
  }
  if (start >= 0) push(start, src.length);
  return out;
}

/** 片段优先级 1/2 用 buildMatcher 判命中；这里只找名称在文本里的位置，供超长片段居中裁剪（不另写匹配规则） */
function firstMention(lowerText, kp) {
  let best = null;
  for (const raw of [kp.label, ...(kp.aliases || [])]) {
    const n = String(raw || "").trim().toLowerCase();
    if (n.length < 2) continue;
    const i = lowerText.indexOf(n);
    if (i < 0) continue;
    if (!best || i < best.start || (i === best.start && n.length > best.len)) best = { start: i, end: i + n.length, len: n.length };
  }
  return best;
}

/**
 * 超过 300 字：以两个名称的命中区间为中心，按**原文偏移**裁剪（结果仍是原文子串）。
 * span 是片段所在的原文区间；返回 src.slice(...)，不做任何拼接。
 */
function trimCentered(src, span, kpA, kpB) {
  const text = String(src || "");
  const start = span ? span.start : 0;
  const end = span ? span.end : text.length;
  if (end - start <= SNIPPET_MAX) return text.slice(start, end);
  const lower = text.slice(start, end).toLowerCase();
  const a = firstMention(lower, kpA);
  const b = firstMention(lower, kpB);
  if (!a || !b) return text.slice(start, start + SNIPPET_MAX);
  const hitStart = start + Math.min(a.start, b.start);
  const hitEnd = start + Math.max(a.end, b.end);
  const from = Math.max(start, Math.min(Math.floor((hitStart + hitEnd) / 2 - SNIPPET_MAX / 2), end - SNIPPET_MAX));
  return text.slice(from, from + SNIPPET_MAX);
}

/** 同时含两个知识点的最短句子；没有这样的单句就取同时含两者的最短连续几句。返回原文 [start,end) 或 null。 */
function bothMentionsWindow(text, match, kpA, kpB) {
  const src = String(text || "");
  const spans = sentenceSpans(src);
  const hit = (s, e) => {
    const h = match(src.slice(s, e));
    return h.has(kpA) && h.has(kpB);
  };
  let best = null;
  for (let i = 0; i < spans.length; i++) {
    for (let j = i; j < spans.length; j++) {
      const start = spans[i].start;
      const end = spans[j].end;
      if (best && end - start >= best.end - best.start) break; // 从 i 起的窗口只会更长
      if (hit(start, end)) {
        best = { start, end };
        break;
      }
    }
  }
  return best;
}

/** 摘录里提到这一对（优先同时提到两端）的句子；只提到一端的句子作兜底。返回原文 [start,end) 或 null。 */
function mentionSentence(text, match, kpA, kpB) {
  const src = String(text || "");
  let fallback = null;
  for (const sp of sentenceSpans(src)) {
    const h = match(src.slice(sp.start, sp.end));
    if (!h.has(kpA) && !h.has(kpB)) continue;
    if (h.has(kpA) && h.has(kpB)) return sp;
    if (!fallback) fallback = sp;
  }
  return fallback;
}

/**
 * v49.148 / D317 AI 判断的候选（kgEdgeJudge 调用）：未确认、未处于解除状态、还没有 AI 判断、两端都已点亮且未归档。
 * v49.153 / D322 / T6：候选扩大到「有材料证据，或有弱证据（单份材料导图 / M4b / 卡片正文 c:）」；
 *   只有 d:（AI 写的定义互相提到）的对子不送 AI。指纹＝材料键 ∪ t: ∪ c:，新证据出现后重新判断。
 * 片段（最多 2 段、每段 ≤300 字）：① M4a/M4b 摘录里同时含两个名称的句子；② 为其中一端制卡的摘录里提到另一端的句子；
 *   ②b 卡片正文（c:）里提到另一端的句子；③ 前几种都没有时才用导图路径。片段键仍是证据键（t: / c: / x: / m:），
 *   引文校验与 sourceKey 不变。片段一律从原文按 [start,end) 偏移切片，保证是原文子串。
 * 只有真正建出片段的对子才占 limit 名额：没有片段来源的对子（例如卡片正文已不可用）直接跳过，
 *   否则它们会每轮占满 limit，把有原文可判的对子永远挡在外面。
 */
async function judgeCandidates(limit, done) {
  const d = db();
  const model = await loadModel(Date.now());
  const pairs = cache && cache.pairs ? cache.pairs : new Map();
  const max = Math.max(1, Number(limit) || 10);
  // 先收集全部合格对子（不占名额），再按块取事实、建片段
  const eligible = [];
  for (const p of pairs.values()) {
    if (p.state === "confirmed" || p.state === "dismissed" || p.ai.length) continue;
    // 材料证据（M1/M2 导图、M3 同摘录）或弱证据（M4 摘录原文 t:、卡片正文 c:）；只有 d: 的对子不送 AI
    if (!p.material.length && !p.text.length && !p.cardText.length) continue;
    const na = model.nodes.get(p.a);
    const nb = model.nodes.get(p.b);
    if (!na || !nb || na.litAt == null || nb.litAt == null || na.archivedAt != null || nb.archivedAt != null) continue;
    const fp = [...new Set([...p.material, ...p.text, ...p.cardText].map((m) => m.key))].sort().join(",");
    if (done && done[p.key] === fp) continue;
    eligible.push({ p, fp, na, nb });
  }
  if (!eligible.length) return [];
  // 名称匹配复用 kgEdges.buildMatcher（最长匹配优先），与 collectPairs 的判定口径一致
  const match = kgEdges.buildMatcher([...model.nodes.values()]);
  const cardCache = new Map();
  const cardSource = (cardId) => {
    if (!cardCache.has(cardId)) {
      const card = d.getCard ? d.getCard(cardId) : null;
      // 与 kgEdgeFacts.cardTexts 的口径一致：正反面各取前 600 字，中间用换行分隔
      cardCache.set(cardId, card ? `${String(card.frontMarkdown || "").slice(0, 600)}\n${String(card.backMarkdown || "").slice(0, 600)}` : "");
    }
    return cardCache.get(cardId);
  };
  const out = [];
  const CHUNK = 25; // 每块的对子数（kgEvidenceLookup 的 id 上限 200，块取小一点避免截断）
  for (let from = 0; from < eligible.length && out.length < max; from += CHUNK) {
    const chunk = eligible.slice(from, from + CHUNK);
    const extractIds = [];
    const mapNodes = [];
    const docIds = [];
    for (const { p } of chunk) {
      for (const m of p.material) {
        if (m.kind === "extract") extractIds.push(m.extractId);
        else if (m.kind === "map") mapNodes.push({ mapId: m.mapId, nodeId: m.parentNodeId }, { mapId: m.mapId, nodeId: m.childNodeId });
        else if (m.kind === "node") mapNodes.push({ mapId: m.mapId, nodeId: m.nodeId });
        else if (m.kind === "arg") mapNodes.push({ mapId: m.mapId, nodeId: m.fromNodeId }, { mapId: m.mapId, nodeId: m.toNodeId });
        if (m.documentId) docIds.push(m.documentId);
      }
      for (const m of p.text) if (m.extractId) extractIds.push(m.extractId);
    }
    const look = d.kgEvidenceLookup({ extractIds, mapNodes, docIds });
    for (const { p, fp, na, nb } of chunk) {
      if (out.length >= max) break;
      const snippets = [];
      const add = (key, text) => {
        if (snippets.length >= 2) return;
        const t = String(text || "").trim().slice(0, SNIPPET_MAX);
        if (!t || snippets.some((s) => s.text === t)) return;
        snippets.push({ key, text: t });
      };
      // ① M4a / M4b：摘录原文里同时含两个名称的句子（没有单句时就取最短的连续几句）
      for (const m of p.text) {
        if (snippets.length >= 2) break;
        const ex = look.extracts[m.extractId];
        if (!ex || !ex.text) continue;
        const src = String(ex.text);
        const w = bothMentionsWindow(src, match, p.a, p.b);
        if (w) add(m.key, trimCentered(src, w, na, nb));
      }
      // ② 为其中一端制卡的摘录（M3）：提到另一端的句子
      if (snippets.length < 2) {
        for (const m of p.material) {
          if (snippets.length >= 2) break;
          if (m.kind !== "extract") continue;
          const ex = look.extracts[m.extractId];
          if (!ex || !ex.text) continue;
          const src = String(ex.text);
          const s = mentionSentence(src, match, p.a, p.b);
          if (s) add(m.key, trimCentered(src, s, na, nb));
        }
      }
      // ②b 卡片正文（c:）：正反面里提到另一端的句子（卡片不可用时没有片段，不占名额）
      if (snippets.length < 2) {
        for (const m of p.cardText) {
          if (snippets.length >= 2) break;
          const src = cardSource(m.cardId);
          if (!src) continue;
          const s = mentionSentence(src, match, p.a, p.b);
          if (s) add(m.key, trimCentered(src, s, na, nb));
        }
      }
      // ③ 前几种都没有时才用导图路径
      if (!snippets.length) {
        for (const m of p.material) {
          if (snippets.length >= 2) break;
          if (m.kind === "arg") {
            // 论证证据自带原文引句：直接作为片段（两句都是原文子串）
            add(m.key, [m.quoteA, m.quoteB].filter(Boolean).join(" … "));
            continue;
          }
          if (m.kind !== "map" && m.kind !== "node") continue;
          const path = m.kind === "map" ? [look.nodes[`${m.mapId}|${m.parentNodeId}`], look.nodes[`${m.mapId}|${m.childNodeId}`]] : [look.nodes[`${m.mapId}|${m.nodeId}`]];
          const title = look.docs[m.documentId] || "";
          const text = `${title ? `《${title}》` : ""}${path.filter(Boolean).join(" › ")}`;
          if (text) add(m.key, text);
        }
      }
      if (!snippets.length) continue;
      out.push({ key: p.key, kpA: p.a, kpB: p.b, a: { label: na.label, definition: na.definition || "" }, b: { label: nb.label, definition: nb.definition || "" }, fp, snippets });
    }
  }
  return out;
}

/** v49.148 / D317 解除：快照当前全部证据键后写解除记录；返回撤销数据 */
async function dismissPair(a, b) {
  await loadModel(Date.now());
  const key = kgEdges.pairKey(a, b);
  const p = cache && cache.pairs ? cache.pairs.get(key) : null;
  const undo = db().kgDismissPair(a, b, p ? kgEdges.evidenceKeys(p) : []);
  invalidate();
  return { undo, worldOnly: Boolean(p && p.world.length && !p.material.length && !p.ai.length && !p.mine.length) };
}

/** 回放用的节点静态史：创建时刻、首次复习、点亮、等级史、归档时刻（渲染器按 t 折叠，不另算事实） */
function historyIndex(model) {
  const out = {};
  for (const n of [...model.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    out[n.id] = {
      createdAt: n.createdAt,
      firstReviewAt: n.firstReviewAt,
      litAt: n.litAt,
      archivedAt: n.archivedAt,
      levels: n.levelHistory.map((h) => [h.t, h.level]),
      facets: Object.fromEntries(Object.entries(n.facetPassedAt))
    };
  }
  return out;
}

async function snapshotAt(t) {
  const model = await loadModel(Date.now());
  return kgCore.snapshotAt(model, Number(t));
}

async function today() {
  const model = await loadModel(Date.now());
  return kgCore.todaySummary(model, learningDayStartMs(model.now, model.cutoffHour));
}

/** 复习面板（设计稿 §11）：卡片所属知识点、是否须在翻面前隐藏名称、反向链接 */
async function cardPanel(cardId) {
  const d = db();
  const kpId = d.resolveCardKpMap().get(String(cardId));
  if (!kpId) return null;
  const kp = d.getKnowledgePoint(kpId);
  if (!kp || kp.status !== "active") return null;
  const card = d.getCard(String(cardId));
  const answer = card ? `${card.backMarkdown || ""}\n${card.noteText || ""}`.toLowerCase() : "";
  const names = [kp.canonicalLabel, ...(kp.aliases || [])].map((x) => String(x || "").trim().toLowerCase()).filter((x) => x.length > 0);
  const hideNameBeforeFlip = names.some((n) => answer.includes(n));
  const model = await loadModel(Date.now());
  const node = model.nodes.get(kpId);
  const snap = node ? kgCore.snapshotAt(model, model.now).nodes.find((x) => x.id === kpId) : null;
  // 反向链接：同一知识点下的其他卡（按侧面分组，只给题面摘要）、相邻知识点
  const siblings = [];
  if (node) {
    for (const c of node.cards) {
      if (c.id === String(cardId)) continue;
      const cc = d.getCard(c.id);
      if (!cc) continue;
      siblings.push({ id: c.id, facet: c.facet, front: String(cc.frontMarkdown || "").slice(0, 160) });
      if (siblings.length >= 30) break;
    }
  }
  const neighbors = [];
  for (const e of model.edges) {
    const other = e.from === kpId ? e.to : e.to === kpId ? e.from : null;
    if (!other) continue;
    const m = model.nodes.get(other);
    if (!m) continue;
    neighbors.push({ id: other, label: m.label, definition: m.definition, type: e.type, group: e.group, status: e.status, outgoing: e.from === kpId });
  }
  const linkTerms = [];
  for (const m of model.nodes.values()) {
    if (m.id === kpId || m.archivedAt != null) continue;
    for (const nm of [m.label, ...m.aliases]) if (String(nm || "").trim().length >= 2) linkTerms.push({ id: m.id, term: String(nm).trim(), label: m.label, definition: m.definition });
  }
  return {
    kp: { id: kp.id, label: kp.canonicalLabel, aliases: kp.aliases || [], definition: kp.description || "" },
    facet: card ? card.facet || null : null,
    hideNameBeforeFlip,
    node: snap,
    versions: d.listKpDefinitionVersions(kpId),
    siblings,
    neighbors,
    linkTerms: linkTerms.slice(0, 2000),
    relationAsk: pickRelationAsk(model, kpId)
  };
}

// ---------- v49.139 / D306 区分卡提议（设计稿 §7.4，时机：复习会话收尾，绝不在复习流程中） ----------
// 候选＝已确认的「易混」关系，两端都已点亮且未归档、从未处理过；
// 时机信号（缺一不提）：近 14 天任一端有「重来」，或这条易混关系是近 14 天才建立的（用户刚标记 / 刚采纳）。
// 取信号最新的一对；每次只给一对。每学习日至多一次由渲染层节流。
const CONTRAST_WINDOW_MS = 14 * 86400000;
async function contrastCandidate() {
  const model = await loadModel(Date.now());
  const handled = new Set(
    db().listKgEvents({}).filter((e) => e.kind === "contrast_handled").map((e) => String((e.payload || {}).pair || ""))
  );
  const lastLapse = (n) => {
    let t = 0;
    for (const c of n.cards) for (const r of c.reviews) if (r.grade === 1 && r.t > t) t = r.t;
    return t;
  };
  let best = null;
  for (const e of model.edges) {
    if (e.group !== "contrast" || e.status !== "confirmed") continue;
    const a = model.nodes.get(e.from);
    const b = model.nodes.get(e.to);
    if (!a || !b || a.litAt == null || b.litAt == null || a.archivedAt != null || b.archivedAt != null) continue;
    const pair = [a.id, b.id].sort().join("|");
    if (handled.has(pair)) continue;
    const signal = Math.max(lastLapse(a), lastLapse(b), e.createdAt || 0);
    if (model.now - signal > CONTRAST_WINDOW_MS) continue;
    if (!best || signal > best.signal || (signal === best.signal && pair < best.pair)) {
      best = { pair, signal, a: { id: a.id, label: a.label, definition: a.definition }, b: { id: b.id, label: b.label, definition: b.definition } };
    }
  }
  return best;
}

// ---------- 关联路径（KG-SG-IMPL-PLAN §5.2 / I9）：从「我已点亮的知识点」到目标全谱节点的走廊 ----------
/** 额外边钩子（材料投影 / 用户边，后续任务接入）；返回 [{src,dst,source,type?,pred?}] */
function pathExtraEdges() {
  const out = [];
  // I11：用户已接受的 AI 补链——每一跳按用户边（p 0.99）参与搜索；待确认 / 已拒绝的不参与
  try {
    const { hopEdge } = require("./kgPathJudge");
    for (const pr of db().kgPathProposalAccepted()) for (const h of pr.hops) { const e = hopEdge(h); if (e) out.push(e); }
  } catch { /* 无库 / 无提案表：当作没有 */ }
  return out;
}

/**
 * 点亮的知识点 → 路径搜索的「已学端点」（与 runPath / kgPathJudge 同口径）。
 * v49.172 / D342：没有对应全谱条目的点亮知识点不再被忽略——每个这样的知识点成为一个虚拟端点（负整数 id），
 * 经「代理边」连到全谱：挂在上级下（atlasParent，属于）/ 也涉及（atlasAlso）＝用户确认的边（source user）；
 * 两者都没有时，取名称里出现的全谱词前 2 个（source name，精确率见 atlasEdgePrecision）。
 * @returns {{ learned:int[], kpOf:Map<int,kpId>, proxyEdges:object[], virtual:Map<int,{label,kpId}>, atlasLearned:int[] }}
 *   atlasLearned＝真实全谱端点 ∪ 代理条目（AI 补链用：AI 只认识全谱条目）
 */
async function pathLearned(now = Date.now()) {
  const model = await loadModel(now);
  const learned = [];
  const kpOf = new Map();
  const proxyEdges = [];
  const virtual = new Map();
  const atlasLearned = new Set();
  const qnum = (q) => { const v = Number(String(q || "").replace(/^Q/, "")); return Number.isInteger(v) && v > 0 ? v : null; };
  let vid = -1;
  for (const n of model.nodes.values()) {
    if (n.litAt == null || n.litAt > now || n.archivedAt != null) continue;
    const q = qnum(n.atlasId);
    if (q != null) {
      learned.push(q);
      kpOf.set(q, n.id);
      atlasLearned.add(q);
      continue;
    }
    const links = [];
    const par = qnum(n.atlasParent);
    if (par != null) links.push({ dst: par, source: "user", type: "b" });
    for (const a of n.atlasAlso || []) { const x = qnum(a); if (x != null) links.push({ dst: x, source: "user", type: "r", pred: "涉及" }); }
    if (!links.length) for (const x of nameProxies(n.label)) links.push({ dst: x, source: "name", type: "r", pred: "名称含" });
    // 没有任何代理也给虚拟 id：你自己图谱里的连线 / 材料论证仍可能把它连进来（pathGraphEdges）
    const v = vid--;
    learned.push(v);
    kpOf.set(v, n.id);
    virtual.set(v, { label: n.label, kpId: n.id });
    for (const l of links) {
      proxyEdges.push({ src: v, dst: l.dst, source: l.source, type: l.type, ...(l.pred ? { pred: l.pred } : {}) });
      atlasLearned.add(l.dst);
    }
  }
  return { learned, kpOf, proxyEdges, virtual, atlasLearned: [...atlasLearned] };
}

/**
 * v49.172 / D342：路径搜索也走「你自己的图谱」与「你读的书」——此前这两层证据从没进过搜索（钩子一直空着）。
 *  ① 知识点之间的连线：已确认 → user（0.99）；有材料证据（导图论证 / 摘录 / 正文同现，不含只靠 AI 或只靠全谱的推断线）→ material（0.92）；
 *  ② 材料论证投影到全谱（kgEdges.projectTermArgs）：术语不必是知识点 → material（0.92）。
 * 端点 id：有全谱条目的知识点＝条目整数 id；点亮但没有条目的知识点＝pathLearned 给的虚拟 id；其余（未点亮且无条目）跳过。
 * @param {Map<string,number>} kpToInt  知识点 id → 搜索用整数 id
 */
const GRAPH_TYPE = { part_of: "b", specialization_of: "b", generalization_of: "b", example_of: "e", prerequisite: "p", contrasts_with: "c", analogous_to: "a", application_of: "u", related_to: "r" };
const ARG_PRED_OK = new Set(["导致", "影响", "论述", "提出"]);
async function pathGraphEdges(kpToInt) {
  const out = [];
  await loadModel(Date.now());
  const c = cache;
  if (!c) return out;
  const idOf = (x) => {
    const s = String(x || "");
    if (/^Q\d+$/.test(s)) return Number(s.slice(1));
    return kpToInt.has(s) ? kpToInt.get(s) : null;
  };
  // ① 知识点之间的连线
  for (const p of (c.pairs && c.pairs.values && c.pairs.values()) || []) {
    let source = null, type = "r", from = p.a, to = p.b;
    if (p.state === "confirmed" && p.confirmed.length) {
      source = "user";
      const r = p.confirmed[0];
      type = GRAPH_TYPE[r.type] || "r";
      from = r.fromId; to = r.toId;
    } else if (p.state === "inferred") {
      const nonAi = p.docs.size + p.material.filter((m) => m.kind === "extract").length + p.text.length + p.cardText.length + p.mine.length;
      if (!nonAi) continue; // 只靠 AI 判断或只靠全谱（全谱边本来就在搜索里）
      source = "material";
      const it = p.inferredType || {};
      type = GRAPH_TYPE[it.type] || "r";
      from = it.from || p.a; to = it.to || p.b;
    } else continue;
    const a = idOf(from), b = idOf(to);
    if (a == null || b == null || a === b) continue;
    // p：前置的方向约定与全谱一致（src 依赖 dst：dst 是 src 的前置）——知识点关系里 from 是前置
    const rt = p.state === "confirmed" ? p.confirmed[0].type : (p.inferredType || {}).type;
    if (type === "p" || rt === "generalization_of") out.push({ src: b, dst: a, source, type }); // 泛化：B 属于 A
    else out.push({ src: a, dst: b, source, type });
  }
  // ② 材料论证投影到全谱
  try {
    const kps = [...c.model.nodes.values()].map((n) => ({ id: n.id, label: n.label, atlasId: n.atlasId || null }));
    const key = c.builtAt;
    if (!c.projected || c.projected.key !== key) c.projected = { key, rows: require("./kgEdges").projectTermArgs(c.edgeFacts && c.edgeFacts.termArgs, kps) };
    for (const r of c.projected.rows) {
      const from = idOf(r.from), to = idOf(r.to);
      if (from == null || to == null || from === to) continue;
      if (r.argType === "prerequisite") out.push({ src: to, dst: from, source: "material", type: "p" }); // from 前置于 to
      else if (r.argType === "example_of") out.push({ src: from, dst: to, source: "material", type: "e" });
      else if (r.argType === "contrasts_with") out.push({ src: from, dst: to, source: "material", type: "c" });
      else out.push({ src: from, dst: to, source: "material", type: "r", pred: ARG_PRED_OK.has(r.pred) ? r.pred : "导致" });
    }
  } catch { /* 无材料：只用知识点连线 */ }
  return out;
}

/** 名称代理：名称里出现的全谱词（本地字典召回），去掉被更长命中包含的碎片（「特朗」⊂「特朗普」）与同名重复，取前 2 */
const nameProxyCache = new Map();
function nameProxies(label) {
  const key = String(label || "").trim();
  if (key.length < 2) return [];
  if (nameProxyCache.has(key)) return nameProxyCache.get(key);
  let out = [];
  try {
    const hits = require("./atlas").candidates(key.replace(/[《》「」]/g, ""), { limit: 12 }) || [];
    const keys = hits.map((h) => String(h.matched || ""));
    const seen = new Set();
    for (let i = 0; i < hits.length && out.length < 2; i++) {
      const k = keys[i];
      if (k.length < 2 || seen.has(k)) continue;
      if (keys.some((o) => o.length > k.length && o.includes(k))) continue;
      seen.add(k);
      const q = Number(String(hits[i].id || "").replace(/^Q/, ""));
      if (Number.isInteger(q) && q > 0) out.push(q);
    }
  } catch { out = []; }
  if (nameProxyCache.size > 2000) nameProxyCache.clear();
  nameProxyCache.set(key, out);
  return out;
}

/** 决议 / 新提案后让在飞的路径搜索不再被复用（pathRuns 只缓存在飞 Promise） */
function pathInvalidate(atlasId) {
  const t = String(atlasId == null ? "" : atlasId).replace(/^Q/i, "");
  for (const k of [...pathRuns.keys()]) if (!atlasId || k.split("|")[0].replace(/^Q/i, "") === t) pathRuns.delete(k);
}

/** 在全谱访问器外包一层：负 id＝虚拟端点（不查库） */
function withVirtual(acc, virtual) {
  return {
    ...acc,
    edgesOf: (id, eo) => (virtual.has(id) ? [] : acc.edgesOf(id, eo)),
    edgesBetween: (id, others) => (virtual.has(id) ? [] : acc.edgesBetween(id, (others || []).filter((o) => !virtual.has(o)))),
    nodeOf: (id) => (virtual.has(id) ? { id, kind: "concept", topic: null, field: null, label: virtual.get(id).label } : acc.nodeOf(id)),
    degreeOf: (id) => (virtual.has(id) ? 1 : acc.degreeOf(id)),
    isFieldOrDomainNode: (id) => (virtual.has(id) ? false : acc.isFieldOrDomainNode(id)),
    isTopicNode: (id) => (virtual.has(id) ? false : acc.isTopicNode(id))
  };
}

let pathAccessor = null; // { db, acc }
function accessorFor(handle) {
  if (!pathAccessor || pathAccessor.db !== handle) {
    pathAccessor = { db: handle, acc: require("./atlasPath").sqliteAccessor(handle) };
  }
  return pathAccessor.acc;
}
const pathRuns = new Map(); // key → Promise（同一目标并发调用共享）

/** S3：「继续搜索」放大 maxExpand 时同比放大超时预算（基准 4000 ms @ 20000，上限 16000 ms），否则超时截断的搜索翻倍无效 */
function pathBudgetOpts(opts) {
  const me = opts && Number(opts.maxExpand) > 0 ? Number(opts.maxExpand) : 0;
  if (!me) return {};
  return { maxExpand: me, timeoutMs: Math.min(16000, Math.max(4000, Math.round((4000 * me) / 20000))) };
}

async function runPath(atlasId, opts) {
  const { findCorridor } = require("./atlasPath");
  const atlas = require("./atlas");
  const target = Number(String(atlasId == null ? "" : atlasId).replace(/^Q/i, ""));
  const h = atlas.openHandle();
  if (!h.db || !Number.isInteger(target) || target <= 0) return { status: "unavailable" };
  const { learned, kpOf, proxyEdges, virtual } = await pathLearned(Date.now());
  const kpToInt = new Map();
  for (const n of (await loadModel(Date.now())).nodes.values()) { const q = Number(String(n.atlasId || "").replace(/^Q/, "")); if (Number.isInteger(q) && q > 0) kpToInt.set(String(n.id), q); }
  for (const [q, k] of kpOf) if (q < 0) kpToInt.set(String(k), q);
  const graphEdges = await pathGraphEdges(kpToInt).catch(() => []);
  try {
    const base = accessorFor(h.db);
    // D342：虚拟端点（没有全谱条目的点亮知识点）只有代理边，标签取知识点名称
    const acc = virtual.size ? withVirtual(base, virtual) : base;
    const res = await findCorridor({
      accessor: acc,
      target,
      learned,
      extraEdges: pathExtraEdges().concat(proxyEdges, graphEdges),
      opts: { ...pathBudgetOpts(opts), scope: h.source === "core" ? "core" : "full", kpIdOf: (q) => kpOf.get(q) ?? null, passNodes: new Set(proxyEdges.map((e) => e.dst)) }
    });
    // I11：待确认的 AI 补链只用于展示，不进搜索
    const lab = (qid) => { const nd = acc.nodeOf(Number(String(qid).replace(/^Q/i, ""))); return (nd && nd.label) || String(qid); };
    let aiChains = [];
    try {
      aiChains = db().kgPathProposalList("Q" + target).filter((p) => p.status === "pending")
        .map((p) => ({ id: p.id, hops: p.hops.map((x) => ({ from: x.from, to: x.to, rel: x.rel, basis: x.basis, fromLabel: lab(x.from), toLabel: lab(x.to) })) }));
    } catch { /* 无提案表：不展示 */ }
    return { ...res, aiChains };
  } catch (e) {
    try { require("./appLog").log("WARN", "kg-path", String((e && e.message) || e)); } catch { /* 日志失败不影响返回 */ }
    return { status: "unavailable" };
  }
}

/** @param {string|number} atlasId "Q123" 或整数；opts.maxExpand 透传（「继续搜索」翻倍） */
function pathToLearned(atlasId, opts = {}) {
  const key = String(atlasId) + "|" + (opts.maxExpand || "");
  if (pathRuns.has(key)) return pathRuns.get(key);
  const p = runPath(atlasId, opts).finally(() => pathRuns.delete(key));
  pathRuns.set(key, p);
  return p;
}

// v49.143 / D310：布局缓存（kg_layout）退役——关系图位置不持久化，初始位置由 id 固定种子生成。

module.exports = { setEngineGetter, pathToLearned, pathExtraEdges, pathGraphEdges, pathLearned, pathInvalidate, _pathInternals: { accessorFor, pathBudgetOpts }, edgeEvidence, dismissPair, pickRelationAsk, judgeCandidates, contrastCandidate, getGraph, snapshotAt, today, cardPanel, invalidate, prefetchAtlasEdges, worldStatus, atlasNeighbors, replaySeries, _loadModel: loadModel, _atlasPrefetch: { invalidations: () => prefetchInvalidations, pending: () => prefetchRun, runs: () => prefetchRuns, queued: () => prefetchQueued, run: (ids) => runAtlasPrefetch(ids) } };
