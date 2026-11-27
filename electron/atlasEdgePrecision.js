// 全谱边精确率表（占位）——KG-SG-IMPL-PLAN §5.1 / Z8。
// 单一真源：T0b 审计完成后只改本文件；atlasPath.js 与 sqliteAccessor 都从这里取数。
"use strict";

const PLACEHOLDER = true;
/** 度数超过它的节点不能作为路径的中间节点（§5.2） */
const HUB_DEGREE = 3000;
/** 精确率低于它的组不入图（＝最弱一跳门槛，§8.7） */
const MIN_PRECISION = 0.75;

/** 出处优先：用户手动 / 材料投影（P1–P5）边，不论类型 */
const SOURCE_P = { user: 0.99, material: 0.92, name: 0.8 }; // name：v49.172 / D342 名称代理（知识点名称里出现的全谱词）
/** 非「关联」类型（b 属于 / p 前置 / c 区分 / a 类比 / u 应用 / e 例子） */
const TYPE_P = { b: 0.93, p: 0.9, c: 0.9, a: 0.85, u: 0.85, e: 0.85 };
/** r 核心：概念之间的思想关系 */
const R_CORE = { 论述: 0.88, 提出: 0.88, 导致: 0.88, 影响: 0.88, 受启发于: 0.88 };
/** enrich（构建期补边）出处上的「导致 / 影响」略低 */
const ENRICH_SOURCES = new Set(["wp-seealso", "wp-cat", "cn", "user-agg", "generated"]);
const R_ENRICH_SAME_PRED = { 导致: 0.85, 影响: 0.85 };
/** enrich 新增谓词（实例 / 用于）；象征 / 相关 排除 */
const R_ENRICH_NEW = { 实例: 0.82, 用于: 0.8 };
/** r 思想史 / 作品 */
const R_IDEAS = { 师从: 0.85, 属于流派: 0.85, 著有: 0.85, 创作: 0.85, 出自: 0.85, 改编自: 0.85, 研究: 0.78 };
/** r 情境：仅当目标是事件 / 地点时启用 */
const R_SITUATIONAL = { 参与: 0.8, 重大事件: 0.8, 发生于: 0.8, 位于: 0.8, 先于: 0.8 };
/** r 排除：永不入图（人物履历与命名 + enrich 的象征 / 相关） */
const EXCLUDED_PREDS = ["就读于", "任职于", "成员", "得名于", "象征", "相关"];

/**
 * @param {{type?:string, pred?:string|null, source?:string|null}} edge
 * @param {{situational?:boolean}} [ctx]
 * @returns {number|null} 精确率；null＝该边不入图
 */
function precisionOf(edge, ctx) {
  const e = edge || {};
  const situational = !!(ctx && ctx.situational);
  let p = null;
  if (e.source && Object.prototype.hasOwnProperty.call(SOURCE_P, e.source)) {
    p = SOURCE_P[e.source];
  } else if (e.type === "r") {
    const pred = e.pred || "";
    if (EXCLUDED_PREDS.includes(pred)) p = null;
    else if (Object.prototype.hasOwnProperty.call(R_SITUATIONAL, pred)) p = situational ? R_SITUATIONAL[pred] : null;
    else if (ENRICH_SOURCES.has(e.source) && Object.prototype.hasOwnProperty.call(R_ENRICH_SAME_PRED, pred)) p = R_ENRICH_SAME_PRED[pred];
    else if (Object.prototype.hasOwnProperty.call(R_CORE, pred)) p = R_CORE[pred];
    else if (Object.prototype.hasOwnProperty.call(R_ENRICH_NEW, pred)) p = R_ENRICH_NEW[pred];
    else if (Object.prototype.hasOwnProperty.call(R_IDEAS, pred)) p = R_IDEAS[pred];
  } else if (Object.prototype.hasOwnProperty.call(TYPE_P, e.type)) {
    p = TYPE_P[e.type];
  }
  if (p == null || p < MIN_PRECISION) return null;
  return p;
}

module.exports = { PLACEHOLDER, precisionOf, HUB_DEGREE, MIN_PRECISION, EXCLUDED_PREDS };
