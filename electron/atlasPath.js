// 关联路径走廊搜索（纯算法，不直接访问 DB）——KG-SG-IMPL-PLAN §5.2 / 设计稿 §8.3 §8.5 §8.7 §8.8。
//
// 注入的图访问器 accessor（同步或返回 Promise 均可，内部统一 await）：
//   edgesOf(intId)            → [{dst:int, type, pred, dir:'out'|'in', source}]   dir='out'＝本节点是 src
//   nodeOf(intId)             → {id, kind, topic, field, label} | null
//   degreeOf(intId)           → int
//   isFieldOrDomainNode(intId)→ bool        学科 / 领域代表节点（不得作中间节点）
//   isTopicNode(intId)        → bool        主题节点（兄弟剪枝时允许汇合）
//   可选：edgesBetween(intId, others:int[]) → 本节点与 others 之间的边（同 edgesOf 形状；枢纽端点只靠它取「端点—端点」直连）
//   可选（仅「远」档阶梯用）：
//   fieldInfo(fieldId)        → {label, domainLabel} | null
//   topEntries({topic, field, limit, exclude}) → [{id, label}]   同 topic 里 concept 的 rank 前 N（只查主题级，无 topic＝[]）
//
// findCorridor({accessor, target, learned, extraEdges, opts}) → §5.2 的返回形状。
//   extraEdges：[{src, dst, source:'user'|'material', type?='r', pred?}]（材料投影 / 用户边，方向 src→dst）
//   opts：{maxExpand=20000, timeoutMs=4000, yieldEvery=500, scope='full', kpIdOf?:(intId)=>kpId, precisionFn?, now?, passNodes?:Set<int>}
//
// 约定（本模块自行拍板，见返回值注释）：
//  - 图按「无向」搜索；同一对节点之间只保留精确率最高的一条边（并列时按 type|pred|source 字典序）。
//  - 兄弟剪枝用「状态图」做精确搜索：状态 = (节点, 到达边是否 b|e 且指向该节点且该节点是泛类)。
//    泛类状态下不能再经另一条 b|e 且指向它的边离开。
//  - 汇合在「非泛类的主题节点」上（A→C←B，两条 b|e 都指向 C）时，这对边标 weak:true（虚线弱连接，§8.7.4）。
//  - 学科 / 领域代表节点不能作中间节点 → 跨学科只在这类节点汇合时无连线，落到「远」档 + 面包屑。
//  - D342 枢纽端点（度数 > HUB_DEGREE 的目标 / 已学点，如「印度」有 6.9 万条边）不再按「精确率→id」取前 500 条
//    （同精确率时等于按 id 随机挑，真正相关的邻居常落在 500 名外，且这 500 个邻居会把整个搜索预算吃光）。
//    改为「惰性邻接」：对侧展开到某节点 x、发现 x 与枢纽端点相连时，才把这条边注入枢纽一侧（x 的边表是完整的）。
//    相遇改为「松弛边时检测」（经典双向 Dijkstra），停止条件 rG + rL ≥ mu；枢纽一侧的半径按最强一跳的下界计。
//  - 路径条数 = 走廊 DAG（边按 d_G 严格递减定向）上的 DP；DAG 上的路径各边都在某条 ≤ best+Δ 的路径里，
//    个别由「各自合格的边」拼成的路径总代价可能略超窗口（与 §5.2 口径一致，不再逐条验证）。
"use strict";

const { precisionOf, HUB_DEGREE, MIN_PRECISION, EXCLUDED_PREDS } = require("./atlasEdgePrecision");

const BUDGET = -Math.log(0.5); // 可靠度预算
const DELTA = Math.log(1 / 0.8); // 走廊宽度
const EPS = 1e-9;
const SIBLING_DEGREE = 500;
const DISPLAY_NODES = 25;
const BAN_KINDS = new Set(["organization", "place", "taxon"]);
const SITUATIONAL_KINDS = new Set(["event", "place"]);
const BOOK_KINDS = new Set(["b", "e"]);

