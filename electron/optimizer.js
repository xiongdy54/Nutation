// FSRS 参数优化器（v12；v23 改造：配置走 fsrs_configs 不可变快照 + settings.app.fsrsConfigId 指针，D20）
// 从 review_logs + cards 构建时序复习序列，训练个性化权重；delta_t 由 canonical 函数构建（§4.4.8，
// 与调度器 elapsed_days 同语义）；应用/重置只移动指针、绝不修改配置内容（§4.4.10 不可变）。
const { FSRS, FSRSItem, FSRSReview } = require("fsrs-rs-nodejs");
const { calculateFsrsDeltaT } = require("./fsrsTime");
const { DEFAULT_CONFIG_ID, DEFAULT_SCHEDULER_OPTIONS, FSRS_WEIGHTS_LEN, isValidWeights } = require("./fsrsConfig");

// 最低数据门槛：官方建议 400+ 条复习记录；低于此值训练不可靠（仍允许跑，UI 提示）
const MIN_RECOMMENDED_REVIEWS = 400;

const DAY_MS = 86400000;

// 从 review_logs 构建每卡时序序列（普通对象 {rating, deltaT}，不构造原生 FSRS 对象）。
// rating 映射：Again=1 Hard=2 Good=3 Easy=4（与应用存储一致，无需转换）
// delta_t = canonical 日历日差（§4.4.8，首条恒为 0；与调度器 elapsed_days 同语义）
// buildTrainSet（训练）与 getOptimizerStats（轻量计数）共用本生成器——映射 / 排序 / 过滤口径
// 只有一份解释（§4.4 最高不变量：同一份事实不允许两套解释），两路计数不可能漂移。
function* trainSequences(db) {
  const cards = db.listAllCards();
  const logsByCard = new Map();
  for (const card of cards) {
    logsByCard.set(card.id, []);
  }
  const allLogs = db.listAllReviewLogs();
  for (const log of allLogs) {
    const arr = logsByCard.get(log.cardId);
    if (arr) arr.push(log);
  }
  const RATING_MAP = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
  for (const logs of logsByCard.values()) {
    if (logs.length === 0) continue;
    logs.sort((a, b) => a.reviewedAt - b.reviewedAt);
    const reviews = [];
    let prevAt = null;
    for (const log of logs) {
      const rating = RATING_MAP[log.rating];
      if (!rating) continue;
      const deltaT = prevAt === null ? 0 : Math.max(0, calculateFsrsDeltaT(prevAt, log.reviewedAt));
      reviews.push({ rating, deltaT });
      prevAt = log.reviewedAt;
    }
    yield reviews;
  }
}

// 卡级准入（训练 / 计数共用）：≥2 条有效复习且至少含一条 delta_t>0 的跨天间隔
// （fsrs-rs dataset.rs：全零间隔序列会 panic）——单次复习或全同日复习的卡跳过。
function sequenceTrainable(reviews) {
  return reviews.length >= 2 && reviews.some((r, i) => i > 0 && r.deltaT > 0);
}

// 每卡时序序列 → FSRSItem[]（仅训练路径构造原生对象）
function buildTrainSet(db) {
  const items = [];
  let reviewCount = 0;
  let cardCount = 0;
  for (const reviews of trainSequences(db)) {
    reviewCount += reviews.length;
    if (!sequenceTrainable(reviews)) continue;
    const fsrsReviews = reviews.map((r) => new FSRSReview(r.rating, r.deltaT));
    for (let i = 1; i < fsrsReviews.length; i++) {
      // FSRSItem 要求「每条复习一个实例、携带此前全部历史」；每个前缀子序列也必须含 delta_t>0
      // （首条 delta_t 恒为 0，从 i=1 起的前缀含 reviews[1]）
      const prefix = fsrsReviews.slice(0, i + 1);
      if (!prefix.some((r, j) => j > 0 && r.deltaT > 0)) continue;
      items.push(new FSRSItem(prefix));
    }
    cardCount++;
  }
  return { items, reviewCount, cardCount };
}

