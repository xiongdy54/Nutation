// 材料知识导图 v1 生成引擎——**已退役（v49.119 / D286，审计 D-1，连带 F-12）**。
//
// 历史：v48 批2（M15，D41/D42 / §4.19）在此实现自底向上递归归并的 v1 生成链
// （preview / generate / deepen / repairConfirm + buildCallPayloads + 五类 prompt scope 的解析、校验、评审与分片缓存）。
// v49.18（D191）起新生成一律走 v2（`electron/mindmapEngineV2.js`），渲染层不再调用 v1 生成；
// D286 删除整条 v1 生成链及其 IPC / preload / 渲染层包装（F-12「errorText 写死中文」随之消失）。
//
// 仍保留：`cancelRun` —— v1 run 的取消入口。`material_map_runs` 与 v1 读路径
// （list / get / getActive / mapTree / setActive / delete / runs / learningStatus / pendingRuns）仍在用，
// `mindmap:cancel` 需要按 run 归属把 v1 run 的取消落到这里（审计 #10）。生成链已不在，
// 本函数只记取消标记（幂等）；「已缓存分片保留」等 v1 续跑语义随生成链一并退役。

"use strict";

const cancelledRuns = new Set();

function cancelRun(runId) {
  cancelledRuns.add(String(runId));
}

module.exports = {
  cancelRun
};
