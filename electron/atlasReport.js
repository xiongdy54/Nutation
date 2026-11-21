"use strict";
// D315（T8）全谱纠错上报。只发白名单字段 {atlasId, kind, note(≤500), atlasBuiltAt, client}：
// 绝不包含卡片、材料、知识点名称或任何用户文本（note 是用户主动填的说明，仅此一项）。
// 通道：设置 atlasReportUrl 非空 → POST JSON（8 s 超时）；否则打开预填的 GitHub issue 页（shell.openExternal）。
const KINDS = ["name", "gloss", "parent", "relation", "duplicate", "other"];
const NOTE_MAX = 500;
const POST_TIMEOUT_MS = 8000;
// package.json 缺 repository 时的占位（发布前应改成真实仓库）
const ATLAS_REPORT_REPO = "OWNER/REPO";

function pkg() {
  try {
    return require("../package.json");
  } catch {
    return {};
  }
}

function repoSlug() {
  let r = pkg().repository;
  if (r && typeof r === "object") r = r.url;
  if (typeof r !== "string" || !r) return ATLAS_REPORT_REPO;
  const m = /(?:github:|github\.com[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(r) || /^([^/\s:]+\/[^/\s:]+)$/.exec(r);
  return m ? m[1] : ATLAS_REPORT_REPO;
}

function atlasInt(v) {
  const s = String(v == null ? "" : v);
  const n = Number(s[0] === "Q" ? s.slice(1) : s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function clientVersion() {
  try {
    const v = require("electron").app.getVersion();
    if (v) return String(v);
  } catch {
    /* 非 Electron 环境 */
  }
  return String(pkg().version || "");
}

function builtAtOf() {
  try {
    return require("./atlas").status().builtAt || null;
  } catch {
    return null;
  }
}

/** 白名单构造：多余字段一律丢弃 */
function buildReport(input, extra) {
  const i = input || {};
  const n = atlasInt(i.atlasId);
  if (!n) throw new Error("全谱节点无效");
  const kind = KINDS.includes(String(i.kind)) ? String(i.kind) : "other";
  const note = typeof i.note === "string" ? i.note.trim().slice(0, NOTE_MAX) : "";
  const e = extra || {};
  return {
    atlasId: "Q" + n,
    kind,
    note,
    atlasBuiltAt: e.atlasBuiltAt !== undefined ? e.atlasBuiltAt : builtAtOf(),
    client: e.client !== undefined ? e.client : clientVersion()
  };
}

function reportUrlSetting() {
  try {
    const a = require("./settingsStore").readSettings().app || {};
    return typeof a.atlasReportUrl === "string" ? a.atlasReportUrl.trim() : "";
  } catch {
    return "";
  }
}

function issueUrl(rep, repo) {
  const title = `全谱纠错：${rep.atlasId} ${rep.kind}`;
  const body = "```json\n" + JSON.stringify(rep, null, 2) + "\n```";
  return `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

/**
 * opts（测试注入）：{ url, openExternal, repo, atlasBuiltAt, client }
 * 返回 { channel: "post"|"github", ok, url?, error? }
 */
async function report(payload, opts) {
  const o = opts || {};
  const rep = buildReport(payload, { atlasBuiltAt: o.atlasBuiltAt, client: o.client });
  const url = o.url !== undefined ? String(o.url).trim() : reportUrlSetting();
  if (url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rep),
        signal: ctrl.signal
      });
      return res.ok ? { channel: "post", ok: true } : { channel: "post", ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { channel: "post", ok: false, error: String((e && e.message) || e) };
    } finally {
      clearTimeout(t);
    }
  }
  const link = issueUrl(rep, o.repo || repoSlug());
  const open = o.openExternal || ((u) => require("electron").shell.openExternal(u));
  try {
    await open(link);
    return { channel: "github", ok: true, url: link };
  } catch (e) {
    return { channel: "github", ok: false, url: link, error: String((e && e.message) || e) };
  }
}

module.exports = { buildReport, report, issueUrl, repoSlug, KINDS, NOTE_MAX, ATLAS_REPORT_REPO };
