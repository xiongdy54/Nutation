// v49.143 / D311 知识全谱：渲染层类型与小工具（主进程 electron/atlas.js 只读；这里不算任何事实）。
import { getLocale, t } from "./i18n";

export interface AtlasNode {
  id: string;
  kind: string;
  kindLabel: string;
  zh: string | null;
  zht: string | null;
  en: string | null;
  ja: string | null;
  gloss: string | null;
  glossEn: string | null;
  years: [number | null, number | null] | null;
  rank: number;
  topicId: string | null;
  fieldId: string | null;
  exact?: boolean;
  /** D314 修订：来自在线全谱（本地库里没有） */
  remote?: boolean;
}
export interface AtlasNodeDetail extends AtlasNode {
  chain: { id: string; label: string }[];
  field: { id: string; label: string; domain: string | null } | null;
  kp: { id: string; label: string; status: string } | null;
}
export interface AtlasNeighbor {
  type: "b" | "p" | "c" | "a" | "e" | "u" | "r";
  pred: string | null;
  out: boolean;
  layer: "skeleton" | "context";
  node: AtlasNode;
  kp: { id: string; label: string; status: string } | null;
}
/** v49.154 / D323 / A3：atlasNeighbors({ withMeta: true }) 的返回 */
export interface AtlasNeighborsMeta {
  rows: AtlasNeighbor[];
  complete: boolean;
  truncated: boolean;
}
export interface RoadmapNode extends AtlasNode {
  target: boolean;
  ready: boolean;
  prereqs: string[];
  kp: { id: string; label: string; status: string } | null;
}
export interface Roadmap {
  available: boolean;
  gap: RoadmapNode[];
  closure: number;
  mastered: number;
}

/** v49.147 / D316：linkAtlas 的返回——「是它」时可能改名（旧名进别名）或并入已对应该条目的知识点 */
export interface LinkAtlasResult {
  id: string;
  atlasId: string | null;
  atlasParent: string | null;
  renamed?: { from: string; to: string };
  mergedInto?: { id: string; label: string };
}
export interface ReattachCand {
  key: string;
  kind: "kp" | "atlas";
  label: string;
  gloss: string;
}
export interface ReattachCard {
  cardId: string;
  front: string;
  back: string;
  cands: ReattachCand[];
  suggestion: string | null;
}
export interface ReattachPlan {
  token: string;
  ai: "none" | "done" | "failed";
  truncated: number;
  groups: { kpId: string; label: string; cards: ReattachCard[] }[];
}
export interface ReattachResult {
  moved: number;
  created: number;
  archived: number;
  archivedIds: string[];
  undoToken: string;
}

interface AtlasBridge {
  atlasStatus(): Promise<{ available: boolean; complete?: boolean; onlineReady?: boolean }>;
  atlasSearch(q: string, opts?: { limit?: number; kinds?: string[] }): Promise<AtlasNode[]>;
  atlasNode(id: string): Promise<AtlasNodeDetail | null>;
  /** v49.154 / D323 / A3：withMeta 时返回关系数组 + 完整性标记；不传时返回值不变 */
  atlasNeighbors(id: string, opts: { layer?: "skeleton" | "context" | "all"; withMeta: true }): Promise<AtlasNeighborsMeta>;
  atlasNeighbors(id: string, opts?: { layer?: "skeleton" | "context" | "all" }): Promise<AtlasNeighbor[]>;
  atlasRoadmap(targets: string[] | string): Promise<Roadmap>;
  linkAtlas(kpId: string, atlasId: string | null, atlasParent?: string | null): Promise<LinkAtlasResult>;
  /** v49.147 / D316：解散知识点并给名下卡片重挂（计划 → 确认 → 撤销；候选表与撤销数据在主进程） */
  reattachPlan(kpIds: string[]): Promise<ReattachPlan>;
  reattachApply(token: string, decisions: { cardId: string; choice: { key: string } | { atlasId: string } | null }[]): Promise<ReattachResult>;
  reattachUndo(undoToken: string): Promise<{ restored: number }>;
  onReattachProgress?(cb: (p: { done: number; total: number }) => void): () => void;
  unmappedKps(): Promise<{ id: string; label: string; aliases: string[]; description: string; atlasParent: string | null; also: string[] }[]>;
  /** v49.145 / D313：增删「也涉及」的全谱节点，返回该知识点当前的也涉及列表 */
  setAtlasAlso(kpId: string, atlasId: string, on: boolean): Promise<string[]>;
}
export function atlasApi(): AtlasBridge | null {
  const a = (window as unknown as { kgAPI?: Partial<AtlasBridge> }).kgAPI;
  return a && typeof a.atlasSearch === "function" ? (a as AtlasBridge) : null;
}

