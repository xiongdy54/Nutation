// D299：组件复制——同时写入 text/plain（Markdown，任意编辑器/Anki/制卡面板可用）与 text/html（富文本，
// Word/飞书/Notion 等粘贴保留表格与公式），HTML 根元素携带 data-nui（base64 JSON），
// 将来制卡面板粘贴可据此无损还原为原生组件（任务卡 T-G5）。
import { blockToMarkdown, fmtSci, parseUIBlock, type TreeNode, type UIBlock } from "./spec";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export function b64json(v: unknown): string {
  const s = JSON.stringify(v);
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 组件 → 富文本 HTML（不依赖 React；公式 HTML 由调用方传入 KaTeX 渲染结果） */
export function blockToHtml(b: UIBlock, formulaHtml?: string): string {
  const title = b.title ? `<p><strong>${esc(b.title)}</strong></p>` : "";
  let body = "";
  switch (b.type) {
    case "formula":
      body = (formulaHtml ?? `<pre>${esc(b.latex)}</pre>`) + (b.vars?.length ? `<ul>${b.vars.map((v) => `<li><code>${esc(v.symbol)}</code>：${esc(v.meaning)}</li>`).join("")}</ul>` : "");
      break;
    case "compare":
      body = `<table border="1" cellpadding="4" style="border-collapse:collapse"><thead><tr><th></th>${b.entities.map((e) => `<th>${esc(e)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr><th>${esc(r.dimension)}</th>${r.values.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
      break;
    case "chart":
      body = `<table border="1" cellpadding="4" style="border-collapse:collapse"><thead><tr><th></th>${b.series.map((s) => `<th>${esc(s.name)}${b.unit ? `（${esc(b.unit)}）` : ""}</th>`).join("")}</tr></thead><tbody>${b.labels
        .map((l, i) => `<tr><th>${esc(l)}</th>${b.series.map((s) => `<td>${s.values[i]}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>${b.note ? `<p>${esc(b.note)}</p>` : ""}`;
      break;
    case "steps":
      body = `<ol>${b.steps.map((s) => `<li><strong>${esc(s.title)}</strong>${s.detail ? `：${esc(s.detail)}` : ""}</li>`).join("")}</ol>`;
      break;
    case "timeline":
      body = `<ul>${b.events.map((e) => `<li><strong>${esc(e.time)}</strong> ${esc(e.title)}${e.detail ? `：${esc(e.detail)}` : ""}</li>`).join("")}</ul>`;
      break;
    case "tree": {
      const walk = (n: TreeNode): string =>
        `<li>${esc(n.label)}${n.note ? `：${esc(n.note)}` : ""}${n.children?.length ? `<ul>${n.children.map(walk).join("")}</ul>` : ""}</li>`;
      body = `<ul>${walk(b.root)}</ul>`;
      break;
    }
    case "quiz":
      body = `<p>${esc(b.question)}</p><ol type="A">${b.options.map((o, i) => `<li>${esc(o)}${i === b.answer ? " ✓" : ""}</li>`).join("")}</ol>${b.explain ? `<p>${esc(b.explain)}</p>` : ""}`;
      break;
    case "pronounce":
      body = `<ul>${b.items.map((i) => `<li><strong>${esc(i.text)}</strong>${i.ipa ? ` /${esc(i.ipa)}/` : ""}${i.meaning ? `：${esc(i.meaning)}` : ""}</li>`).join("")}</ul>`;
      break;
    case "glossary":
      body = `<dl>${b.terms.map((t) => `<dt><strong>${esc(t.term)}</strong>${t.alias ? `（${esc(t.alias)}）` : ""}</dt><dd>${esc(t.def)}</dd>`).join("")}</dl>`;
      break;
    case "analogy":
      body = `<table border="1" cellpadding="4" style="border-collapse:collapse"><thead><tr><th>${esc(b.source)}</th><th>${esc(b.target)}</th></tr></thead><tbody>${b.pairs
        .map((p) => `<tr><td>${esc(p.from)}</td><td>${esc(p.to)}</td></tr>`)
        .join("")}</tbody></table>${b.limit ? `<p>${esc(b.limit)}</p>` : ""}`;
      break;
    case "scale":
      body = `<ul>${b.items.map((i) => `<li>${esc(i.label)}：${esc(fmtSci(i.value))}${b.unit ? ` ${esc(b.unit)}` : ""}${i.note ? `（${esc(i.note)}）` : ""}</li>`).join("")}</ul>`;
      break;
    case "examples":
      body = `<ul>${b.items.map((i) => `<li><strong>${i.kind === "counter" ? "✗" : "✓"}</strong> ${esc(i.text)}${i.why ? `（${esc(i.why)}）` : ""}</li>`).join("")}</ul>`;
      break;
    case "breakdown":
      body = `<blockquote>${esc(b.sentence)}</blockquote><ul>${b.parts.map((p) => `<li><strong>${esc(p.role)}</strong>：${esc(p.text)}${p.note ? ` —— ${esc(p.note)}` : ""}</li>`).join("")}</ul>`;
      break;
    case "html":
      body = `<pre>${esc(b.html)}</pre>`;
      break;
  }
  return `<div data-nui="${b64json(b)}">${title}${body}</div>`;
}

/** 从剪贴板 HTML 取回组件（制卡面板无损粘贴 T-G5）：找 data-nui → base64 → UTF-8 JSON → 重新校验。无 / 坏 → null */
export function decodeNuiHtml(html: string): UIBlock | null {
  const m = /data-nui="([A-Za-z0-9+/=]+)"/.exec(String(html ?? ""));
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const r = parseUIBlock(new TextDecoder().decode(bytes));
    return r.ok ? r.block : null;
  } catch {
    return null;
  }
}

export async function copyBlock(b: UIBlock, formulaHtml?: string): Promise<boolean> {
  const md = blockToMarkdown(b);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([md], { type: "text/plain" }),
          "text/html": new Blob([blockToHtml(b, formulaHtml)], { type: "text/html" })
        })
      ]);
      return true;
    }
  } catch {
    /* 回落纯文本 */
  }
  try {
    await navigator.clipboard.writeText(md);
    return true;
  } catch {
    return false;
  }
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    return false;
  }
}
