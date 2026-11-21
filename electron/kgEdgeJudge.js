"use strict";
// v49.148 / D317 AI 判断（设计 docs/design/KG-EDGE-LAYERS.md §3.4）：后台串行队列，只判断本地召回的候选对子，
// AI 在封闭集合里选关系类型或 none，依据必须是所给片段的原文（本地校验子串）。结果写 kg-edge-judge 提案（pending＝推断）。
// 按「对子 + 材料证据指纹」记进度（app_meta kgEdgeJudge:prog）：证据不变就不重复调用 AI；失败后退避 10 分钟。
// 无 AI 配置时什么都不做（材料层推断线照常，只是没有类型）。依赖全部注入（node 可测）：
//   { chatStream, getAIConfig, getPromptTemplate, kgService?, db?, now? }
const BATCH = 10;
const MAX_BATCHES = 50;
const BACKOFF_MS = 10 * 60 * 1000;
const PROG_KEY = "kgEdgeJudge:prog";
const TYPES = ["part_of", "prerequisite", "contrasts_with", "example_of", "application_of", "related_to", "none"];
const UNDIRECTED = new Set(["related_to", "contrasts_with", "none"]);

const norm = (s) => String(s || "").replace(/[\s　]+/g, "").replace(/^[「『“"'《]+|[」』”"'》]+$/g, "");

/** 取回复里最后一个含 "items" 的顶层 JSON 对象（模型常在 JSON 前写分析） */
function parseReply(raw) {
  const s = String(raw || "");
  let at = s.lastIndexOf('{"items"');
  if (at < 0) at = s.search(/\{\s*"items"/);
  if (at < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(at, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 校验一条判断：封闭类型、方向、引文必须是片段子串（≥4 字） */
function validate(item, cand) {
  const type = String(item && item.type || "");
  if (!TYPES.includes(type)) return null;
  if (type === "none") return { type: "none" };
  const quote = String(item.quote || "").trim();
  const q = norm(quote);
  if (q.length < 4) return null;
  if (!cand.snippets.some((sn) => norm(sn.text).includes(q))) return null;
  const fromB = String(item.from || "A").toUpperCase() === "B" && !UNDIRECTED.has(type);
  return { type, fromId: fromB ? cand.kpB : cand.kpA, toId: fromB ? cand.kpA : cand.kpB, quote: quote.slice(0, 300) };
}

function buildUser(batch) {
  const lines = [];
  batch.forEach((c, i) => {
    lines.push(`k=${i + 1}`);
    lines.push(`A：${c.a.label}${c.a.definition ? `（${String(c.a.definition).replace(/\s+/g, " ").slice(0, 80)}）` : ""}`);
    lines.push(`B：${c.b.label}${c.b.definition ? `（${String(c.b.definition).replace(/\s+/g, " ").slice(0, 80)}）` : ""}`);
    c.snippets.forEach((sn, j) => lines.push(`片段${j + 1}：${sn.text}`));
    lines.push("");
  });
  return lines.join("\n");
}

function createKgEdgeJudge(d) {
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  const svc = () => d.kgService || require("./kgService");
  const db = () => d.db || require("./db");
  let running = null;
  let failUntil = 0;

  async function chat(system, user) {
    return await new Promise((resolve, reject) => {
      let acc = "";
      let settled = false;
      Promise.resolve(
        d.chatStream({ messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.1 }, (m) => {
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

  async function template() {
    if (now() < failUntil) return null;
    let cfg = null;
    try {
      cfg = await d.getAIConfig();
    } catch {
      cfg = null;
    }
    if (!(cfg && (cfg.hasKey || cfg.preset === "local"))) return null;
    try {
      const t = d.getPromptTemplate("kg-edge-judge");
      return t && t.content ? String(t.content) : null;
    } catch {
      return null;
    }
  }

  const meta = () => db()._mapLinkDb();
  function readProg() {
    try {
      return JSON.parse(meta().readAppMeta(PROG_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }
  function writeProg(p) {
    meta().writeAppMeta(PROG_KEY, JSON.stringify(p));
  }

  async function runOnce() {
    const system = await template();
    if (!system) return { judged: 0, added: 0 };
    let judged = 0;
    let added = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const prog = readProg();
      const batch = await svc().judgeCandidates(BATCH, prog);
      if (!batch.length) break;
      let reply;
      try {
        const raw = await chat(system, buildUser(batch));
        reply = parseReply(raw);
      } catch (e) {
        failUntil = now() + BACKOFF_MS;
        try {
          console.warn("[kgEdgeJudge] AI 判断失败，10 分钟后再试：", e && e.message);
        } catch { /* ignore */ }
        break;
      }
      const items = reply && Array.isArray(reply.items) ? reply.items : [];
      const byK = new Map(items.map((it) => [String(it && it.k), it]));
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const v = byK.has(String(j + 1)) ? validate(byK.get(String(j + 1)), c) : null;
        if (v && v.type !== "none") {
          const r = db().kgAddJudgment({ kpA: c.kpA, kpB: c.kpB, type: v.type, fromId: v.fromId, toId: v.toId, quote: v.quote, sourceKey: c.snippets.map((s) => s.key).join(","), evidenceFp: c.fp });
          if (r && r.created) added++;
        }
        // 无论判断成功与否都记进度：同样的证据不再花用户的 AI 额度（证据变化后指纹不同，会再判一次）
        prog[c.key] = c.fp;
        judged++;
      }
      writeProg(prog);
      if (!reply) {
        // 回复无法解析：本批记为已判，继续下一批（不退避：多半是单批格式问题）
        continue;
      }
    }
    if (added) {
      try {
        svc().invalidate();
      } catch { /* ignore */ }
    }
    return { judged, added };
  }

  function sweep() {
    if (!running) {
      running = runOnce()
        .catch((e) => {
          try {
            console.warn("[kgEdgeJudge] 中断：", e && e.message);
          } catch { /* ignore */ }
          return { judged: 0, added: 0 };
        })
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  return {
    sweep,
    /** AI 设置变更：清退避后重扫 */
    onAiSettingsChanged: () => {
      failUntil = 0;
      return sweep();
    },
    idle: async () => {
      while (running) await running;
    },
    _state: () => ({ failUntil })
  };
}

module.exports = { createKgEdgeJudge, parseReply, validate, buildUser, BACKOFF_MS, PROG_KEY };