// ---------- 句子（与 src/lib/atlas.ts 的 PRED_OUT / PRED_IN 口径对拍：s = 语义上的 src，d = dst） ----------
const R_SENTENCE = {
  影响: (s, d) => `${s}影响了${d}`,
  先于: (s, d) => `${s}先于${d}`,
  导致: (s, d) => `${s}导致${d}`,
  师从: (s, d) => `${s}师从${d}`,
  著有: (s, d) => `${s}著有${d}`,
  创作: (s, d) => `${s}创作了${d}`,
  属于流派: (s, d) => `${s}属于${d}流派`,
  提出: (s, d) => `${s}提出了${d}`,
  论述: (s, d) => `${s}论述了${d}`,
  参与: (s, d) => `${s}参与了${d}`,
  发生于: (s, d) => `${s}发生于${d}`,
  位于: (s, d) => `${s}位于${d}`,
  研究: (s, d) => `${s}研究${d}`,
  改编自: (s, d) => `${s}改编自${d}`,
  受启发于: (s, d) => `${s}受${d}启发`,
  出自: (s, d) => `${s}出自${d}`,
  重大事件: (s, d) => `${d}是${s}的重大事件`,
  实例: (s, d) => `${d}是${s}的实例`,
  用于: (s, d) => `${s}用于${d}`,
  象征: (s, d) => `${s}象征${d}`,
  就读于: (s, d) => `${s}就读于${d}`,
  任职于: (s, d) => `${s}任职于${d}`,
  成员: (s, d) => `${d}是${s}的成员`,
  得名于: (s, d) => `${s}得名于${d}`,
  // v49.172 / D342：没有全谱条目的知识点经代理边连到全谱
  涉及: (s, d) => `${s}涉及${d}`,
  名称含: (s, d) => `${s}的名称里有${d}`
};

/** @param {{type:string,pred?:string|null,dir:'out'|'in',fromLabel:string,toLabel:string}} e */
function sentenceOf(e) {
  const from = e.fromLabel, to = e.toLabel;
  const [s, d] = e.dir === "in" ? [to, from] : [from, to];
  switch (e.type) {
    case "b": return `${s}属于${d}`;
    case "p": return `${d}是${s}的前置`;
    case "c": return `${from}与${to}相区分`;
    case "a": return `${from}与${to}相类比`;
    case "e": return `${s}是${d}的例子`;
    case "u": return `${s}基于${d}`;
    default: {
      const f = R_SENTENCE[e.pred || ""];
      return f ? f(s, d) : `${from}与${to}相关`;
    }
  }
}

// ---------- 小工具 ----------
const isThen = (v) => v && typeof v.then === "function";
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const qid = (n) => "Q" + n;

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  static less(x, y) { return x.d !== y.d ? x.d < y.d : x.h !== y.h ? x.h < y.h : x.k < y.k; }
  push(it) {
    const a = this.a; a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  peek() { return this.a[0]; }
}

/** 枢纽端点单次取边上限（按精确率） */
const HUB_EDGE_CAP = 500;
/** sqliteAccessor 单方向扫描硬上限（防止对百万边枢纽整表迭代） */
const EDGE_SCAN_CAP = 50000;

