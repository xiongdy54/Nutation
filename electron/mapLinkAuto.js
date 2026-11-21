"use strict";
// D314 修订：导图节点 ↔ 全谱挂靠的主进程自动驱动（用户无感、不靠手动步骤）。
// 串行后台队列（一次一张导图、一批一次 AI 调用，非流式累积、低温）；挂靠按「节点」判定 pending（见 mapLink.pendingMaps）。
// 触发：导图引擎广播 completed / partial（按 documentId 找活动导图）、启动后约 20 s 全量扫描、AI 设置变更后全量重扫。
// 无 AI 配置 / AI 调用失败：退回 matchOnly（标题精确名称，含在线精确查找），节点保持 pending；
//   失败后 10 分钟内不再发 AI 请求（设置变更会清掉退避）。每批写入后广播 mapLink:changed {mapId}。
// 依赖全部注入（node 可测）：{ chatStream, getAIConfig, getPromptTemplate, broadcast, mapLink?, now? }
const BATCH = 20;
const MAX_BATCHES = 200; // 防御：异常时避免死循环
const BACKOFF_MS = 10 * 60 * 1000;

function createMapLinkAuto(d) {
  const ML = d.mapLink || require("./mapLink");
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  const queue = [];
  let running = null; // Promise | null
  let failUntil = 0;

  async function chat(system, user) {
    return await new Promise((resolve, reject) => {
      let acc = "";
      let settled = false;
      Promise.resolve(
        d.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.2 }, (m) => {
          if (settled) return;
          if (m && m.error) {
            settled = true;
            reject(new Error(String(m.error)));
          } else if (m && m.done) {
            settled = true;
            resolve(acc);
          } else if (m && m.delta) acc += m.delta;
        })
      ).catch((e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  async function aiTemplate() {
    if (now() < failUntil) return null;
    let cfg = null;
    try {
      cfg = await d.getAIConfig();
    } catch {
      cfg = null;
    }
    if (!(cfg && (cfg.hasKey || cfg.preset === "local"))) return null;
    try {
      const t = d.getPromptTemplate("kg-map-link");
      return t && t.content ? String(t.content) : null;
    } catch {
      return null;
    }
  }

  const changed = (mapId) => {
    try {
      if (d.broadcast) d.broadcast({ mapId });
    } catch { /* ignore */ }
  };

  async function processMap(mapId) {
    const system = await aiTemplate();
    if (!system) {
      // 零 AI 的两步：先复用同文档别的版本里同标题节点的挂靠，再做标题精确匹配（matchOnly 自带备忘，不重复在线查名）
      const u = (() => {
        try {
          return ML.reuseOnly ? ML.reuseOnly(mapId) : null;
        } catch {
          return null;
        }
      })();
      if (u && u.reused) changed(mapId);
      const r = await ML.matchOnly(mapId).catch(() => null);
      if (r && r.added) changed(mapId);
      return;
    }
    for (let i = 0; i < MAX_BATCHES; i++) {
      const b = ML.buildBatch(mapId, { limit: BATCH });
      if (b.reused) changed(mapId);
      if (!b.keys.length) return;
      let r;
      try {
        const raw = await chat(system, `【导图节点】\n${b.user}`);
        r = await ML.applyReplyAsync(b.state, raw);
      } catch (e) {
        failUntil = now() + BACKOFF_MS;
        try {
          console.warn("[mapLink] AI 挂靠失败，退回名称精确匹配：", e && e.message);
        } catch { /* ignore */ }
        const m = await ML.matchOnly(mapId).catch(() => null);
        if (m && m.added) changed(mapId);
        return;
      }
      if (r.added) changed(mapId);
    }
  }

  async function drain() {
    while (queue.length) {
      const id = queue.shift();
      try {
        await processMap(id);
      } catch (e) {
        try {
          console.warn("[mapLink] 挂靠中断：", e && e.message);
        } catch { /* ignore */ }
      }
    }
  }

  function enqueue(ids) {
    for (const id of ids) if (!queue.includes(id)) queue.push(id);
    if (!running && queue.length) {
      running = drain().finally(() => {
        running = null;
      });
    }
    return running || Promise.resolve();
  }

  const safePending = () => {
    try {
      return ML.pendingMaps();
    } catch {
      return [];
    }
  };

  return {
    /** 全量扫描：把所有有未处理节点的活动导图排队 */
    sweep: () => enqueue(safePending().map((p) => p.mapId)),
    /** 某文档的活动导图（引擎 completed / partial 广播后调用） */
    notifyDocument: (documentId) => enqueue(safePending().filter((p) => String(p.documentId) === String(documentId)).map((p) => p.mapId)),
    notifyMap: (mapId) => enqueue(safePending().filter((p) => p.mapId === String(mapId)).map((p) => p.mapId)),
    /** AI 设置变更：清退避后全量重扫 */
    onAiSettingsChanged: () => {
      failUntil = 0;
      return enqueue(safePending().map((p) => p.mapId));
    },
    /** 测试：等待队列排空 */
    idle: async () => {
      while (running) await running;
    },
    _state: () => ({ queue: queue.slice(), failUntil })
  };
}

module.exports = { createMapLinkAuto, BACKOFF_MS };
