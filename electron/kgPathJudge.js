"use strict";
// KG-SG-IMPL-PLAN I11 / 设计稿 §8.6 第 3 层：关联路径的运行时 AI 补链。
// 只在用户主动触发时运行（IPC kg:pathJudge）；本地召回候选 → AI 在封闭集合里连一条 ≤3 跳的链或给 none →
// 本地校验（编号全在给定集合、链首尾相连、关系封闭、依据 ≥4 字）→ 写 knowledge_proposals（scope 'kg-path-judge'，pending）。
// pending 不进搜索（只展示）；用户接受后其每一跳作为用户边（p 0.99）参与路径搜索（kgService.pathExtraEdges）。
// 依赖全部注入（node 可测）：{ chatStream, getAIConfig, getPromptTemplate, kgService?, db?, atlas? }
const { precisionOf, HUB_DEGREE, MIN_PRECISION } = require("./atlasEdgePrecision");
const { BAN_KINDS, SITUATIONAL_KINDS } = require("./atlasPath");

const RELS = ["属于", "例子", "区分", "应用", "前置", "类比", "影响", "提出", "论述", "导致"];
const MAX_CANDIDATES = 20;
/** S6：候选召回时每个节点取边上限（按精确率） */
const NODE_EDGE_CAP = 200;
const MAX_ENDPOINTS = 8;
const MAX_HOPS = 3;
const MIN_BASIS = 4;

/** rel → 全谱边类型（方向 src=from → dst=to；与 atlasPath.sentenceOf 的口径对齐） */
const REL_EDGE = {
  属于: { type: "b" }, 例子: { type: "e" }, 区分: { type: "c" }, 应用: { type: "u" }, 前置: { type: "p" }, 类比: { type: "a" },
  影响: { type: "r", pred: "影响" }, 提出: { type: "r", pred: "提出" }, 论述: { type: "r", pred: "论述" }, 导致: { type: "r", pred: "导致" }
};

const qidOf = (v) => {
  const m = /^Q?(\d+)$/i.exec(String(v == null ? "" : v).trim());
  return m ? "Q" + Number(m[1]) : null;
};
const intOf = (q) => Number(String(q).replace(/^Q/i, ""));

/** 一跳 → pathExtraEdges 的用户边（非法返回 null） */
function hopEdge(h) {
  const a = qidOf(h && h.from), b = qidOf(h && h.to);
  const m = REL_EDGE[String((h && h.rel) || "")];
  if (!a || !b || a === b || !m) return null;
  return { src: intOf(a), dst: intOf(b), source: "user", type: m.type, ...(m.pred ? { pred: m.pred } : {}) };
}

/** 取回复里最后一个含 "hops" 或 "none" 的顶层 JSON 对象 */
function parseReply(raw) {
  const s = String(raw || "");
  const starts = [];
  const re = /\{\s*"(?:hops|none)"/g;
  let m;
  while ((m = re.exec(s))) starts.push(m.index);
  for (let k = starts.length - 1; k >= 0; k--) {
    const at = starts[k];
    let depth = 0, inStr = false, esc = false;
    for (let i = at; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { try { return JSON.parse(s.slice(at, i + 1)); } catch { break; } }
      }
    }
  }
  return null;
}

/**
 * 本地校验一条链。sets：{target:"Q1", endpoints:Set<"Q..">, candidates:Set<"Q..">}
 * @returns {{ok:true, hops:Array}|{ok:false, reasons:string[]}}
 */
function validateChain(reply, sets) {
  const reasons = [];
  const raw = reply && Array.isArray(reply.hops) ? reply.hops : null;
  if (!raw || !raw.length) return { ok: false, reasons: ["没有给出链条"] };
  if (raw.length > MAX_HOPS) return { ok: false, reasons: [`链条超过 ${MAX_HOPS} 跳`] };
  const hops = [];
  for (let i = 0; i < raw.length; i++) {
    const h = raw[i] || {};
    const from = qidOf(h.from), to = qidOf(h.to);
    const rel = String(h.rel || "").trim();
    const basis = String(h.basis || "").trim();
    if (!from || !to) { reasons.push(`第 ${i + 1} 跳编号缺失`); continue; }
    const okFrom = i === 0 ? sets.endpoints.has(from) : sets.candidates.has(from);
    const okTo = i === raw.length - 1 ? to === sets.target : sets.candidates.has(to);
    if (!okFrom) reasons.push(`第 ${i + 1} 跳起点 ${from} 不在给定集合内（或不是已学终点）`);
    if (!okTo) reasons.push(`第 ${i + 1} 跳终点 ${to} 不在给定集合内（或不是目标）`);
    if (from === to) reasons.push(`第 ${i + 1} 跳起止相同`);
    if (!RELS.includes(rel)) reasons.push(`第 ${i + 1} 跳关系 ${rel || "(空)"} 不在封闭集合内`);
    if (basis.length < MIN_BASIS) reasons.push(`第 ${i + 1} 跳依据过短`);
    hops.push({ from, to, rel, basis: basis.slice(0, 200) });
  }
  for (let i = 0; i + 1 < hops.length; i++) if (hops[i].to !== hops[i + 1].from) reasons.push(`第 ${i + 1} 与 ${i + 2} 跳没有首尾相连`);
  const seen = new Set();
  for (const h of hops) { if (seen.has(h.from)) reasons.push("链条出现环"); seen.add(h.from); }
  if (hops.length && hops[hops.length - 1].to !== sets.target) reasons.push("链条没有到达目标");
  return reasons.length ? { ok: false, reasons } : { ok: true, hops };
}