async function findCorridor(args) {
  const acc = args.accessor;
  const target = Number(args.target);
  const o = {
    maxExpand: 20000, timeoutMs: 4000, yieldEvery: 500, scope: "full",
    precisionFn: precisionOf, now: Date.now, kpIdOf: null, ...(args.opts || {})
  };
  const learnedList = [...new Set((args.learned || []).map(Number))].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const learnedSet = new Set(learnedList);
  const t0 = o.now();

  const memo = (fn) => { const m = new Map(); return async (k) => { if (m.has(k)) return m.get(k); let v = fn(k); if (isThen(v)) v = await v; m.set(k, v); return v; }; };
  const getNode = memo(async (n) => (await acc.nodeOf(n)) || null);
  const getDegree = memo((n) => acc.degreeOf(n));
  const getIsField = memo(async (n) => !!(await acc.isFieldOrDomainNode(n)));
  const getIsTopic = memo(async (n) => !!(await acc.isTopicNode(n)));
  const isEndpoint = (n) => n === target || learnedSet.has(n);

  const targetNode = await getNode(target);
  const targetKind = targetNode ? targetNode.kind : null;
  const situational = SITUATIONAL_KINDS.has(targetKind);
  const labelOf = async (n) => { const nd = await getNode(n); return (nd && nd.label) || qid(n); };
  const targetInfo = async () => ({ atlasId: qid(target), label: await labelOf(target), kind: targetKind });

  const result = async (status, extra) => ({
    status, scope: o.scope, truncated: false, target: await targetInfo(),
    nodes: [], edges: [], endpoints: [], best: null, totalPaths: 0, hiddenWeaker: 0, ...extra
  });

  if (learnedSet.has(target)) {
    return result("near", {
      nodes: [{ atlasId: qid(target), label: await labelOf(target), kind: targetKind, learned: true, kpId: o.kpIdOf ? o.kpIdOf(target) ?? null : null, pathCount: 1, dG: 0, dL: 0 }],
      endpoints: [{ kpId: o.kpIdOf ? o.kpIdOf(target) ?? null : null, atlasId: qid(target), label: await labelOf(target), pathCount: 1 }],
      best: { hops: 0, reliability: 1 }, totalPaths: 1
    });
  }

  // ---- 额外边（材料 / 用户） ----
  const extraAdj = new Map();
  for (const x of args.extraEdges || []) {
    const src = Number(x.src), dst = Number(x.dst);
    if (!Number.isFinite(src) || !Number.isFinite(dst) || src === dst) continue;
    const base = { type: x.type || "r", pred: x.pred || null, source: x.source || "material" };
    if (!extraAdj.has(src)) extraAdj.set(src, []);
    if (!extraAdj.has(dst)) extraAdj.set(dst, []);
    extraAdj.get(src).push({ dst, ...base, dir: "out" });
    extraAdj.get(dst).push({ dst: src, ...base, dir: "in" });
  }

  // ---- 节点准入（静态：学科/领域代表、种类；度数在出堆时查） ----
  const staticMemo = new Map();
  const passNodes = o.passNodes instanceof Set ? o.passNodes : null; // D342：代理条目（知识点的上级 / 也涉及 / 名称代理）不受种类准入限制
  async function staticOk(m) {
    if (isEndpoint(m) || (passNodes && passNodes.has(m))) return true;
    if (staticMemo.has(m)) return staticMemo.get(m);
    let ok = true;
    if (await getIsField(m)) ok = false;
    else {
      const nd = await getNode(m);
      if (!nd) ok = false;
      else if (BAN_KINDS.has(nd.kind) && nd.kind !== targetKind) ok = false;
    }
    staticMemo.set(m, ok);
    return ok;
  }
  const degMemo = new Map();
  async function degOk(n) {
    if (isEndpoint(n)) return true;
    if (degMemo.has(n)) return degMemo.get(n);
    const ok = (await getDegree(n)) <= HUB_DEGREE;
    degMemo.set(n, ok);
    return ok;
  }
  const genMemo = new Map();
  async function isGeneric(n) {
    if (isEndpoint(n)) return false;
    if (genMemo.has(n)) return genMemo.get(n);
    const g = !(await getIsTopic(n)) || (await getDegree(n)) > SIBLING_DEGREE;
    genMemo.set(n, g);
    return g;
  }

  // ---- 邻接（过滤 + 每个邻居保留一条最优边） ----
  const adjMemo = new Map();
  const hubMemo = new Map();
  /** 枢纽端点：度数 > HUB_DEGREE 的目标 / 已学点（D342 惰性邻接） */
  async function isHubEnd(n) {
    if (!isEndpoint(n)) return false;
    if (hubMemo.has(n)) return hubMemo.get(n);
    const h = (await getDegree(n)) > HUB_DEGREE;
    hubMemo.set(n, h);
    return h;
  }
  const lazyMode = typeof acc.edgesBetween === "function";
  /** 枢纽端点 → 尚未并入其邻接表的注入边（adj(hub) 首次构建时并入） */
  const hubPending = new Map();
  let sideOf = () => null; // 搜索开始后指向 G / L
  async function adj(n) {
    if (adjMemo.has(n)) return adjMemo.get(n);
    const hubEnd = await isHubEnd(n);
    let raw;
    if (hubEnd && lazyMode) {
      // D342：枢纽端点只直接取「与其它端点之间」的边；其余邻居由对侧惰性注入
      const others = [target, ...learnedList].filter((x) => x !== n);
      raw = acc.edgesBetween(n, others);
    } else {
      // S6 旧口径（访问器没有 edgesBetween 时）：枢纽端点只取精确率最高的前 HUB_EDGE_CAP 条边
      raw = hubEnd ? acc.edgesOf(n, { topN: HUB_EDGE_CAP, situational }) : acc.edgesOf(n);
    }
    if (isThen(raw)) raw = await raw;
    raw = raw || [];
    const ex = extraAdj.get(n);
    const all = ex ? raw.concat(ex) : raw;
    const best = new Map();
    const ctx = { situational };
    for (const e of all) {
      const m = Number(e.dst);
      if (m === n || !Number.isFinite(m)) continue;
      const p = o.precisionFn({ type: e.type, pred: e.pred, source: e.source }, ctx);
      if (p == null || !(p >= MIN_PRECISION)) continue;
      const cur = best.get(m);
      const key = `${e.type}|${e.pred || ""}|${e.source || ""}|${e.dir}`;
      if (cur && (cur.p > p || (cur.p === p && cur.key <= key))) continue;
      best.set(m, {
        m, p, w: -Math.log(p), type: e.type, pred: e.pred || null, source: e.source || null, dir: e.dir, key,
        cls: BOOK_KINDS.has(e.type) ? (e.dir === "in" ? "N" : "M") : "0" // N: 边指向本节点；M: 边指向邻居
      });
    }
    // 节点准入（kind / 学科代表 / 度数）推迟到出堆时再查，避免对每个邻居都查库
    const list = [...best.values()].sort((a, b) => a.m - b.m);
    if (hubEnd && lazyMode) {
      const pend = hubPending.get(n);
      if (pend) for (const r of pend.values()) if (!best.has(r.m)) list.push(r);
      hubPending.delete(n);
    }
    adjMemo.set(n, list);
    if (lazyMode && !hubEnd) for (const en of list) if (await isHubEnd(en.m)) await injectHub(en.m, n, en);
    return list;
  }
  /** D342：x 的边表里出现枢纽端点 E → 把反向边并入 E 的邻接，并直接在 E 一侧松弛到 x */
  async function injectHub(E, x, en) {
    const rev = {
      m: x, p: en.p, w: en.w, type: en.type, pred: en.pred, source: en.source, dir: en.dir === "in" ? "out" : "in",
      key: `${en.type}|${en.pred || ""}|${en.source || ""}|${en.dir === "in" ? "out" : "in"}`,
      cls: en.cls === "N" ? "M" : en.cls === "M" ? "N" : "0"
    };
    const memo = adjMemo.get(E);
    if (memo) { if (!memo.some((r) => r.m === x)) memo.push(rev); }
    else {
      if (!hubPending.has(E)) hubPending.set(E, new Map());
      const pm = hubPending.get(E);
      const cur = pm.get(x);
      if (!cur || cur.p < rev.p) pm.set(x, rev);
    }
    const s = sideOf(E);
    if (!s || !s.done.has(E * 2) || rev.w > BUDGET + EPS) return;
    const k = x * 2 + (await arriveFlag(rev));
    if (s.done.has(k)) return;
    const old = s.tent.get(k);
    if (old && !(rev.w < old.d - 1e-12 || (Math.abs(rev.w - old.d) <= 1e-12 && 1 < old.h))) return;
    s.tent.set(k, { d: rev.w, h: 1 });
    s.heap.push({ d: rev.w, h: 1, k });
    if (s.onTouch) s.onTouch(x, k, rev.w);
  }
  // 沿边 en 到达 m 时的状态标记
  async function arriveFlag(en) { return en.cls === "M" && !isEndpoint(en.m) && (await isGeneric(en.m)) ? 1 : 0; }

  // ---- 双侧有界 Dijkstra（状态图；交替推进 + 协作让出） ----
  // 阶段 1：按「较小半径一侧先走」交替推进，直到 rG + rL ≥ mu（mu＝松弛边时见到的最优汇合代价；无汇合则按预算），此时 best 已是精确的（D342）；
  // 阶段 2：两侧都补到半径 cap/2；
  // 阶段 3：在「两侧已落定节点的并集 U」内继续把两侧推到半径 cap（走廊上任一路径的每个节点都在 U 内），
  //         这样只做 O(|U|) 的展开，而不是把两侧各自推满整个预算。
  let halted = false;
  // 枢纽一侧尚未注入的邻居离源点至少一跳：用最强的全谱边（b 0.93）作半径下界；精确率函数被替换时保守取 0.99
  const HUB_FLOOR = -Math.log(o.precisionFn === precisionOf ? 0.93 : 0.99);
  function makeSide(sources) {
    const s = { srcSet: new Set(sources), tent: new Map(), done: new Map(), heap: new Heap(), expansions: 0, hub: false, onTouch: null };
    for (const n of sources) { s.tent.set(n * 2, { d: 0, h: 0 }); s.heap.push({ d: 0, h: 0, k: n * 2 }); }
    return s;
  }
  function radius(s) {
    while (s.heap.size) {
      const t = s.heap.peek(), cur = s.tent.get(t.k);
      if (s.done.has(t.k) || cur.d !== t.d || cur.h !== t.h) s.heap.pop(); else break;
    }
    const top = s.heap.size ? s.heap.peek().d : BUDGET;
    return s.hub ? Math.min(top, HUB_FLOOR) : top;
  }
  /** 落定并展开一个状态；返回 false＝本侧在 popLimit 内无事可做或已叫停 */
  async function step(s, popLimit, restrict, relaxLimit, onSettle, onRelax) {
    radius(s); // 丢掉堆顶的过期项
    if (!s.heap.size || s.heap.peek().d > popLimit + EPS) return false;
    if (s.expansions >= o.maxExpand || o.now() - t0 > o.timeoutMs) { halted = true; return false; }
    const top = s.heap.pop();
    const n = Math.floor(top.k / 2), f = top.k - n * 2;
    const isSrc = s.srcSet.has(n);
    if (restrict && !restrict.has(n)) return true;
    if (!isSrc && !((await staticOk(n)) && (await degOk(n)))) return true;
    s.done.set(top.k, { d: top.d, h: top.h });
    s.expansions++;
    if (onSettle) onSettle(n, f, top);
    if (o.yieldEvery > 0 && s.expansions % o.yieldEvery === 0) await new Promise((r) => setImmediate(r));
    if (!isSrc && isEndpoint(n)) return true; // 对侧终点：只落脚，不穿过
    for (const en of await adj(n)) {
      if (f === 1 && en.cls === "N") continue; // 兄弟剪枝
      if (restrict && !restrict.has(en.m)) continue;
      const nd = top.d + en.w;
      if (nd > relaxLimit + EPS) continue;
      const key = en.m * 2 + (await arriveFlag(en));
      if (s.done.has(key)) continue;
      const old = s.tent.get(key), nh = top.h + 1;
      if (old && !(nd < old.d - 1e-12 || (Math.abs(nd - old.d) <= 1e-12 && nh < old.h))) continue;
      s.tent.set(key, { d: nd, h: nh });
      s.heap.push({ d: nd, h: nh, k: key });
      if (onRelax) onRelax(en.m, key, nd);
    }
    return true;
  }

  const G = makeSide([target]);
  const L = makeSide(learnedList);
  G.hub = lazyMode && (await isHubEnd(target));
  {
    let any = false;
    for (const l of learnedList) if (await isHubEnd(l)) { any = true; break; }
    L.hub = lazyMode && any;
  }
  sideOf = (E) => (E === target ? G : learnedSet.has(E) ? L : null);
  let mu = null;
  /** 状态 (n, f) 在一侧落定 / 被松弛到距离 d 时，与对侧已落定的同节点状态拼成一条路径 */
  const tryMeet = (other, n, f, d) => {
    for (let g = 0; g < 2; g++) {
      if (f === 1 && g === 1) continue;
      const v = other.done.get(n * 2 + g);
      if (!v) continue;
      const tot = d + v.d;
      if (tot > BUDGET + EPS) continue;
      if (!mu || tot < mu.d - 1e-12) mu = { d: tot };
    }
  };
  const meet = (isG) => (n, f, t) => tryMeet(isG ? L : G, n, f, t.d);
  const relaxMeet = (isG) => (m, key, d) => tryMeet(isG ? L : G, m, key - m * 2, d);
  G.onTouch = (m, key, d) => tryMeet(L, m, key - m * 2, d);
  L.onTouch = (m, key, d) => tryMeet(G, m, key - m * 2, d);
  // 经典双向 Dijkstra：边松弛时检测相遇 → rG + rL ≥ mu 时 mu 已是最优（任一更短路径必有一条边两端分属两侧已落定区）
  while (!halted) {
    const rG = radius(G), rL = radius(L);
    // 两侧源点至少各展开一次（枢纽端点的边表不对称：只看一侧会漏掉只登记在另一侧的直连）
    const fresh = !G.expansions || !L.expansions;
    if (!fresh && rG + rL >= (mu ? mu.d : BUDGET) - EPS) break;
    const useG = !G.expansions ? true : !L.expansions ? false : rG <= rL;
    if (await step(useG ? G : L, BUDGET, null, BUDGET, meet(useG), relaxMeet(useG))) continue;
    if (halted) break;
    // 选中的一侧暂时无事可做（枢纽一侧在等注入）→ 换另一侧；两侧都停才结束
    if (!(await step(useG ? L : G, BUDGET, null, BUDGET, meet(!useG), relaxMeet(!useG)))) break;
  }
  if (mu && !halted) {
    const half = Math.min(mu.d + DELTA, BUDGET) / 2;
    for (const s of [G, L]) while (!halted && (await step(s, half, null, BUDGET))) { /* 补满半径 cap/2 */ }
    if (!halted) {
      const capNow = Math.min(mu.d + DELTA, BUDGET);
      const U = new Set();
      for (const s of [G, L]) for (const k of s.done.keys()) U.add(Math.floor(k / 2));
      for (const s of [G, L]) while (!halted && (await step(s, capNow, U, capNow))) { /* 在 U 内推到 cap */ }
    }
  }
  const truncated = halted;
  const dG = G.done, dL = L.done;

  const far = async () => {
    const r = await result("far", { truncated });
    r.ladder = await buildLadder();
    return r;
  };

  // ---- 最优路径 ----
  let best = null;
  const pairs = []; // [n, a, g, total, hops]
  for (const [kL, vL] of dL) {
    const n = Math.floor(kL / 2), a = kL - n * 2;
    for (let g = 0; g < 2; g++) {
      if (a === 1 && g === 1) continue;
      const vG = dG.get(n * 2 + g);
      if (!vG) continue;
      const tot = vL.d + vG.d, hops = vL.h + vG.h;
      pairs.push([n, a, g, tot, hops]);
      if (!best || tot < best.d - 1e-12 || (Math.abs(tot - best.d) <= 1e-12 && (hops < best.h || (hops === best.h && n < best.n)))) best = { d: tot, h: hops, n };
    }
  }
  if (!best || best.d > BUDGET + EPS) return far();
  const cap = Math.min(best.d + DELTA, BUDGET) + EPS;

  const gMin = new Map(), lMin = new Map();
  for (const [k, v] of dG) { const n = Math.floor(k / 2); const c = gMin.get(n); if (c === undefined || v.d < c) gMin.set(n, v.d); }
  for (const [k, v] of dL) { const n = Math.floor(k / 2); const c = lMin.get(n); if (c === undefined || v.d < c) lMin.set(n, v.d); }
  const cand = new Set();
  for (const [n, , , tot] of pairs) if (tot <= cap) cand.add(n);

  // ---- 走廊边（定向成 DAG） ----
  const cedges = []; // {x, y, en}
  const candList = [...cand].sort((a, b) => a - b);
  for (const x of candList) {
    if (x === target) continue;
    const gx = gMin.get(x);
    for (const en of await adj(x)) {
      const y = en.m;
      if (!cand.has(y) || learnedSet.has(y)) continue;
      if (!(gMin.get(y) < gx - 1e-12)) continue;
      const yFlag = await arriveFlag(en);
      let ok = false;
      for (let a = 0; a < 2 && !ok; a++) {
        if (a === 1 && en.cls === "N") continue;
        const vL = dL.get(x * 2 + a);
        if (!vL) continue;
        for (let g = 0; g < 2; g++) {
          if (yFlag === 1 && g === 1) continue;
          const vG = dG.get(y * 2 + g);
          if (!vG) continue;
          if (vL.d + en.w + vG.d <= cap) { ok = true; break; }
        }
      }
      if (ok) cedges.push({ x, y, en, yFlag, xFlag: (en.cls === "N" && !isEndpoint(x) && (await isGeneric(x))) ? 1 : 0, count: 0, weak: false });
    }
  }

  // ---- DAG 上的路径计数（A 前向 / B 后向；下标＝边方向上是否「指向本节点的 b|e 且本节点泛类」） ----
  const nodeSet = new Set([target]);
  for (const e of cedges) { nodeSet.add(e.x); nodeSet.add(e.y); }
  for (const l of learnedList) if (cand.has(l)) nodeSet.add(l);
  const order = [...nodeSet].sort((a, b) => (gMin.get(b) - gMin.get(a)) || (a - b));
  const A = new Map(), B = new Map(), AP = new Map(), BP = new Map();
  for (const n of nodeSet) { A.set(n, [0, 0]); B.set(n, [0, 0]); AP.set(n, 0); BP.set(n, 0); }
  for (const l of learnedList) if (A.has(l)) A.get(l)[0] = 1;
  B.get(target)[0] = 1;
  const outOf = new Map();
  for (const e of cedges) { if (!outOf.has(e.x)) outOf.set(e.x, []); outOf.get(e.x).push(e); }
  for (const x of order) {
    for (const e of outOf.get(x) || []) {
      const ax = A.get(x);
      // 若本边指向 x 且 x 泛类，则以「指向 x 的 b|e」到达 x 的前缀（A[1]）不能接这条边
      const S = e.xFlag === 1 ? ax[0] : ax[0] + ax[1];
      e.sa = S;
      A.get(e.y)[e.yFlag] += S;
      if (e.en.cls === "M") AP.set(e.y, AP.get(e.y) + S);
    }
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const x = order[i];
    for (const e of outOf.get(x) || []) {
      const by = B.get(e.y);
      const T = e.yFlag === 1 ? by[0] : by[0] + by[1];
      e.sb = T;
      e.count = e.sa * T;
      B.get(x)[e.xFlag] += T;
      if (e.en.cls === "N") BP.set(x, BP.get(x) + T);
    }
  }
  const pathCount = (n) => {
    const a = A.get(n), b = B.get(n);
    return a[0] * (b[0] + b[1]) + a[1] * b[0];
  };
  const totalPaths = A.get(target)[0] + A.get(target)[1];
  if (!(totalPaths > 0)) return far();

  // 弱连接：在非泛类的主题节点上汇合（两条 b|e 都指向它）
  for (const e of cedges) {
    if (!(e.count > 0)) continue;
    if (e.en.cls === "M" && !learnedSet.has(e.y) && e.y !== target && !(await isGeneric(e.y)) && BP.get(e.y) > 0 && AP.get(e.y) > 0) e.weak = true;
    if (e.en.cls === "N" && !isEndpoint(e.x) && !(await isGeneric(e.x)) && AP.get(e.x) > 0 && BP.get(e.x) > 0) e.weak = true;
  }

  // ---- 显示裁剪 ----
  const live = [...nodeSet].filter((n) => pathCount(n) > 0);
  const forced = new Set(live.filter((n) => isEndpoint(n)));
  const score = (n) => pathCount(n) * Math.exp(-(gMin.get(n) + lMin.get(n)));
  const mids = live.filter((n) => !forced.has(n)).sort((a, b) => (score(b) - score(a)) || (a - b));
  const room = Math.max(0, DISPLAY_NODES - forced.size);
  const shown = new Set([...forced, ...mids.slice(0, room)]);
  const hiddenWeaker = mids.length - Math.min(mids.length, room);

  const nodes = [];
  for (const n of shown) {
    const nd = await getNode(n);
    nodes.push({
      atlasId: qid(n), label: (nd && nd.label) || qid(n), kind: nd ? nd.kind : null,
      learned: learnedSet.has(n), ...(learnedSet.has(n) ? { kpId: o.kpIdOf ? o.kpIdOf(n) ?? null : null } : {}),
      pathCount: pathCount(n), dG: r6(gMin.get(n)), dL: r6(lMin.get(n))
    });
  }
  nodes.sort((a, b) => (b.dG - a.dG) || (a.atlasId < b.atlasId ? -1 : a.atlasId > b.atlasId ? 1 : 0));
  const labels = new Map(nodes.map((n) => [n.atlasId, n.label]));
  const edges = [];
  for (const e of cedges) {
    if (!(e.count > 0) || !shown.has(e.x) || !shown.has(e.y)) continue;
    const from = qid(e.x), to = qid(e.y);
    edges.push({
      from, to, type: e.en.type, pred: e.en.pred, p: e.en.p, source: e.en.source, dir: e.en.dir,
      sentence: sentenceOf({ type: e.en.type, pred: e.en.pred, dir: e.en.dir, fromLabel: labels.get(from), toLabel: labels.get(to) }),
      weak: e.weak
    });
  }
  edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  const endpoints = nodes.filter((n) => n.learned).map((n) => ({ kpId: n.kpId ?? null, atlasId: n.atlasId, label: n.label, pathCount: n.pathCount }))
    .sort((a, b) => (b.pathCount - a.pathCount) || (a.atlasId < b.atlasId ? -1 : 1));

  return result(best.h <= 2 ? "near" : "reachable", {
    truncated, nodes, edges, endpoints,
    best: { hops: best.h, reliability: r6(Math.exp(-best.d)) },
    totalPaths, hiddenWeaker
  });

  // ---- 「远」档：落脚点阶梯 ----
  async function buildLadder() {
    const ladder = { breadcrumb: [], learnedInField: [], entries: [] };
    if (!targetNode) return ladder;
    const field = targetNode.field ?? null;
    let fi = null;
    if (field != null && typeof acc.fieldInfo === "function") { fi = acc.fieldInfo(field); if (isThen(fi)) fi = await fi; }
    if (fi && fi.domainLabel) ladder.breadcrumb.push({ level: "domain", label: fi.domainLabel, atlasId: null });
    if (fi && fi.label) ladder.breadcrumb.push({ level: "field", label: fi.label, atlasId: field > 0 ? qid(field) : null });
    const topicId = targetNode.topic != null ? targetNode.topic : null;
    if (topicId != null) ladder.breadcrumb.push({ level: "topic", label: await labelOf(topicId), atlasId: qid(topicId) });
    else if (targetNode.kind === "concept") ladder.breadcrumb.push({ level: "topic", label: await labelOf(target), atlasId: qid(target) });
    if (field != null) {
      for (const l of learnedList) {
        if (ladder.learnedInField.length >= 5) break;
        const nd = await getNode(l);
        if (nd && nd.field === field) ladder.learnedInField.push({ kpId: o.kpIdOf ? o.kpIdOf(l) ?? null : null, atlasId: qid(l), label: nd.label || qid(l) });
      }
    }
    if (typeof acc.topEntries === "function") {
      let es = acc.topEntries({ topic: topicId != null ? topicId : target, field, limit: 5, exclude: target });
      if (isThen(es)) es = await es;
      for (const e of (es || []).slice(0, 5)) ladder.entries.push({ atlasId: qid(e.id), label: e.label || qid(e.id), taughtIn: [] });
    }
    return ladder;
  }
}

