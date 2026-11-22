// 正文「段落」判定（结构流 / 阅读探针共用；docs/design/STRUCTURE-GRAPH-DIAGNOSIS-2026-11.md P2）。
// 叶子块＝块级元素（含 div / section 等容器）且其内部不再含块级元素、并且有可见文字。
// 只认 <p> 会把 Calibre / 网页剪藏里「div>span 当段落、<p> 只包图片或留空」的材料错映射到图片和空白上。

export const BLOCK_SEL = "p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,td,th,figcaption,pre";
/** 叶子判定用的扩展集合：容器类块级元素在「内部无其它块」时也算段落 */
export const BLOCK_SEL_X = `${BLOCK_SEL},div,section,article,aside,header,footer,main,figure,caption`;

export function hasVisibleText(el: Element): boolean {
  return /\S/.test(el.textContent ?? "");
}

export function isLeafBlock(el: Element): boolean {
  return !!el.matches?.(BLOCK_SEL_X) && !el.querySelector(BLOCK_SEL_X);
}

/** 自下而上找最近的块：优先叶子块；遇到含子块的容器（混排文字）也接受，但须有文字 */
export function nearestTextBlock(start: Element | null): Element | null {
  let el: Element | null = start;
  while (el && el.nodeType === 1) {
    const tag = el.tagName?.toLowerCase();
    if (tag === "body" || tag === "html") return null;
    if (el.matches?.(BLOCK_SEL_X)) return hasVisibleText(el) ? el : null;
    el = el.parentElement;
  }
  return null;
}

/** Range 覆盖到的叶子段落（无文字的叶子——纯图片 / 空占位——不算） */
export function leafBlocksInRange(range: Range): Element[] {
  const c = range.commonAncestorContainer;
  const el = (c.nodeType === 1 ? c : c.parentElement) as Element | null;
  if (!el) return [];
  // 公共祖先本身在一个叶子块内 → 就是它
  let up: Element | null = el;
  while (up && up.tagName?.toLowerCase() !== "body") {
    if (up.matches?.(BLOCK_SEL_X)) {
      if (isLeafBlock(up)) return hasVisibleText(up) ? [up] : [];
      break;
    }
    up = up.parentElement;
  }
  return Array.from(el.querySelectorAll(BLOCK_SEL_X)).filter(
    (b) => range.intersectsNode(b) && isLeafBlock(b) && hasVisibleText(b),
  );
}

/** 文档内全部叶子段落（版心测量用） */
export function allLeafBlocks(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll(BLOCK_SEL_X)).filter((b) => isLeafBlock(b) && hasVisibleText(b));
}