// 审计 #41：设置页每次打开都调（main.js optimizer:stats），只需要两个计数——
// 不再借道 buildTrainSet：原来每卡 O(n²) 前缀引用复制 + n 个原生 FSRSItem（10k 卡 × 50 评
// ≈ 12.5M 次复制 / 50 万原生对象）只为数数。轻量路径零 FSRSItem / FSRSReview 构造，
// 序列口径与训练共用 trainSequences / sequenceTrainable，返回形状不变。
function getOptimizerStats(db) {
  let reviewCount = 0;
  let cardCount = 0;
  for (const reviews of trainSequences(db)) {
    reviewCount += reviews.length;
    if (sequenceTrainable(reviews)) cardCount++;
  }
  return {
    reviewCount,
    cardCount,
    minRecommended: MIN_RECOMMENDED_REVIEWS,
    enough: reviewCount >= MIN_RECOMMENDED_REVIEWS
  };
}

async function train(db, onProgress) {
  const { items, reviewCount, cardCount } = buildTrainSet(db);
  if (items.length === 0) {
    throw new Error("暂无复习记录，无法优化。先复习一些卡片吧。");
  }
  const f = new FSRS([]);
  const weights = await f.computeParameters(items, {
    // 审计 #4：numEpochs 属于 TrainingConfig（fsrs-rs-nodejs index.d.ts：ComputeParametersOption
    // 无顶层 numEpochs，napi 只读声明字段）——原顶层传法被静默忽略，25/10 epoch 从未生效。
    trainingConfig: { numEpochs: items.length >= 1000 ? 25 : 10 },
    progress: onProgress
      ? (_err, value) => onProgress(value)
      : undefined
  });
  // F8（v20）：fsrs-rs evaluate 约束——样本须 ≥2 条复习且最后一条 delta_t>0，
  // 学习/重学步同日恢复收尾的样本会被拒绝（InvalidInput）；训练不受影响，评估取可评估子集
  const evalItems = items.filter(
    (it) => it.reviews.length >= 2 && it.reviews[it.reviews.length - 1].deltaT > 0
  );
  const evaluation = evalItems.length > 0 ? f.evaluate(evalItems) : { logLoss: null, rmseBins: null };
  return {
    weights,
    reviewCount,
    cardCount,
    logLoss: evaluation.logLoss,
    rmseBins: evaluation.rmseBins
  };
}

// v23（D20）：当前活跃配置 = fsrs_configs 指针所指完整快照（weights+scheduler_options+来源）
function getActiveConfig(db) {
  const cfg = db.getActiveFsrsConfig();
  if (!cfg) return null;
  return cfg;
}

// 校验待应用权重：FSRS_WEIGHTS_LEN 维、全部有限数值（§4.4.10；D290 起维数与谓词走 fsrsConfig 单一真源）
function validateWeights(weights) {
  if (!isValidWeights(weights)) {
    throw new Error(`权重格式错误：需要 ${FSRS_WEIGHTS_LEN} 个数值`);
  }
  return weights.map(Number);
}

// 应用优化权重：校验 → 指纹去重插入新 config 行 → 移动活跃指针。
// 只影响未来调度（D20），不回算任何存量卡片；configId 变化后由主进程推送 fsrs:configChanged 热重建引擎（F9）
function applyWeights(db, weights) {
  const w = validateWeights(weights);
  const configId = db.insertFsrsConfig(w, DEFAULT_SCHEDULER_OPTIONS, "optimizer");
  db.setActiveFsrsConfig(configId);
  // 批次 C（D-TEST-01）：指针（settings.json）与内容（fsrs_configs 行）必须同生共死。
  // 落盘责任放在这条边界上而不是 insertFsrsConfig 内——initDb 的迁移块也调它，
  // 而 initDb 的落盘时机在末尾，迁移途中提前 persist 会动到还没就绪的落盘路径。
  db.persistNow();
  return { ok: true, configId };
}

// 恢复默认参数：指针回 cfg-default（普通不可变行，不插入重复 default）
function resetWeights(db) {
  db.setActiveFsrsConfig(DEFAULT_CONFIG_ID);
  db.persistNow(); // 同上：移动指针即落盘
  return { ok: true, configId: DEFAULT_CONFIG_ID };
}

module.exports = {
  MIN_RECOMMENDED_REVIEWS,
  DAY_MS,
  buildTrainSet,
  getOptimizerStats,
  train,
  getActiveConfig,
  validateWeights,
  applyWeights,
  resetWeights
};
