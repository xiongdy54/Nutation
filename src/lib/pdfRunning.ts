/** PDF 页眉 / 页脚 / 页码剔除（送入材料导图引擎前清洗逐页原文）。
 *  只看首尾各 2 行，与相邻页同边缘行比对；正文中间行永不删除。 */

const BARE_PAGE_NUMBER =
  /^\s*[-–—(\[]?\s*(page\s*)?(\d{1,4}|[ivxlcdm]{1,6})\s*([-–—)\]]|\/\s*\d{1,4})?\s*$/i;
const CJK_PAGE_NUMBER = /^\s*第\s*\d{1,4}\s*页\s*$/;

function isBarePageNumber(line: string): boolean {
  return BARE_PAGE_NUMBER.test(line) || CJK_PAGE_NUMBER.test(line);
}

/** 归一化：去首尾空白、折叠空白、数字串→#、小写 */
function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .toLowerCase();
}

type Edge = "top" | "bottom";

/** 取某页某边缘的行（首 2 行 / 尾 2 行） */
function edgeLines(lines: string[], edge: Edge): string[] {
  if (edge === "top") return lines.slice(0, 2);
  return lines.length <= 2 ? lines.slice() : lines.slice(-2);
}

/** 该行在该边缘上是否在至少 2 个相邻页重复出现 */
function repeatedOnEdge(line: string, edge: Edge, pages: (string | undefined)[], i: number): boolean {
  const norm = normalizeLine(line);
  if (norm.length < 2) return false;
  let hits = 0;
  for (const j of [i - 2, i - 1, i + 1, i + 2]) {
    if (j < 0 || j >= pages.length) continue;
    const text = pages[j];
    if (text === undefined) continue;
    if (edgeLines(text.split("\n"), edge).some((l) => normalizeLine(l) === norm)) hits++;
  }
  return hits >= 2;
}

/** Remove running headers/footers/page numbers from page i, judging against neighbor pages.
 *  pages: canonical page texts (lines separated by "\n"); entries may be undefined if not loaded.
 *  Returns page i's text with offending edge lines removed (joined with "\n"). */
export function stripRunningLines(pages: (string | undefined)[], i: number): string {
  const original = pages[i];
  if (original === undefined) return "";
  const lines = original.split("\n");
  const n = lines.length;
  const removed = new Array<boolean>(n).fill(false);

  // 上边缘：从第 0 行向内，最多 2 行，遇到保留的行即停。
  for (let p = 0; p < Math.min(2, n); p++) {
    if (isBarePageNumber(lines[p]) || repeatedOnEdge(lines[p], "top", pages, i)) removed[p] = true;
    else break;
  }

  // 下边缘：从最后一行向内，最多 2 行。
  for (let d = 0; d < 2; d++) {
    const idx = n - 1 - d;
    if (idx < 0) break;
    if (removed[idx]) continue;
    if (isBarePageNumber(lines[idx]) || repeatedOnEdge(lines[idx], "bottom", pages, i)) removed[idx] = true;
    else break;
  }

  if (removed.every(Boolean)) return original;
  return lines.filter((_, idx) => !removed[idx]).join("\n");
}
