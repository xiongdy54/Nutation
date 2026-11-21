"use strict";
// D304（v49.137）知识图谱服务：事实 → kgCore 模型 → 快照 / 事件流 / 关键帧（设计稿 §8 / §9）。
// 只读主库与 learner.db（v49.143 / D310 起不再写布局缓存）。
// 历史保持度：按 review_logs 用 ts-fsrs 重放每张卡的稳定性（末段以 fsrs_json 实际状态为准，保证「现在」与 LM-1 一致）。
const { fsrs, generatorParameters, createEmptyCard } = require("ts-fsrs");
const kgCore = require("./kgCore");
const kgEdges = require("./kgEdges");
const lmParams = require("./lmParams");
const learnerDb = require("./learnerDb");
const { learningDayStartMs } = require("./fsrsTime");

let dbModule = null;
function db() {
  if (!dbModule) dbModule = require("./db");
  return dbModule;
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
      if (p.material.some((m) => m.kind === "map" || m.kind === "node")) byKind.map++;
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
  cache = { fp, model, builtAt: now, pairs, maybe: resolved.maybe, edgeFacts, world: worldInfo, atlasIds: [...atlasIds] };
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
    if (m.kind === "map" || m.kind === "node") {
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

// v49.143 / D310：布局缓存（kg_layout）退役——关系图位置不持久化，初始位置由 id 固定种子生成。

module.exports = { edgeEvidence, dismissPair, pickRelationAsk, judgeCandidates, contrastCandidate, getGraph, snapshotAt, today, cardPanel, invalidate, prefetchAtlasEdges, worldStatus, atlasNeighbors, replaySeries, _loadModel: loadModel, _atlasPrefetch: { invalidations: () => prefetchInvalidations, pending: () => prefetchRun, runs: () => prefetchRuns, queued: () => prefetchQueued, run: (ids) => runAtlasPrefetch(ids) } };
