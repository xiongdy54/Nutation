// 知识地基客户端（v40，K1，D37 / §4.2-23）——渲染层唯一入口。
// KnowledgeBase 口径唯一：一切 KP 检索（含洞察子图展开）必须走主进程 KnowledgeBase，
// 禁止组件自写查询绕过别名/合并语义；读侧零 FSRS 写（§4.12）。

export const KP_RELATION_TYPES = [
  "prerequisite",
  "part_of",
  "related_to",
  "contrasts_with",
  "example_of",
  "application_of",
  "generalization_of",
  "specialization_of",
  "analogous_to"
] as const;

export type KnowledgeRelationType = (typeof KP_RELATION_TYPES)[number];

export const KP_RELATION_LABELS: Record<KnowledgeRelationType, string> = {
  prerequisite: "前置",
  part_of: "属于",
  related_to: "相关",
  contrasts_with: "对比",
  example_of: "例证",
  application_of: "应用",
  generalization_of: "泛化",
  specialization_of: "特化",
  analogous_to: "结构类比"
};

export interface KnowledgePoint {
  id: string;
  canonicalLabel: string;
  description: string | null;
  domainId: string | null;
  parentKnowledgePointId: string | null;
  status: "active" | "merged" | "deprecated";
  mergedInto: string | null;
  aliases: string[];
  languageVariants: string[];
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeRelation {
  id: string;
  fromKnowledgePointId: string;
  toKnowledgePointId: string;
  relationType: KnowledgeRelationType;
  confidence: number | null;
  source: "user" | "ai-inference" | "imported" | "inferred";
  sourceRef: unknown;
  structureLabel: string | null;
  mapping: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgePointFilter {
  query?: string;
  domainId?: string;
  status?: "active" | "merged" | "deprecated" | "";
  limit?: number;
  offset?: number;
}

export interface KnowledgePointListResult {
  points: KnowledgePoint[];
  total: number;
}

/** v41（K2-A，D38）：卡片簇（一次制卡动作在同一材料内产生的一组卡）——AI 整理的输入单位 */
/** AI 抽取裁决结果（主进程 applyKpExtraction 输出） */
/** v43（K2-B）：KnowledgeLint K4/K7/K8 报告型检查结果（只读非阻断；K2/K3/K5/K6 为写时校验/提案裁决形态） */
declare global {
  interface Window {
    knowledgeAPI?: {
      listPoints: (filter?: KnowledgePointFilter) => Promise<KnowledgePointListResult>;
      /** D158：只读——所选知识点归并族的并集（含所选 id 本身） */
      resolveFamilies: (ids: string[]) => Promise<string[]>;
      getPoint: (id: string) => Promise<KnowledgePoint | null>;
      createPoint: (payload: Partial<KnowledgePoint> & { canonicalLabel: string }) => Promise<KnowledgePoint>;
      updatePoint: (id: string, patch: Partial<KnowledgePoint>) => Promise<KnowledgePoint | null>;
      mergePoints: (sourceId: string, targetId: string) => Promise<{ source: KnowledgePoint; target: KnowledgePoint }>;
      unmergePoint: (id: string) => Promise<KnowledgePoint>;
      listRelations: (filter?: { kpId?: string; relationType?: KnowledgeRelationType; limit?: number }) => Promise<{ relations: KnowledgeRelation[] }>;
      createRelation: (payload: {
        fromKnowledgePointId: string;
        toKnowledgePointId: string;
        relationType: KnowledgeRelationType;
        confidence?: number;
        source?: KnowledgeRelation["source"];
        structureLabel?: string;
        mapping?: unknown;
      }) => Promise<KnowledgeRelation>;
      deleteRelation: (id: string) => Promise<boolean>;
    };
  }
}

const emptyList: KnowledgePointListResult = { points: [], total: 0 };

export const knowledgeApi = {
  async listPoints(filter: KnowledgePointFilter = {}): Promise<KnowledgePointListResult> {
    if (!window.knowledgeAPI) return emptyList;
    return (await window.knowledgeAPI.listPoints(filter)) || emptyList;
  },
  async getPoint(id: string): Promise<KnowledgePoint | null> {
    if (!window.knowledgeAPI) return null;
    return (await window.knowledgeAPI.getPoint(id)) || null;
  },
  async createPoint(payload: Partial<KnowledgePoint> & { canonicalLabel: string }): Promise<KnowledgePoint | null> {
    if (!window.knowledgeAPI) return null;
    return (await window.knowledgeAPI.createPoint(payload)) || null;
  },
  async updatePoint(id: string, patch: Partial<KnowledgePoint>): Promise<KnowledgePoint | null> {
    if (!window.knowledgeAPI) return null;
    return (await window.knowledgeAPI.updatePoint(id, patch)) || null;
  },
  async mergePoints(sourceId: string, targetId: string) {
    if (!window.knowledgeAPI) return null;
    return await window.knowledgeAPI.mergePoints(sourceId, targetId);
  },
  async unmergePoint(id: string): Promise<KnowledgePoint | null> {
    if (!window.knowledgeAPI) return null;
    return (await window.knowledgeAPI.unmergePoint(id)) || null;
  },
  async listRelations(filter: { kpId?: string; relationType?: KnowledgeRelationType; limit?: number } = {}): Promise<KnowledgeRelation[]> {
    if (!window.knowledgeAPI) return [];
    return (await window.knowledgeAPI.listRelations(filter))?.relations || [];
  },
  async createRelation(payload: Parameters<NonNullable<Window["knowledgeAPI"]>["createRelation"]>[0]): Promise<KnowledgeRelation> {
    if (!window.knowledgeAPI) throw new Error("knowledgeAPI 不可用");
    return await window.knowledgeAPI.createRelation(payload);
  },
  async deleteRelation(id: string): Promise<boolean> {
    if (!window.knowledgeAPI) return false;
    return await window.knowledgeAPI.deleteRelation(id);
  },
};

/** 关系类型展示名（AI 来源加虚线语义由 UI 层处理） */
export function relationLabel(type: string): string {
  return KP_RELATION_LABELS[type as KnowledgeRelationType] || type;
}