/** 按界面语言取全谱名称（繁中：全谱给了繁体名就用，否则经 i18n 的运行时简→繁转换） */
export function atlasLabel(n: Pick<AtlasNode, "zh" | "zht" | "en" | "ja" | "id">): string {
  const loc = getLocale();
  if (loc === "en") return n.en || n.zh || n.ja || n.id;
  if (loc === "ja") return n.ja || n.zh || n.en || n.id;
  if (loc === "zh-TW") return n.zht || (n.zh ? t(n.zh) : n.en || n.ja || n.id);
  return n.zh || n.en || n.ja || n.id;
}
export function atlasGloss(n: Pick<AtlasNode, "gloss" | "glossEn" | "years">): string {
  const loc = getLocale();
  const g = loc === "en" ? n.glossEn || n.gloss : n.gloss || n.glossEn;
  return g || "";
}

/**
 * 关系在界面上的名称（以「本节点」为视角；中文原文作 i18n 键）：
 *   属于 / 包含 · 前置（先学它）/ 后续 · 区分 · 类比 · 例子 / 例示 · 应用 / 基于 · 关联谓词原样（影响、师从、著有…）
 */
export function relationText(r: Pick<AtlasNeighbor, "type" | "pred" | "out">): string {
  switch (r.type) {
    case "b":
      return r.out ? "属于" : "包含";
    case "p":
      return r.out ? "后续" : "前置";
    case "c":
      return "区分";
    case "a":
      return "类比";
    case "e":
      return r.out ? "例示" : "例子";
    case "u":
      return r.out ? "基于" : "应用";
    default: {
      // 关联谓词按方向给正反说法（真实全谱实测：「师从」不分方向会把康德的学生列成老师）
      const p = r.pred || "关联";
      return (r.out ? PRED_OUT[p] : PRED_IN[p]) || p;
    }
  }
}

/** 关联谓词：本节点在 src 侧（out）时的说法 */
const PRED_OUT: Record<string, string> = { 影响: "影响了", 先于: "先于", 导致: "导致" };
/** 关联谓词：本节点在 dst 侧（in）时的说法 */
const PRED_IN: Record<string, string> = {
  影响: "受其影响", 师从: "学生", 著有: "作者", 创作: "创作者", 属于流派: "代表人物", 提出: "提出者", 论述: "被论述于",
  参与: "参与者", 发生于: "此地事件", 位于: "此地事物", 得名于: "以其命名", 先于: "后于", 导致: "起因", 就读于: "校友",
  任职于: "任职者", 成员: "成员", 研究: "研究者", 改编自: "改编作品", 受启发于: "启发了", 出自: "相关条目", 重大事件: "相关主体"
};

/** 画在线上的小字：情境层线没有箭头，所以与详情分组一致，用「聚焦节点视角」的说法 */
export function edgeText(r: Pick<AtlasNeighbor, "type" | "pred" | "out">): string {
  if (r.type === "b" || r.type === "p" || r.type === "c" || r.type === "a") return "";
  return relationText(r);
}

/** 所有可能出现的关系名（i18n 词表用；与构建器 ASSOC 谓词表一致） */
export const RELATION_TEXTS = ["属于", "包含", "后续", "前置", "区分", "类比", "例示", "例子", "基于", "应用", "关联",
  "影响", "师从", "著有", "创作", "属于流派", "提出", "论述", "参与", "发生于", "位于", "得名于", "先于", "导致",
  "就读于", "任职于", "成员", "研究", "改编自", "受启发于", "出自", "重大事件",
  "影响了", "受其影响", "学生", "作者", "创作者", "代表人物", "提出者", "被论述于", "参与者", "此地事件", "此地事物",
  "以其命名", "后于", "起因", "校友", "任职者", "研究者", "改编作品", "启发了", "相关条目", "相关主体"];

/** 情境层排序：用户已有的邻居优先，其次重要度 */
export function rankContext(rows: AtlasNeighbor[]): AtlasNeighbor[] {
  return [...rows].sort((a, b) => (b.kp ? 1 : 0) - (a.kp ? 1 : 0) || b.node.rank - a.node.rank);
}

/** 图上情境层最多画的条数（设计稿 §7：其余进详情列表） */
export const CONTEXT_EDGE_CAP = 12;
