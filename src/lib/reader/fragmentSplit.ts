// 同文件多章切段（docs/design/STRUCTURE-GRAPH-DIAGNOSIS-2026-11.md P3-f）。
// EPUB 目录常见「一个 xhtml 装多章、目录用 #id 指到章首」；按文件取文会让第一个目录项吞掉整文件。
// 这里按片段元素在文档序中的位置切出 fragments.length+1 段，每段包成一个可随意改动的 <div> 副本，供 canonical 抽取。

function findTarget(doc: Document, frag: string): Element | null {
  let id = frag;
  try {
    id = decodeURIComponent(frag);
  } catch {
    /* 保留原样 */
  }
  return doc.getElementById(id) ?? doc.getElementsByName(id)[0] ?? null;
}

/** 返回 fragments.length + 1 个包装元素；找不到 / 位置倒序的片段对应空包装，其文字留在前一段 */
export function splitByFragments(doc: Document, fragments: string[]): Element[] {
  const root = (doc.body || doc.documentElement) as Element | null;
  const wrap = () => doc.createElement("div");
  if (!root) return [wrap(), ...fragments.map(wrap)];
  // 每个片段的起点（元素之前）；不可用的记 null
  const starts: (Element | null)[] = [];
  let prev: Element | null = null;
  for (const f of fragments) {
    const el = findTarget(doc, f);
    const ok = !!el && root.contains(el) && (!prev || (prev.compareDocumentPosition(el) & 4 /* DOCUMENT_POSITION_FOLLOWING（iframe 文档不共享宿主 Node 全局） */) !== 0);
    starts.push(ok ? el : null);
    if (ok) prev = el;
  }
  const out: Element[] = [];
  let from: { node: Node; before: boolean } = { node: root, before: false }; // false＝root 内部开头
  const seg = (endEl: Element | null): Element => {
    const r = doc.createRange();
    if (from.node === root) r.setStart(root, 0);
    else r.setStartBefore(from.node);
    if (endEl) r.setEndBefore(endEl);
    else r.setEnd(root, root.childNodes.length);
    const w = wrap();
    w.appendChild(r.cloneContents());
    return w;
  };
  const idxOk = starts.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  // 第 0 段：开头 → 第一个可用片段
  out.push(seg(idxOk.length ? starts[idxOk[0]] : null));
  for (let i = 0; i < fragments.length; i++) {
    const el = starts[i];
    if (!el) {
      out.push(wrap());
      continue;
    }
    from = { node: el, before: true };
    const nextIdx = idxOk.find((k) => k > i);
    out.push(seg(nextIdx != null ? starts[nextIdx] : null));
  }
  return out;
}

/** 目录 → 需要细分的文件：同一文件（base）有 ≥2 个目录项且其中有 #fragment 时，返回该文件的片段（目录序、去重） */
export function fragmentPlan(tocAnchors: string[]): Map<string, string[]> {
  const byBase = new Map<string, { count: number; frags: string[] }>();
  for (const a of tocAnchors) {
    const s = String(a ?? "");
    const k = s.indexOf("#");
    const base = k >= 0 ? s.slice(0, k) : s;
    const frag = k >= 0 ? s.slice(k + 1) : "";
    const e = byBase.get(base) ?? { count: 0, frags: [] };
    e.count++;
    if (frag && !e.frags.includes(frag)) e.frags.push(frag);
    byBase.set(base, e);
  }
  const out = new Map<string, string[]>();
  for (const [base, e] of byBase) if (e.count >= 2 && e.frags.length) out.set(base, e.frags);
  return out;
}
