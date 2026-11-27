// v49.137 / D304 知识图谱渲染层公共件（设计稿 docs/design/KNOWLEDGE-GRAPH-DESIGN.md §8 / §9）。
// 事实与派生只在主进程（electron/kgCore.js）计算；这里只做三件事：
//   1) 类型契约（皮肤接口 §8.2–§8.4）；
//   2) 回放折叠：按主进程给的「节点静态史 + 按日关键帧」把时刻 t 折叠成快照——不另算任何事实；
//   3) 节拍：事件按学习时段分拍（v49.143 / D310）；布局交给 src/lib/kgForce.ts 的实时力模拟（§8.6 位置持久化已推翻）。

export type Facet = "definition" | "why" | "example" | "contrast" | "relation";
export const FACETS: Facet[] = ["definition", "why", "example", "contrast", "relation"];
export type NodeState = "ghost" | "outline" | "lit" | "solid" | "firm" | "fading" | "archived";
export type EdgeGroup = "prerequisite" | "hierarchy" | "contrast" | "support" | "analogy";

export interface GraphNode {
  id: string;
  label: string;
  definition: string;
  defVersion: number;
  /** hub＝全谱主题集群中心（v49.143 / D311，只在图谱页合成，不进快照事实） */
  kind: "concept" | "principle" | "method" | "fact" | "hub";
  state: NodeState;
  retention: number;
  stability: number;
  depth: number;
  facets: Record<Facet, "none" | "pending" | "passed">;
  confidence: "low" | "medium" | "high";
  due: boolean;
  dailyCost: number;
  litAt: number | null;
  anchorId: string | null;
  themeId: string | null;
  /** v49.143 / D311：对应的全谱节点（"Q123"）；私有或未映射为 null */
  atlasId?: string | null;
  /** v49.145 / D313：私有知识点的全谱上级；「也涉及」的全谱节点 */
  atlasParent?: string | null;
  atlasAlso?: string[];
  /** v49.149 / D318：「译名分化」——atlasParent 是同一外语词的另一义项（而非上级概念） */
  atlasSplit?: string[];
  cardCount: number;
  extractCount: number;
  /** v49.170 / D340：证据阶梯第 1 级——读过讲了它的单元（unit_reads × source_terms） */
  readExplained?: boolean;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  group: EdgeGroup;
  /** confirmed＝用户确认（实线）；suggested＝推断（淡色细线，v49.148 / D317） */
  status: "confirmed" | "suggested";
  strength: number;
  /** v49.148 / D317：三层证据计数（世界 / 材料 / 你的） */
  layers?: { w: number; m: number; u: number };
  /** 已确认但还没有你写的说明 */
  unexplained?: boolean;
  /** 解除过、因新证据重新出现 */
  resurfaced?: { at: number; count: number } | null;
}

