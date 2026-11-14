// 材料知识导图——渲染层类型化客户端（v48 批3，M15，D41/D42 / §4.19）。
// 与 journal.ts/memory.ts 同构：window.mindmapAPI 薄包装 + 主进程推送桥接为 EventBus `mindmap/changed`。

import { eventBus } from "./eventbus";

export interface MapNodeRecord {
  id: string;
  parentId: string | null;
  title: string;
  authorialRole: string | null;
  centralQuestion?: string | null;
  mainMove?: string | null;
  progression?: string | null;
  relationToParent?: string | null;
  relationToSiblings?: string | null;
  groupingBasis?: { type: string; explanation: string; evidenceRefs?: string[] } | null;
  summary?: string | null;
  unitAnchors: string[];
  evidence: { id?: string; quote: string; unitAnchor?: string | null; matchStart?: number; matchEnd?: number; quoteHash?: string; positionAmbiguous?: boolean }[];
  compositionalEvidence?: string[];
  childIds: string[];
  flags?: string[];
  /** v48.12 P0 已落库：节点拥有的原文作用域（全文 UTF-16 一维坐标，多区间） */
  sourceSpans?: [number, number][] | null;
  spanOrigin?: string | null;
  /** 模型对本节点是否还有更深结构的判断（与 sourceSpans 一起决定「可深化」） */
  expandable?: boolean;
  stopReason?: string | null;
  residualChars?: number | null;
}

export interface MapStructure {
  version: number;
  generatorVersion: string;
  title: string;
  rootNodeId: string;
  nodes: MapNodeRecord[];
  edges: unknown[];
  /** 引擎落库时派生的有界结构摘要（≤1200 字；制卡整书把握直读） */
  summaryText?: string;
}

export interface MaterialMapMeta {
  id: string;
  documentId: string;
  scopeAnchor: string;
  scopeKind: string;
  granularity: string;
  title: string | null;
  nodeCount: number;
  promptVersion: number | null;
  generatorVersion: string | null;
  provider: string | null;
  model: string | null;
  nodeRemap: Record<string, string> | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  structure?: MapStructure | null;
}

export interface MapRunRecord {
  id: string;
  documentId: string;
  status: string;
  stage: string | null;
  callsPlanned: number | null;
  callsDone: number | null;
  chars: number | null;
  estInputTokens: number | null;
  estOutputTokens: number | null;
  estCost: number | null;
  currency: string | null;
  actualPromptTokens: number | null;
  actualCompletionTokens: number | null;
  actualCost: number | null;
  repairCount: number;
  errorCode: string | null;
  errorText: string | null;
  createdAt: number;
}

