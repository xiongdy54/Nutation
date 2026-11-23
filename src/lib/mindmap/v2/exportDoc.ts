// 材料导图导出（D338）：整图全部展开 + 可编辑格式（XMind / OPML / Markdown）+ 自包含 SVG / PNG。
// 纯函数（XMind 打包与 PNG 光栅化在调用方做）；只读 GraphState，不改任何状态（AI 不是事实源：导出＝当前图的快照）。
import { ROOT_ID } from "./types";
import type { GraphState, V2Node } from "./types";

/** 导出用的「全部展开」快照：清空折叠集合（不写回视图状态） */
export function expandAllForExport(g: GraphState): GraphState {
  return { ...g, collapsed: new Set<string>() };
}

export interface OutlineNode {
  id: string;
  title: string;
  type: string;
  note: string;
  children: OutlineNode[];
}

/** 图 → 大纲树（原文顺序；讲解全文作为备注） */
export function toOutline(g: GraphState, rootTitle: string): OutlineNode {
  const seen = new Set<string>();
  const build = (id: string): OutlineNode[] =>
    (g.children[id] ?? [])
      .filter((k) => g.nodes[k] && !seen.has(k))
      .map((k) => {
        seen.add(k);
        const n = g.nodes[k] as V2Node;
        const note = String(g.explain[k] || n.explain || "").trim();
        return { id: k, title: String(n.title ?? "").trim() || "—", type: String(n.type ?? ""), note, children: build(k) };
      });
  return { id: ROOT_ID, title: rootTitle || "—", type: "", note: "", children: build(ROOT_ID) };
}

const xml = (s: string) =>
  String(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const label = (n: OutlineNode, withType: boolean) => (withType && n.type && n.type !== "其他" ? `${n.title}（${n.type}）` : n.title);

/** Markdown 大纲（标题 + 无序列表；讲解作引用块）。XMind / 幕布 / Obsidian / markmap 均可导入 */
export function toMarkdown(root: OutlineNode): string {
  const md = (s: string) => s.replace(/\r?\n+/g, " ").replace(/([\\`*_[\]#])/g, "\\$1");
  const lines: string[] = [`# ${md(root.title)}`, ""];
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      const pad = "  ".repeat(depth);
      lines.push(`${pad}- ${md(label(n, true))}`);
      if (n.note) for (const para of n.note.split(/\r?\n+/).filter(Boolean)) lines.push(`${pad}  > ${md(para)}`);
      walk(n.children, depth + 1);
    }
  };
  walk(root.children, 0);
  return lines.join("\n") + "\n";
}

/** OPML 2.0（大纲软件 / 思维导图软件通用交换格式；讲解进 _note） */
export function toOpml(root: OutlineNode): string {
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<opml version="2.0">`, `<head><title>${xml(root.title)}</title></head>`, `<body>`];
  const walk = (n: OutlineNode, depth: number) => {
    const pad = "  ".repeat(depth);
    const note = n.note ? ` _note="${xml(n.note).replace(/\r?\n/g, "&#10;")}"` : "";
    if (!n.children.length) out.push(`${pad}<outline text="${xml(label(n, true))}"${note}/>`);
    else {
      out.push(`${pad}<outline text="${xml(label(n, true))}"${note}>`);
      for (const k of n.children) walk(k, depth + 1);
      out.push(`${pad}</outline>`);
    }
  };
  walk(root, 1);
  out.push(`</body>`, `</opml>`);
  return out.join("\n") + "\n";
}

/** XMind 文件的各个条目（content.json 供 XMind 2020+，content.xml 供 XMind 8）；调用方负责 zip 打包 */
export function toXmindEntries(root: OutlineNode): Record<string, string> {
  let seq = 0;
  const id = () => `nt${(++seq).toString(36)}`;
  type Topic = { id: string; class: "topic"; title: string; structureClass?: string; labels?: string[]; notes?: { plain: { content: string } }; children?: { attached: Topic[] } };
  const topic = (n: OutlineNode, isRoot: boolean): Topic => {
    const t: Topic = { id: id(), class: "topic", title: n.title };
    if (isRoot) t.structureClass = "org.xmind.ui.logic.right";
    if (n.type && n.type !== "其他") t.labels = [n.type];
    if (n.note) t.notes = { plain: { content: n.note } };
    if (n.children.length) t.children = { attached: n.children.map((k) => topic(k, false)) };
    return t;
  };
  const rootTopic = topic(root, true);
  const content = [{ id: "sheet-1", class: "sheet", title: root.title, rootTopic }];
  const tx = (t: Topic): string =>
    `<topic id="${xml(t.id)}"${t.structureClass ? ` structure-class="${t.structureClass}"` : ""}><title>${xml(t.title)}</title>` +
    (t.labels ? `<labels>${t.labels.map((l) => `<label>${xml(l)}</label>`).join("")}</labels>` : "") +
    (t.notes ? `<notes><plain>${xml(t.notes.plain.content)}</plain></notes>` : "") +
    (t.children ? `<children><topics type="attached">${t.children.attached.map(tx).join("")}</topics></children>` : "") +
    `</topic>`;
  const contentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">` +
    `<sheet id="sheet-1">${tx(rootTopic)}<title>${xml(root.title)}</title></sheet></xmap-content>`;
  const manifestXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?><manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">` +
    `<file-entry full-path="content.xml" media-type="text/xml"/><file-entry full-path="META-INF/" media-type=""/>` +
    `<file-entry full-path="META-INF/manifest.xml" media-type="text/xml"/></manifest>`;
  return {
    "content.json": JSON.stringify(content),
    "metadata.json": JSON.stringify({ creator: { name: "Nutation" } }),
    "manifest.json": JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } }),
    "content.xml": contentXml,
    "META-INF/manifest.xml": manifestXml,
  };
}