/** v49.148 / D317 关系面板的证据明细（kg:edgeEvidence） */
export type EdgeAnchor = KpAppearanceMaterial["anchor"];
/** v49.170 / D340：论证边（P1–P5）的一条证据——作者在原文里的两处引句；code 为空＝同块（P1 / P5 同块） */
export interface EdgeArgEvidence {
  kind: "arg";
  rule: "P1" | "P2" | "P3" | "P4" | "P5";
  /** 支 | 据 | 推 | 因 | 比 | 驳 | 例；同块规则为 "" */
  code: string;
  /** 推出 / 导致 / 反驳（只有 P2 推因、P4 有） */
  pred: string | null;
  documentId: string;
  title: string;
  mapId: string;
  fromNodeId: string;
  toNodeId: string;
  /** 兼容旧面板的「跳节点」入口：＝ toNodeId */
  nodeId: string;
  /** [fromNode 的标题, toNode 的标题] */
  path: string[];
  quoteA: string;
  quoteB: string;
  blockA: number;
  blockB: number;
  /** quoteA / quoteB 所讲（或所用）的知识点 id */
  kpA: string;
  kpB: string;
  isNew: boolean;
}
export interface EdgeEvidence {
  a: { id: string; label: string };
  b: { id: string; label: string };
  state: "confirmed" | "inferred" | "dismissed" | "none";
  confirmed: { id: string; type: string; from: string; to: string; createdAt: number }[];
  inferred: { type: string; from: string; to: string } | null;
  /** v49.153 / D322：pred 只来自全谱情境边（e/u/r），显示为「全谱：A 与 B——<pred>」 */
  world: { type: string; from: string; to: string; pred?: string | null }[];
  material: (
    | { kind: "map" | "node"; documentId: string; title: string; mapId: string; nodeId: string; path: string[]; isNew: boolean }
    | EdgeArgEvidence
    | { kind: "extract"; extractId: string; documentId: string; title: string; snippet: string; anchor: EdgeAnchor; isNew: boolean }
  )[];
  /** v49.153 / D322 / T3：M4 摘录原文同时提到两端（t:）；snippet 为前 60 字 */
  text: { kind: "text" | "textBoth"; extractId: string; documentId: string | null; title: string; snippet: string; anchor: EdgeAnchor | null; isNew: boolean }[];
  /** v49.153 / D322 / T3：AI 写的卡片正文提到（c:，弱证据） */
  cardText: { kind: "card"; cardId: string; isNew: boolean }[];
  ai: { type: string; from: string; to: string; quote: string; isNew: boolean }[];
  mine: (
    | { kind: "explain"; ts: number; text: string; rating: string | null; kpId: string; isNew: boolean }
    | { kind: "annotation"; extractId: string; documentId: string; title: string; text: string; anchor: EdgeAnchor; isNew: boolean }
    | { kind: "def"; kpId: string; text: string; ts: number; isNew: boolean }
    | { kind: "card"; cardId: string; isNew: boolean }
  )[];
  dismissal: { at: number; count: number } | null;
}
export interface ConnectResult {
  relationId: string;
  created: boolean;
  eventId: string | null;
  undo: { relationId: string | null; eventId: string | null; dismissalIds: string[]; judgmentIds: string[] };
}
export interface DismissUndo {
  a: string;
  b: string;
  relationIds: string[];
  judgmentIds: string[];
  prev: { keysJson: string; count: number; at: number; deleted: boolean } | null;
}
/** v49.148 / D317 复习页关系提问的选题 */
export interface RelationAsk {
  edgeId: string;
  status: "confirmed" | "suggested";
  type: string;
  from: string;
  to: string;
  other: { id: string; label: string; definition: string };
}
export interface GraphTheme { id: string; label: string; nodeIds: string[]; domain: string }
export interface GraphSnapshot {
  at: number;
  lmVersion: string;
  summary: { lit: number; fading: number; outline: number; dailyCost: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  themes: GraphTheme[];
}
export type GraphEvent =
  | { t: number; kind: "lit"; nodeId: string; anchorId: string | null }
  | { t: number; kind: "facet_passed"; nodeId: string; facet: Facet }
  | { t: number; kind: "level_up"; nodeId: string; to: "solid" | "firm" }
  | { t: number; kind: "fade"; nodeId: string }
  | { t: number; kind: "restore"; nodeId: string }
  | { t: number; kind: "edge_confirmed"; edgeId: string }
  | { t: number; kind: "def_revised"; nodeId: string; version: number }
  | { t: number; kind: "merged"; fromId: string; intoId: string }
  | { t: number; kind: "split"; fromId: string; newId: string }
  | { t: number; kind: "archived"; nodeId: string };

export interface NodeHistory {
  createdAt: number;
  firstReviewAt: number | null;
  litAt: number | null;
  archivedAt: number | null;
  levels: [number, number][];
  facets: Partial<Record<Facet, number>>;
}
export interface TodaySummary { from: number; to: number; lit: number; refreshed: number; facets: number; edges: number; levelUps: number; events: GraphEvent[] }
export interface GraphBundle {
  snapshot: GraphSnapshot;
  start: number;
  events: GraphEvent[];
  keyframes: { dayEnds: number[]; nodes: Record<string, { r: number[]; f: number[] }> } | null;
  today: TodaySummary;
  history: Record<string, NodeHistory> | null;
  /** v49.148 / D317：只在一份材料导图里出现过的对子（不画线），节点详情里列为「可能相关」 */
  maybe?: Record<string, string[]>;
  /** v49.170 / D340：读过讲了、但还不是知识点的全谱术语（≤200，按出现材料数降序）；「显示读过的」画成空心轮廓 */
  readTerms?: ReadTerm[];
  /** v49.154 / D323 / A3：世界层完整性（incomplete＝未能取到完整关系的挂靠节点数） */
  world?: { complete: boolean; incomplete: number };
}

/** 交互意图（§8.4）：渲染器只发意图，由宿主执行 */
export type GraphIntent =
  | { kind: "focus"; nodeId: string | null }
  | { kind: "open"; nodeId: string }
  | { kind: "review"; nodeIds: string[] }
  | { kind: "scrub"; t: number }
  | { kind: "play"; from: number; to: number };

export interface KpPanelData {
  kp: { id: string; label: string; aliases: string[]; definition: string };
  facet: Facet | null;
  hideNameBeforeFlip: boolean;
  node: GraphNode | null;
  versions: { id: string; seq: number; body: string; author: string; reason: string; createdAt: number }[];
  siblings: { id: string; facet: Facet | null; front: string }[];
  neighbors: { id: string; label: string; definition: string; type: string; group: EdgeGroup; status: string; outgoing: boolean }[];
  linkTerms: { id: string; term: string; label: string; definition: string }[];
  /** v49.148 / D317：这张卡翻面后可以问的一对关系（无则 null） */
  relationAsk?: RelationAsk | null;
}

/** D314（T1）：知识点「出现在」——来自哪些材料（maps 留给 T4） */
export interface KpAppearanceMaterial {
  documentId: string | null;
  title: string;
  cardCount: number;
  cardId: string;
  anchor: { anchorText: string; anchorRatio?: number; cfi?: string; chapterIndex?: number; pageIndex?: number; imageAnchor?: { alt?: string; contextText?: string } } | null;
}
export interface KpMapAppearance {
  mapId: string;
  documentId: string;
  title: string;
  nodes: { nodeId: string; title: string; path: string[]; blockStart: number | null; source: "ai" | "user" | "match"; atlasIds: string[] }[];
  /** 仅 kg:appearances：该知识点在此材料没有任何卡片 */
  unCarded?: boolean;
}
export interface KpAppearances { materials: KpAppearanceMaterial[]; maps: KpMapAppearance[] }

// v49.170 / D340 / I6：原文术语
export interface ReadTerm { atlasId: string; label: string; documentIds: string[] }
export type SourceTermRole = "defines" | "explains" | "argues" | "uses" | "instance";
export interface SourceTermItem {
  termId: string;
  surface: string;
  /** 已链接 / 用户确认时为 "Q…"，否则 null */
  atlasId: string | null;
  /** 已链接时是全谱名称，否则是术语写法 */
  label: string;
  role: SourceTermRole;
  quote: string;
  linkState: "linked" | "unlinked" | "user";
}
export interface SourceTermsNode {
  nodeId: string;
  /** 该节点所在的导图单元锚（会话就绪时取引擎，否则取区间内术语行，都没有 null） */
  unitAnchor: string | null;
  lowDensity: boolean;
  taught: SourceTermItem[];
  used: SourceTermItem[];
}
export interface SourceTermsForMap { documentId: string | null; nodes: SourceTermsNode[] }
export interface TermAppearance {
  documentId: string;
  title: string;
  blockNo: number;
  quote: string;
  role: SourceTermRole;
  nodePath: string[];
  mapId: string | null;
  nodeId: string | null;
  /** 该单元读过（unit_reads） */
  read: boolean;
}
export interface TermAppearances { taught: TermAppearance[]; used: TermAppearance[] }
export interface WorkAnchorCandidate { atlasId: number; id: string; label: string; gloss: string; kind: "work" | "person" }
export interface WorkAnchorProposal {
  documentId: string;
  title: string;
  author: string;
  works: WorkAnchorCandidate[];
  persons: WorkAnchorCandidate[];
  confirmed: { surface: string; atlasId: string | null; linkState: string }[];
}

// KG-SG-IMPL-PLAN §5.2：到目标全谱节点的关联路径走廊（electron/atlasPath.js findCorridor 的返回形状）
export interface PathNode { atlasId: string; label: string; kind: string | null; learned: boolean; kpId?: string | null; pathCount: number; dG: number; dL: number }
export interface PathEdge { from: string; to: string; type: string; pred: string | null; p: number; source: string; dir: "out" | "in"; sentence: string; weak?: boolean }
export interface PathEndpoint { kpId: string | null; atlasId: string; label: string; pathCount: number }
export interface PathLadder {
  breadcrumb: { level: "domain" | "field" | "topic"; label: string; atlasId: string | null }[];
  learnedInField: { kpId: string | null; atlasId: string; label: string }[];
  entries: { atlasId: string; label: string; taughtIn: unknown[] }[];
}
export interface PathCorridor {
  status: "near" | "reachable" | "far" | "unavailable";
  scope?: "full" | "core";
  truncated?: boolean;
  target?: { atlasId: string; label: string; kind: string | null };
  nodes?: PathNode[];
  edges?: PathEdge[];
  endpoints?: PathEndpoint[];
  best?: { hops: number; reliability: number } | null;
  totalPaths?: number;
  hiddenWeaker?: number;
  ladder?: PathLadder;
  /** I11：待确认的 AI 补链（只展示，不进搜索；接受后成为用户边） */
  aiChains?: PathAiChain[];
}
export interface PathAiHop { from: string; to: string; rel: string; basis: string; fromLabel: string; toLabel: string }
export interface PathAiChain { id: string; hops: PathAiHop[] }
export interface PathProposal { id: string; status: "pending" | "accepted" | "rejected"; target: string; hops: { from: string; to: string; rel: string; basis: string }[]; model: string | null; createdAt: number }
export interface PathJudgeResult {
  status: "proposed" | "none" | "invalid" | "no-ai";
  proposal?: PathProposal | null;
  reason?: string;
  reasons?: string[];
}

interface KgApi {
  graph(opts?: { history?: boolean }): Promise<GraphBundle>;
  snapshotAt(t: number): Promise<GraphSnapshot>;
  today(): Promise<TodaySummary>;
  pathToLearned(atlasId: string | number, opts?: { maxExpand?: number }): Promise<PathCorridor>;
  pathJudge(atlasId: string | number): Promise<PathJudgeResult>;
  pathProposals(atlasId: string | number): Promise<PathProposal[]>;
  pathProposalDecide(id: string, decision: "accept" | "reject"): Promise<PathProposal>;
  cardPanel(cardId: string): Promise<KpPanelData | null>;
  appearances(kpId: string): Promise<KpAppearances>;
  atlasAppearances(atlasId: string): Promise<{ maps: KpMapAppearance[] }>;
  atlasReport(payload: { atlasId: string; kind: string; note?: string }): Promise<{ channel: "post" | "github" | "none"; ok: boolean; error?: string }>;
  onMapLinkChanged(cb: (p: { mapId: string }) => void): () => void;
  unitRead(documentId: string, unitAnchor: string, dwellMs: number): Promise<{ ok: boolean; recorded: boolean }>;
  sourceTermsForce(documentId: string, unitAnchor: string): Promise<{ ok: boolean }>;
  sourceTermsForMap(mapId: string): Promise<SourceTermsForMap>;
  termAppearances(atlasId: string | number): Promise<TermAppearances>;
  sourceTermReject(termId: string): Promise<{ ok: boolean; documentId?: string }>;
  sourceTermLink(termId: string, atlasId: string | number | null): Promise<{ ok: boolean; documentId?: string; linkState?: "user" | "unlinked" }>;
  workAnchor(documentId: string): Promise<WorkAnchorProposal>;
  workAnchorConfirm(documentId: string, atlasId: string | number | null, surface: string): Promise<{ ok: boolean; atlasId: number | null; linkState: "user" | "rejected" }>;
  onSourceTermsChanged(cb: (p: { documentId: string }) => void): () => void;
  mapLinkRefsForMap(mapId: string): Promise<{ nodeId: string; atlasId: string; label: string | null; source: "ai" | "user" | "match"; confidence: number | null }[]>;
  mapLinkRefsForAtlas(ids: string[]): Promise<{ atlasId: string; mapId: string; nodeId: string; source: string; documentId: string; mapTitle: string }[]>;
  mapLinkSetUserRef(mapId: string, nodeId: string, atlasId: string, on: boolean): Promise<boolean>;
  defVersions(kpId: string): Promise<KpPanelData["versions"]>;
  reviseDefinition(kpId: string, payload: { body: string; reason: string; author?: string }): Promise<unknown>;
  revertDefinition(kpId: string, seq: number): Promise<unknown>;
  archive(kpId: string): Promise<unknown>;
  restore(kpId: string): Promise<unknown>;
  setFacet(cardId: string, facet: Facet | null): Promise<unknown>;
  moveCard(cardId: string, kpId: string | null): Promise<unknown>;
  // v49.148 / D317 连线三层
  edgeEvidence(a: string, b: string): Promise<EdgeEvidence | null>;
  connectPair(payload: { fromId: string; toId: string; type?: string; explanation?: string; selfRating?: "clear" | "partial" | "stuck"; source?: string }): Promise<ConnectResult>;
  undoConnect(undo: ConnectResult["undo"]): Promise<boolean>;
  dismissPair(a: string, b: string): Promise<{ undo: DismissUndo; worldOnly: boolean }>;
  undoDismiss(undo: DismissUndo): Promise<boolean>;
  updateRelation(id: string, patch: { type?: string; reverse?: boolean }): Promise<unknown>;
  explainPair(payload: { kpId: string; relatedKpId: string; text: string; selfRating?: "clear" | "partial" | "stuck"; source?: string }): Promise<{ eventId: string }>;
  relationAsked(a: string, b: string, outcome: "answered" | "skipped" | "unrelated"): Promise<boolean>;
}
export function kgApi(): KgApi | null {
  return ((window as unknown as { kgAPI?: KgApi }).kgAPI) ?? null;
}

// ---------------- 回放折叠（只插值，不算事实） ----------------

const LEVEL_STATE: Record<number, NodeState> = { 2: "lit", 3: "solid", 4: "firm" };

function dayIndexOf(dayEnds: number[], t: number): number {
  let lo = 0;
  let hi = dayEnds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dayEnds[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, dayEnds.length - 1);
}

/**
 * 时刻 t 的回放快照：可见性 / 状态 / 保持度全部取自主进程给的节点史与关键帧（§9.1「动画是事件流的纯回放」）。
 * t ≥ 快照时刻时直接返回当前快照（LM-1 当前态是唯一真源）。
 */
export function foldAt(bundle: GraphBundle, t: number): GraphSnapshot {
  const snap = bundle.snapshot;
  if (t >= snap.at || !bundle.history || !bundle.keyframes) return snap;
  const kf = bundle.keyframes;
  const di = kf.dayEnds.length ? dayIndexOf(kf.dayEnds, t) : -1;
  const nodes: GraphNode[] = [];
  for (const n of snap.nodes) {
    const h = bundle.history[n.id];
    if (!h || h.createdAt > t) continue;
    let lv = 0;
    for (const [lt, l] of h.levels) {
      if (lt > t) break;
      lv = l;
    }
    if (lv === 0 && (n.cardCount || n.extractCount)) lv = 1;
    const frame = di >= 0 ? kf.nodes[n.id] : undefined;
    const rRaw = frame ? frame.r[di] : -1;
    const fading = frame ? frame.f[di] === 1 : false;
    const lit = h.litAt != null && h.litAt <= t;
    let state: NodeState;
    if (h.archivedAt != null && h.archivedAt <= t) state = "archived";
    else if (lv <= 1) state = "ghost";
    else if (!lit) state = "outline";
    else if (fading) state = "fading";
    else state = LEVEL_STATE[Math.min(4, lv)] ?? "lit";
    const facets = {} as GraphNode["facets"];
    let depth = 0;
    for (const f of FACETS) {
      const ft = h.facets[f];
      if (ft != null && ft <= t) {
        facets[f] = "passed";
        depth += 1;
      } else facets[f] = n.facets[f] === "none" ? "none" : "pending";
    }
    nodes.push({ ...n, state, retention: rRaw >= 0 ? rRaw / 100 : 0, depth, facets, due: false, litAt: lit ? h.litAt : null, anchorId: lit ? n.anchorId : null });
  }
  const present = new Set(nodes.map((n) => n.id));
  const edgeBorn = new Map<string, number>();
  for (const e of bundle.events) if (e.kind === "edge_confirmed") edgeBorn.set(e.edgeId, e.t);
  const edges = snap.edges.filter((e) => present.has(e.from) && present.has(e.to) && (edgeBorn.get(e.id) ?? 0) <= t);
  const summary = { lit: 0, fading: 0, outline: 0, dailyCost: 0 };
  for (const n of nodes) {
    if (n.state === "archived") continue;
    if (n.litAt != null && n.retention >= 0.75) summary.lit += 1;
    if (n.state === "fading") summary.fading += 1;
    if (n.state === "outline") summary.outline += 1;
  }
  return { ...snap, at: t, summary, nodes, edges, themes: snap.themes.map((th) => ({ ...th, nodeIds: th.nodeIds.filter((id) => present.has(id)) })) };
}

// ---------------- 节拍（v49.143 / D310，设计 KG-FORCE-GRAPH §4） ----------------

export interface Beat {
  /** 本拍第一个事件时刻 */
  start: number;
  /** 本拍最后一个事件时刻（回放折叠取这个时刻） */
  end: number;
  events: GraphEvent[];
  /** 播放时长（毫秒，不含空白天数） */
  dur: number;
}

/** 事件涉及的节点 id（边事件返回空，由边折叠体现） */
export function eventNodeIds(e: GraphEvent): string[] {
  if ("nodeId" in e) return [e.nodeId];
  if (e.kind === "merged") return [e.intoId];
  if (e.kind === "split") return [e.fromId, e.newId];
  return [];
}

/**
 * 事件按时间分拍：与上一事件间隔 ≤ gapMs 归入同一拍（同一学习时段）。
 * 拍与拍之间的空白不论多少天都不占播放时长——回放按拍推进，不按日期线性推进。
 */
export function beatsOf(events: GraphEvent[], gapMs = 2 * 3600000): Beat[] {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const out: Beat[] = [];
  for (const e of ev) {
    const last = out[out.length - 1];
    if (last && e.t - last.end <= gapMs) {
      last.end = e.t;
      last.events.push(e);
    } else out.push({ start: e.t, end: e.t, events: [e], dur: 0 });
  }
  for (const b of out) {
    const touched = new Set<string>();
    for (const e of b.events) for (const id of eventNodeIds(e)) touched.add(id);
    b.dur = Math.min(1400, 420 + 40 * Math.max(0, touched.size - 1)) + 160;
  }
  return out;
}

/** 回放画面签名：非虚影节点的 id:状态:深度 + 边数（同签名＝画面没变） */
function foldSignature(snap: GraphSnapshot): string {
  let s = "";
  for (const n of snap.nodes) if (n.state !== "ghost") s += `${n.id}:${n.state}:${n.depth};`;
  return s + "|" + snap.edges.length;
}

/**
 * 只留「画面真的会变」的拍：逐拍折叠，与上一保留拍画面签名相同的拍丢弃
 * （其事件仍在，只是回放时不占时间；空白前奏因此被整段跳过）。
 */
export function changingBeatsOf(bundle: GraphBundle, gapMs?: number): Beat[] {
  const all = beatsOf(bundle.events, gapMs);
  const out: Beat[] = [];
  let prev = "";
  for (const b of all) {
    const sig = foldSignature(foldAt(bundle, b.end));
    if (sig === prev) continue;
    prev = sig;
    out.push(b);
  }
  return out;
}

/** 两拍之间跳过的整天数（用于「跳过 N 天」提示） */
export function skippedDays(prev: Beat | undefined, next: Beat): number {
  if (!prev) return 0;
  return Math.floor((next.start - prev.end) / 86400000);
}

/** 卡片正文是否「含知识点名称或别名」（§11.1：翻面前隐藏名称的判定，与主进程同口径，供本地兜底） */
export function containsName(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => n.trim().length > 0 && t.includes(n.trim().toLowerCase()));
}