/** v48.13 P3（D47）：可续跑的运行（应用重启后发现；`interrupted` = 被关闭打断，`section_ready` = 首层就绪待续跑） */
export interface ResumableMapRun {
  id: string;
  documentId: string;
  status: string;
  stage: string | null;
  scopeAnchor: string;
  granularity: string;
  callsDone: number | null;
  chars: number | null;
  /** 材料标题（主进程连表带出，指示器不必再回查） */
  materialTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * v48.12 修复「就此制卡发全文」：按 §4.19-10 组装**有界结构语义包**
 * （本节点 → 父链 → 直接子结构 → 节点证据引文 → 材料级结构摘要，≤maxChars，**不携带章节原文**）。
 * card-structure 提示词的【输入块】契约就是本包；此前误把 collect.textByUnit 的原文当材料发出去，
 * 与提示词「你拿不到原文全文」直接矛盾，且把成本推高到 2400+1200 字。
 */
export function buildStructureCardPackage(node: MapNodeRecord, structure: MapStructure, maxChars = 1200): string {
  const byId = new Map((structure?.nodes || []).map((n) => [n.id, n]));
  const chain: string[] = [];
  let cur: MapNodeRecord | undefined = node.parentId ? byId.get(node.parentId) : undefined;
  const guard = new Set<string>([node.id]);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    chain.unshift(`${cur.title}${cur.authorialRole ? `（${cur.authorialRole}）` : ""}`);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const kids = (node.childIds || [])
    .map((id) => byId.get(id))
    .filter((k): k is MapNodeRecord => Boolean(k))
    .map((k) => ({ title: k.title, authorialRole: k.authorialRole || null, relationToParent: k.relationToParent || null }));
  const pkg: Record<string, unknown> = {
    本节点: {
      title: node.title,
      authorialRole: node.authorialRole || null,
      centralQuestion: node.centralQuestion ?? null,
      mainMove: node.mainMove ?? null,
      progression: node.progression ?? null,
      relationToParent: node.relationToParent ?? null,
      groupingBasis: node.groupingBasis ?? null
    },
    父链: chain,
    直接子结构: kids,
    证据引文: (node.evidence || []).map((e) => e.quote).filter(Boolean).slice(0, 6),
    材料级结构摘要: structure?.summaryText || structure?.title || ""
  };
  let text = `【结构语义包】
${JSON.stringify(pkg, null, 1)}`;
  if (text.length > maxChars) {
    // 有界优先砍「摘要 → 证据条数」，**绝不回退去塞原文**
    pkg.证据引文 = (pkg.证据引文 as string[]).slice(0, 3);
    pkg.材料级结构摘要 = String(pkg.材料级结构摘要).slice(0, 240);
    text = `【结构语义包】
${JSON.stringify(pkg, null, 1)}`;
    if (text.length > maxChars) text = text.slice(0, maxChars);
  }
  return text;
}

declare global {
  interface Window {
    mindmapAPI?: {
      cancel: (runId: string) => Promise<boolean>;
      list: (documentId: string) => Promise<MaterialMapMeta[]>;
      get: (id: string) => Promise<MaterialMapMeta | null>;
      getActive: (documentId: string, scopeAnchor?: string) => Promise<MaterialMapMeta | null>;
      setActive: (id: string) => Promise<MaterialMapMeta | null>;
      remove: (id: string) => Promise<boolean>;
      runs: (documentId: string) => Promise<MapRunRecord[]>;
  /** v48.13 P3：可续跑运行（全局，不限文档） */
  pendingRuns: () => Promise<ResumableMapRun[]>;
      learningStatus: (documentId: string, nodeIds: string[]) => Promise<Record<string, { cardCount: number; kpExists: boolean }>>;
      onChanged: (cb: (payload: { runId?: string; stage?: string; done?: number; total?: number; label?: string; mapId?: string }) => void) => () => void;
      /** D192 材料导图 v2：mindmap:delta 增量推送订阅（返回退订函数） */
      onDelta?: (cb: (payload: unknown) => void) => () => void;
    };
  }
}

export const mindmapApi = {
  cancel: (runId: string) => window.mindmapAPI?.cancel(runId),
  list: (documentId: string) => window.mindmapAPI?.list(documentId) ?? Promise.resolve([]),
  get: (id: string) => window.mindmapAPI?.get(id) ?? Promise.resolve(null),
  getActive: (documentId: string, scopeAnchor?: string) => window.mindmapAPI?.getActive(documentId, scopeAnchor) ?? Promise.resolve(null),
  setActive: (id: string) => window.mindmapAPI?.setActive(id) ?? Promise.resolve(null),
  remove: (id: string) => window.mindmapAPI?.remove(id) ?? Promise.resolve(false),
  runs: (documentId: string) => window.mindmapAPI?.runs(documentId) ?? Promise.resolve([]),
  pendingRuns: () => window.mindmapAPI?.pendingRuns() ?? Promise.resolve([]),
  learningStatus: (documentId: string, nodeIds: string[]) => window.mindmapAPI?.learningStatus(documentId, nodeIds) ?? Promise.resolve({}),
  onChanged: (cb: (payload: { runId?: string; stage?: string; done?: number; total?: number; label?: string; mapId?: string }) => void) =>
    window.mindmapAPI?.onChanged(cb) ?? (() => {})
};

let bridgeInstalled = false;

/** App 级桥安装（App.tsx useEffect 一次）：主进程 mindmap:changed → EventBus mindmap/changed
 *  安装守卫（同 `installActivityStore`）：React StrictMode 下挂载效应会跑两遍，
 *  无守卫就注册两份 onDelta → 同一条 mindmap:delta 在 EventBus 上发两次 →
 *  结构图对同一段流式文本应用两遍（讲解文本出现「同一句重复两遍」）。 */
export function installMindmapBridge(): () => void {
  if (bridgeInstalled) return () => {};
  if (!window.mindmapAPI) return () => {};
  bridgeInstalled = true;
  const offChanged = window.mindmapAPI.onChanged((payload) => {
    eventBus.emit("mindmap/changed", payload);
  });
  // D192（材料导图 v2）：主进程 mindmap:delta → EventBus mindmap/delta
  const offDelta = window.mindmapAPI.onDelta ? window.mindmapAPI.onDelta((payload) => eventBus.emit("mindmap/delta", payload)) : () => {};
  return () => {
    bridgeInstalled = false;
    offChanged();
    offDelta();
  };
}