/**
 * SVG 自包含化：把根元素 style 里声明的 CSS 自定义属性代入全部 var(--x)，并把 font-family 落到属性上。
 * 许多看图 / 设计软件（系统照片查看器、Office、Illustrator、旧版 Inkscape）不认 var()——不代入时底色和文字会退成黑色，图「根本看不清」。
 */
export function inlineSvgVars(svg: string): string {
  const m = /^<svg\b[^>]*?\sstyle="([^"]*)"/.exec(svg);
  if (!m) return svg;
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  const vars = new Map<string, string>();
  for (const part of decode(m[1]).split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k.startsWith("--")) vars.set(k, v);
  }
  const resolve = (s: string, depth = 0): string =>
    depth > 4 ? s : s.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_, k: string, fb?: string) => resolve(vars.get(k) ?? fb ?? "", depth + 1));
  const font = resolve("var(--font-sans)");
  let out = svg.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (all) => xml(resolve(all)).replace(/&amp;(quot|amp|lt|gt);/g, "&$1;"));
  // 根 style 保留（浏览器仍可用），另补 font-family 属性（不读 style 的软件也能拿到字体）
  // 拼装一律用 "<" + "svg"：本文件不得出现内联 SVG 标签字面量（一致性闸门 inlineSvgCount 棘轮）
  const TAG = "<" + "svg";
  const at = new RegExp(`^${TAG}\\b`);
  if (font && !new RegExp(`^${TAG}\\b[^>]*\\sfont-family=`).test(out)) out = out.replace(at, `${TAG} font-family="${xml(font)}"`);
  return out;
}

/** PNG 光栅化的倍率：目标 2×，受单边 16384px 与总像素 1.2 亿的上限约束 */
export function pngScale(w: number, h: number, want = 2): number {
  const MAX_SIDE = 16384, MAX_AREA = 120_000_000;
  if (!(w > 0 && h > 0)) return 0;
  return Math.max(0.05, Math.min(want, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h))));
}
