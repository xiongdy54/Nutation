"use strict";
// D315 完整全谱下载：设置 atlasFullUrl（默认空）→ <userData>/atlas/atlas.sqlite.part（HTTP Range 续传）→ 可选 sha256 校验 → 改名 atlas.sqlite → atlas._reset()。
// 只在用户点「下载」时联网；失败 / 取消保留 .part 供下次续传。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

let job = null; // { received, total, abort }

function dir() {
  return path.join(require("electron").app.getPath("userData"), "atlas");
}
function appSettings() {
  try {
    return require("./settingsStore").readSettings().app || {};
  } catch {
    return {};
  }
}
function fullUrl() {
  const u = appSettings().atlasFullUrl;
  return typeof u === "string" ? u.trim() : "";
}

function state() {
  const url = fullUrl();
  let partBytes = 0;
  try {
    partBytes = fs.statSync(path.join(dir(), "atlas.sqlite.part")).size;
  } catch {
    /* 无半截文件 */
  }
  return { urlConfigured: !!url, downloading: job ? { received: job.received, total: job.total } : null, partBytes };
}

function request(url, headers, signal, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(request(new URL(res.headers.location, u).toString(), headers, signal, redirects - 1));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    if (signal) signal.addEventListener("abort", () => req.destroy(Object.assign(new Error("已取消"), { code: "ABORT" })), { once: true });
  });
}

/** 把 url 的内容续写进 part（part 里此前已有 base 字节属于别的部分，本资源已收 have 字节）。返回 "ok" | "complete"（416：远端不比已有的长）。 */
async function fetchInto(url, part, base, have, ctrl, onChunk) {
  const res = await request(url, have ? { Range: `bytes=${have}-` } : {}, ctrl.signal);
  if (res.statusCode === 416) {
    res.resume();
    return "complete";
  }
  if (res.statusCode === 200 && have) {
    have = 0; // 服务器不支持 Range：本资源从头来
    fs.truncateSync(part, base);
    onChunk({ reset: base });
  } else if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    throw new Error(`下载失败：HTTP ${res.statusCode}`);
  }
  onChunk({ length: Number(res.headers["content-length"]) || 0, have });
  const out = fs.createWriteStream(part, { flags: base + have ? "a" : "w" });
  try {
    await new Promise((resolve, reject) => {
      res.on("data", (c) => onChunk({ bytes: c.length }));
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.on("aborted", () => reject(new Error("连接中断")));
      res.on("close", () => {
        if (!res.complete) reject(new Error("连接中断"));
      });
      res.pipe(out);
    });
  } catch (e) {
    // 先把已收到的字节落盘再抛错，.part 才能用于续传
    await new Promise((r) => out.end(r));
    throw e;
  }
  return "ok";
}

function sha256File(file, start, end) {
  const h = crypto.createHash("sha256");
  const opts = end == null ? {} : { start, end: end - 1 };
  return new Promise((resolve, reject) => fs.createReadStream(file, opts).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject));
}

const isJsonUrl = (u) => {
  try {
    return /\.json$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
};

async function readJson(url, signal) {
  const res = await request(url, {}, signal);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`下载失败：HTTP ${res.statusCode}`);
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function start(onProgress) {
  if (job) throw new Error("已有下载在进行");
  const url = fullUrl();
  if (!url) throw new Error("未配置完整全谱下载地址");
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const part = path.join(d, "atlas.sqlite.part");
  const final = path.join(d, "atlas.sqlite");
  const ctrl = new AbortController();
  job = { received: 0, total: 0, abort: () => ctrl.abort() };
  try {
    let have = 0;
    try {
      have = fs.statSync(part).size;
    } catch {
      /* 新下载 */
    }
    job.received = have;
    const report = () => onProgress && onProgress({ received: job.received, total: job.total });
    let want = String(appSettings().atlasFullSha256 || "").trim().toLowerCase();
    if (isJsonUrl(url)) {
      // 分卷：{ parts:[{url,size,sha256}], size, sha256 }；相对地址按清单地址解析；各卷依次续写进同一个 .part
      const man = await readJson(url, ctrl.signal);
      const parts = Array.isArray(man && man.parts) ? man.parts : [];
      if (!parts.length || parts.some((p) => !p || !p.url || !(Number(p.size) > 0))) throw new Error("分卷清单无效：缺少 url 或 size");
      job.total = Number(man.size) || parts.reduce((n, p) => n + Number(p.size), 0);
      if (man.sha256) want = String(man.sha256).trim().toLowerCase();
      let cum = 0;
      for (const p of parts) {
        const size = Number(p.size);
        const end = cum + size;
        if (have < end) {
          const base = cum;
          const r = await fetchInto(new URL(p.url, url).toString(), part, base, have - base, ctrl, (e) => {
            if (e.reset != null) job.received = e.reset;
            else if (e.bytes) {
              job.received += e.bytes;
              report();
            }
          });
          if (r === "complete" && fs.statSync(part).size < end) throw new Error("分卷下载不完整");
          if (fs.statSync(part).size !== end) throw new Error("分卷大小与清单不符");
          if (p.sha256 && (await sha256File(part, base, end)) !== String(p.sha256).trim().toLowerCase()) {
            fs.truncateSync(part, base); // 丢弃这一卷，其余已验证的卷保留
            throw new Error("校验失败：分卷已丢弃，请重新下载");
          }
          have = end;
        }
        cum = end;
      }
    } else {
      const r = await fetchInto(url, part, 0, have, ctrl, (e) => {
        if (e.reset != null) job.received = e.reset;
        else if (e.length != null) {
          job.total = e.have + e.length;
          job.received = e.have;
        } else if (e.bytes) {
          job.received += e.bytes;
          report();
        }
      });
      // 416：半截文件已不小于远端，当作已完整下载（让校验决定）
      if (r === "complete") job.total = have;
    }
    if (want) {
      if ((await sha256File(part)) !== want) {
        fs.rmSync(part, { force: true });
        throw new Error("校验失败：文件已丢弃，请重新下载");
      }
    }
    fs.renameSync(part, final);
    require("./atlas")._reset();
    return { ...state(), done: true };
  } finally {
    job = null;
  }
}

function cancel() {
  if (job) job.abort();
  return true;
}

module.exports = { start, cancel, state };