function createKgPathJudge(d) {
  const svc = () => d.kgService || require("./kgService");
  const db = () => d.db || require("./db");
  const atlasMod = () => d.atlas || require("./atlas");
  const inflight = new Map();
  let totalEdges = null; // 全谱边总数（IC 分母），整库只数一次
  let totalFor = null;

  async function chat(system, user) {
    return await new Promise((resolve, reject) => {
      let acc = "";
      let settled = false;
      Promise.resolve(
        d.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.1 }, (m) => {
          if (settled) return;
          if (m && m.error) { settled = true; reject(new Error(String(m.error))); }
          else if (m && m.done) { settled = true; resolve(acc); }
          else if (m && m.delta) acc += m.delta;
        })
      ).catch((e) => { if (!settled) { settled = true; reject(e); } });
    });
  }

  async function aiReady() {
    let cfg = null;
    try { cfg = await d.getAIConfig(); } catch { cfg = null; }
    if (!(cfg && (cfg.hasKey || cfg.preset === "local"))) return null;
    let system = null;
    try { const t = d.getPromptTemplate("kg-path-judge"); system = t && t.content ? String(t.content) : null; } catch { system = null; }
    return system ? { system, model: cfg.model ? String(cfg.model) : null } : null;
  }

  function edgeTotal(handle) {
    if (totalEdges != null && totalFor === handle) return totalEdges;
    let n = 0;
    try {
      const row = handle.prepare("SELECT v FROM meta WHERE k = 'stats'").get();
      const st = row && row.v ? JSON.parse(row.v) : null;
      if (st && Number.isFinite(Number(st.edges)) && Number(st.edges) > 0) n = Number(st.edges);
    } catch { /* 回落到 COUNT */ }
    if (!n) { try { n = Number(handle.prepare("SELECT COUNT(*) AS c FROM edge").get().c) || 0; } catch { n = 0; } }
    totalEdges = Math.max(n, 1);
    totalFor = handle;
    return totalEdges;
  }

  /**
   * 候选召回：目标的一跳邻居 ∪ 每个已学点的一跳邻居；过滤规则与 atlasPath 一致；按 精确率 × IC 取前 N。
   * @returns {{target, endpoints:[{id,label}], candidates:[{id,label,gloss,score}]}}
   */
  async function gather(acc, handle, target, learned, kind) {
    const situational = SITUATIONAL_KINDS.has(kind);
    const total = edgeTotal(handle);
    const learnedSet = new Set(learned);
    const extra = new Map(); // 已接受的用户边也参与召回
    for (const e of svc().pathExtraEdges()) {
      if (!extra.has(e.src)) extra.set(e.src, []);
      if (!extra.has(e.dst)) extra.set(e.dst, []);
      extra.get(e.src).push({ dst: e.dst, type: e.type || "r", pred: e.pred || null, source: e.source, dir: "out" });
      extra.get(e.dst).push({ dst: e.src, type: e.type || "r", pred: e.pred || null, source: e.source, dir: "in" });
    }
    const cands = new Map(); // id → {score, from:Set}
    let visited = 0;
    for (const x of [target, ...learned]) {
      // S6：每个节点只取精确率最高的前 NODE_EDGE_CAP 条；每 50 个节点让出事件循环
      if (++visited % 50 === 0) await new Promise((r) => setImmediate(r));
      const edges = (await acc.edgesOf(x, { topN: NODE_EDGE_CAP, situational })).concat(extra.get(x) || []);
      for (const e of edges) {
        const m = Number(e.dst);
        if (!Number.isFinite(m) || m === x || m === target || learnedSet.has(m)) continue;
        const p = precisionOf({ type: e.type, pred: e.pred, source: e.source }, { situational });
        if (p == null || !(p >= MIN_PRECISION)) continue;
        const prev = cands.get(m);
        if (prev) { if (p > prev.p) prev.p = p; prev.from.add(x); } else cands.set(m, { p, from: new Set([x]) });
      }
    }
    const kept = [];
    let checked = 0;
    for (const [m, c] of cands) {
      if (++checked % 50 === 0) await new Promise((r) => setImmediate(r));
      if (await acc.isFieldOrDomainNode(m)) continue;
      const nd = await acc.nodeOf(m);
      if (!nd || (BAN_KINDS.has(nd.kind) && nd.kind !== kind)) continue;
      const deg = Math.max(1, await acc.degreeOf(m));
      if (deg > HUB_DEGREE) continue;
      const ic = Math.max(0, -Math.log(Math.min(1, deg / total)));
      kept.push({ id: m, label: nd.label || "Q" + m, kind: nd.kind, score: c.p * ic, from: c.from });
    }
    kept.sort((a, b) => b.score - a.score || a.id - b.id);
    const top = kept.slice(0, MAX_CANDIDATES);
    // 已学终点：按「贡献了多少入选候选」排序（含直接连着目标的），取前 MAX_ENDPOINTS
    const contrib = new Map();
    for (const c of top) for (const x of c.from) if (learnedSet.has(x)) contrib.set(x, (contrib.get(x) || 0) + 1);
    const eps = [...learnedSet].sort((a, b) => (contrib.get(b) || 0) - (contrib.get(a) || 0) || a - b).slice(0, MAX_ENDPOINTS);
    const lab = async (n) => { const nd = await acc.nodeOf(n); return (nd && nd.label) || "Q" + n; };
    const endpoints = [];
    for (const n of eps) endpoints.push({ id: n, label: await lab(n) });
    return {
      target: { id: target, label: await lab(target) },
      endpoints,
      candidates: top.map((c) => ({ id: c.id, label: c.label, score: c.score }))
    };
  }

  function buildUser(g, glossOf) {
    const L = [`目标：Q${g.target.id}｜${g.target.label}`, "", "已学终点："];
    for (const e of g.endpoints) L.push(`Q${e.id}｜${e.label}`);
    L.push("", "候选中间知识点：");
    for (const c of g.candidates) L.push(`Q${c.id}｜${c.label}${glossOf(c.id) ? `｜${glossOf(c.id)}` : ""}`);
    return L.join("\n");
  }

  async function judgeOnce(atlasId) {
    const target = intOf(qidOf(atlasId) || "");
    if (!Number.isInteger(target) || target <= 0) return { status: "invalid", reasons: ["目标编号非法"] };
    const ready = await aiReady();
    if (!ready) return { status: "no-ai" };
    const h = atlasMod().openHandle();
    if (!h.db) return { status: "invalid", reasons: ["全谱不可用"] };
    const { accessorFor } = svc()._pathInternals;
    const acc = accessorFor(h.db);
    const pl = await svc().pathLearned(Date.now());
    const learned = pl.atlasLearned || pl.learned; // D342：含没有全谱条目的点亮知识点的代理条目
    if (!learned.length) return { status: "none", reason: "还没有点亮任何知识点" };
    if (learned.includes(target)) return { status: "none", reason: "目标本身已点亮" };
    const tn = await acc.nodeOf(target);
    const g = await gather(acc, h.db, target, learned, tn ? tn.kind : null);
    if (!g.candidates.length) return { status: "none", reason: "没有合格的候选中间知识点" };
    const glossQ = (() => { try { return h.db.prepare("SELECT gloss_zh FROM node WHERE id = ?"); } catch { return null; } })();
    const glossOf = (id) => { try { return String((glossQ && glossQ.get(id) && glossQ.get(id).gloss_zh) || "").replace(/\s+/g, " ").slice(0, 60); } catch { return ""; } };
    let raw;
    try {
      raw = await chat(ready.system, buildUser(g, glossOf));
    } catch (e) {
      return { status: "invalid", reasons: ["AI 调用失败：" + String((e && e.message) || e).slice(0, 120)] };
    }
    const reply = parseReply(raw);
    if (!reply) return { status: "invalid", reasons: ["回复无法解析"] };
    if (reply.none) return { status: "none", reason: String(reply.reason || "").slice(0, 200) };
    const sets = {
      target: "Q" + target,
      endpoints: new Set(g.endpoints.map((e) => "Q" + e.id)),
      candidates: new Set(g.candidates.map((c) => "Q" + c.id))
    };
    const v = validateChain(reply, sets);
    if (!v.ok) return { status: "invalid", reasons: v.reasons };
    const r = db().kgPathProposalAdd({ target: "Q" + target, hops: v.hops, model: ready.model });
    const prop = r.proposal;
    if (prop && prop.status === "rejected") return { status: "none", reason: "这条链之前已被你拒绝" };
    try { svc().pathInvalidate("Q" + target); } catch { /* ignore */ }
    return { status: "proposed", proposal: prop };
  }

  /** 用户触发：同一目标并发共享 */
  function judge(atlasId) {
    const key = String(qidOf(atlasId) || atlasId);
    if (inflight.has(key)) return inflight.get(key);
    const p = judgeOnce(atlasId).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function proposals(atlasId) {
    const q = qidOf(atlasId);
    return q ? db().kgPathProposalList(q) : [];
  }

  function decide(id, decision) {
    if (decision !== "accept" && decision !== "reject") throw new Error("决定只能是 accept 或 reject");
    const prop = db().kgPathProposalDecide(String(id), decision);
    try { svc().pathInvalidate(prop.target); } catch { /* ignore */ }
    return prop;
  }

  return { judge, proposals, decide, _gather: gather, _parseReply: parseReply };
}

module.exports = { createKgPathJudge, parseReply, validateChain, hopEdge, RELS, REL_EDGE, MAX_CANDIDATES, MAX_ENDPOINTS };
