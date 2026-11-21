"use strict";
// v49.156 / D325 匿名汇总确认（隐式众包，可选；默认关，用户主动打开）。
// 上报白名单只有 {a, b, type, device, atlasBuiltAt}：两个全谱编号、关系类型、随机设备 id、全谱版本号。
// 绝不包含知识点名称、说明、卡片、材料、批注或任何用户文本。
// 通道：设置 app.atlasShareConfirmations === true 且 app.atlasReportUrl 非空 → POST <reportUrl>/confirm（8 s 超时）。
// 本地状态存 app_meta：atlasShare:device（随机 UUID）、atlasShare:sent（已报 "Qa|Qb|type" 集合）。失败一律静默。
const crypto = require("crypto");

const DEVICE_KEY = "atlasShare:device";
const SENT_KEY = "atlasShare:sent";
const POST_TIMEOUT_MS = 8000;
// 无向关系：同一对不分方向（键里按 Q 号升序）；有向关系保留方向。
const UNDIRECTED = new Set(["related_to", "contrasts_with"]);
const RETRY_MAX = 200;
const RETRY_CONCURRENCY = 2;
const RETRY_SCAN = 1000;

const H = () => require("./db")._mapLinkDb();

function enabled() {
  try {
    const app = require("./settingsStore").readSettings().app || {};
    return app.atlasShareConfirmations === true; // readSettings：默认关（D325）
  } catch {
    return false;
  }
}

/** 上报地址＝app.atlasReportUrl 去尾斜杠 + /confirm；未配置返回 null（绝不回退到 GitHub issue）。 */
function endpoint() {
  let raw = "";
  try {
    const a = require("./settingsStore").readSettings().app || {};
    raw = typeof a.atlasReportUrl === "string" ? a.atlasReportUrl.trim() : "";
  } catch {
    return null;
  }
  if (!raw) return null;
  return raw.replace(/\/+$/, "") + "/confirm";
}

/** 随机设备 id（首次使用时创建，之后稳定；不随全谱或设置重置）。 */
function deviceId() {
  try {
    const cur = H().readAppMeta(DEVICE_KEY);
    if (typeof cur === "string" && cur.trim()) return cur.trim();
    const id = crypto.randomUUID();
    H().writeAppMeta(DEVICE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

function readSent() {
  try {
    const arr = JSON.parse(H().readAppMeta(SENT_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function writeSent(set) {
  H().writeAppMeta(SENT_KEY, JSON.stringify([...set]));
}

const qNum = (q) => {
  const n = Number(String(q == null ? "" : q).replace(/^Q/i, ""));
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** 已报集合的键；无向类型按 Q 号升序，方向不影响去重。 */
function sentKey(a, b, type) {
  if (UNDIRECTED.has(type) && qNum(a) > qNum(b)) return `${b}|${a}|${type}`;
  return `${a}|${b}|${type}`;
}

/** 知识点当前挂靠的全谱编号（列里存整数；统一成 "Q…"）；没有则 null。 */
function atlasIdOf(kpId) {
  if (!kpId) return null;
  try {
    const row = H().queryAll("SELECT atlas_id AS a FROM knowledge_points WHERE id = ? AND is_deleted = 0", [String(kpId)])[0];
    const n = require("./db").atlasInt(row ? row.a : null);
    return n ? "Q" + n : null;
  } catch {
    return null;
  }
}

function builtAt() {
  try {
    return require("./atlas").status().builtAt ?? null;
  } catch {
    return null;
  }
}

async function postJson(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    return Boolean(res && res.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** 发送一对（已确认两端都有全谱编号）；成功（2xx）才记入已报集合。 */
async function sendPair(a, b, type, url) {
  // 无向类型在请求体里也按 Q 号升序，与键一致。
  let x = a;
  let y = b;
  if (UNDIRECTED.has(type) && qNum(x) > qNum(y)) [x, y] = [y, x];
  const key = `${x}|${y}|${type}`;
  if (readSent().has(key)) return { sent: false };
  const device = deviceId();
  if (!device) return { sent: false };
  const ok = await postJson(url, { a: x, b: y, type, device, atlasBuiltAt: builtAt() });
  if (!ok) return { sent: false };
  // 读-改-写在同一段同步代码内完成（wait 之后无 await），并发上报不会互相覆盖。
  const set = readSent();
  set.add(key);
  writeSent(set);
  return { sent: true };
}

/**
 * 关系确认落库成功后调用：{ fromId, toId, type }（也接受 fromKnowledgePointId / toKnowledgePointId / relationType）。
 * 只在开关开、地址非空、两端都有全谱编号、且这对还没报过时发一次。永不抛错。
 */
async function queue(relation) {
  try {
    if (!enabled()) return { sent: false };
    const url = endpoint();
    if (!url) return { sent: false };
    const r = relation || {};
    const fromId = r.fromId ?? r.fromKnowledgePointId;
    const toId = r.toId ?? r.toKnowledgePointId;
    const type = String(r.type ?? r.relationType ?? "");
    if (!type) return { sent: false };
    const a = atlasIdOf(fromId);
    const b = atlasIdOf(toId);
    if (!a || !b || a === b) return { sent: false };
    return await sendPair(a, b, type, url);
  } catch {
    return { sent: false };
  }
}

/**
 * 启动时补报：所有「两端都挂了全谱节点、本地还没报过」的确认关系，最多 200 条/轮，并发 2。
 * 开关关或地址为空时什么都不做。永不抛错。
 */
async function retryPending() {
  try {
    if (!enabled()) return { sent: 0 };
    const url = endpoint();
    if (!url) return { sent: 0 };
    const rows = H().queryAll(
      `SELECT r.from_knowledge_point_id AS fromId, r.to_knowledge_point_id AS toId, r.relation_type AS type,
              kf.atlas_id AS a, kt.atlas_id AS b
         FROM knowledge_relations r
         JOIN knowledge_points kf ON kf.id = r.from_knowledge_point_id
         JOIN knowledge_points kt ON kt.id = r.to_knowledge_point_id
        WHERE r.is_deleted = 0 AND kf.is_deleted = 0 AND kt.is_deleted = 0
          AND kf.atlas_id IS NOT NULL AND kt.atlas_id IS NOT NULL
        ORDER BY r.created_at ASC, r.id ASC
        LIMIT ?`,
      [RETRY_SCAN]
    );
    const sent = readSent();
    const todo = [];
    for (const row of rows) {
      const a = require("./db").atlasInt(row.a);
      const b = require("./db").atlasInt(row.b);
      if (!a || !b || a === b) continue;
      const type = String(row.type || "");
      if (!type) continue;
      const ka = "Q" + a;
      const kb = "Q" + b;
      if (sent.has(sentKey(ka, kb, type))) continue;
      todo.push([ka, kb, type]);
      if (todo.length >= RETRY_MAX) break;
    }
    let sentCount = 0;
    let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const [a, b, type] = todo[idx++];
        const r = await sendPair(a, b, type, url);
        if (r.sent) sentCount++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(RETRY_CONCURRENCY, todo.length) }, worker));
    return { sent: sentCount };
  } catch {
    return { sent: 0 };
  }
}

module.exports = { enabled, endpoint, deviceId, queue, retryPending, sentKey, _keys: { DEVICE_KEY, SENT_KEY } };