// ---------- better-sqlite3 访问器（全谱 schema） ----------
class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { if (!this.m.has(k)) return undefined; const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v; }
  set(k, v) { if (this.m.has(k)) this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
}

function sqliteAccessor(db, opts = {}) {
  const skip = opts.skipPreds || EXCLUDED_PREDS;
  const mark = skip.map(() => "?").join(",");
  const filt = skip.length ? ` AND (type != 'r' OR pred IS NULL OR pred NOT IN (${mark}))` : "";
  const outQ = db.prepare(`SELECT dst AS o, type, pred, source FROM edge WHERE src = ?${filt}`);
  const inQ = db.prepare(`SELECT src AS o, type, pred, source FROM edge WHERE dst = ?${filt}`);
  const pairQ = db.prepare(`SELECT type, pred, source FROM edge WHERE src = ? AND dst = ?${filt}`);
  const nodeQ = db.prepare("SELECT id, kind, field, topic, zh, en FROM node WHERE id = ?");
  const degOutQ = db.prepare("SELECT COUNT(*) AS c FROM edge WHERE src = ?");
  const degInQ = db.prepare("SELECT COUNT(*) AS c FROM edge WHERE dst = ?");
  const nodeCache = new LRU(opts.nodeCache || 200000), degCache = new LRU(opts.degCache || 100000);
  let fieldSet = null, topicSet = null;
  const nodeOf = (id) => {
    let v = nodeCache.get(id);
    if (v !== undefined) return v;
    const r = nodeQ.get(id);
    v = r ? { id: r.id, kind: r.kind, topic: r.topic, field: r.field, label: r.zh || r.en || null } : null;
    nodeCache.set(id, v);
    return v;
  };
  return {
    /** opts.topN：只返回精确率最高的前 N 条（S6；situational 决定情境谓词是否计分）；每个方向最多扫描 EDGE_SCAN_CAP 行 */
    edgesOf(id, eo) {
      const topN = eo && Number(eo.topN) > 0 ? Number(eo.topN) : 0;
      const out = [];
      if (!topN) {
        for (const r of outQ.all(id, ...skip)) out.push({ dst: r.o, type: r.type, pred: r.pred, dir: "out", source: r.source });
        for (const r of inQ.all(id, ...skip)) out.push({ dst: r.o, type: r.type, pred: r.pred, dir: "in", source: r.source });
        return out;
      }
      const ctx = { situational: !!(eo && eo.situational) };
      const scored = [];
      const take = (q, dir) => {
        let seen = 0;
        for (const r of q.iterate(id, ...skip)) { // sync-iterate-ok（循环体内无 await）
          if (++seen > EDGE_SCAN_CAP) break;
          const p = precisionOf({ type: r.type, pred: r.pred, source: r.source }, ctx);
          if (p == null) continue;
          scored.push({ p, e: { dst: r.o, type: r.type, pred: r.pred, dir, source: r.source } });
        }
      };
      take(outQ, "out");
      take(inQ, "in");
      scored.sort((a, b) => b.p - a.p || a.e.dst - b.e.dst);
      for (const x of scored.slice(0, topN)) out.push(x.e);
      return out;
    },
    /** D342：本节点与 others 之间的边（两个方向）；枢纽端点靠它取「端点—端点」直连，不扫自己的整张边表 */
    edgesBetween(id, others) {
      const out = [];
      for (const o of others || []) {
        if (o === id) continue;
        for (const r of pairQ.all(id, o, ...skip)) out.push({ dst: o, type: r.type, pred: r.pred, dir: "out", source: r.source });
        for (const r of pairQ.all(o, id, ...skip)) out.push({ dst: o, type: r.type, pred: r.pred, dir: "in", source: r.source });
      }
      return out;
    },
    nodeOf,
    degreeOf(id) {
      let v = degCache.get(id);
      if (v !== undefined) return v;
      v = degOutQ.get(id).c + degInQ.get(id).c;
      degCache.set(id, v);
      return v;
    },
    isFieldOrDomainNode(id) {
      if (!fieldSet) fieldSet = new Set(db.prepare("SELECT id FROM field WHERE id > 0").all().map((r) => r.id));
      return fieldSet.has(id);
    },
    isTopicNode(id) {
      if (!topicSet) topicSet = new Set(db.prepare("SELECT DISTINCT topic FROM node WHERE topic IS NOT NULL").all().map((r) => r.topic));
      return topicSet.has(id);
    },
    fieldInfo(fieldId) {
      const f = db.prepare("SELECT f.id, f.en, d.zh AS dz FROM field f LEFT JOIN domain d ON d.id = f.domain WHERE f.id = ?").get(fieldId);
      if (!f) return null;
      const nd = f.id > 0 ? nodeOf(f.id) : null;
      return { label: (nd && nd.label) || f.en || null, domainLabel: f.dz || null };
    },
    // 只查主题级（node_topic 索引）；不再回落到整个学科——800 万节点上的全表扫描会卡主进程
    topEntries({ topic, limit = 5, exclude }) {
      if (topic == null) return [];
      return db.prepare("SELECT id, zh, en FROM node WHERE topic = ? AND kind = 'concept' AND id != ? ORDER BY rank DESC, id LIMIT ?")
        .all(topic, exclude == null ? -1 : exclude, limit).map((r) => ({ id: r.id, label: r.zh || r.en || null }));
    }
  };
}

module.exports = { findCorridor, sentenceOf, sqliteAccessor, BAN_KINDS, SITUATIONAL_KINDS, BUDGET, DELTA, SIBLING_DEGREE, DISPLAY_NODES };
