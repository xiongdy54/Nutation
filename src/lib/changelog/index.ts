// v49.173 / D343：更新日志——类型、纯函数判定、面板开关（设计 docs/design/CHANGELOG-VIEWER.md）。
// 纯函数部分不依赖 DOM / IPC，供 tests/changelog.test.cjs 直接覆盖第 3 节全部分支。
import type { Locale } from "../i18n";

export type ChangelogKind = "new" | "improved" | "fixed";

/** 正文多语：zh 必填；en / ja 缺省回落 zh；zh-TW 由调用方经 t() 运行时转换 */
export interface L10n {
  zh: string;
  en?: string;
  ja?: string;
}

export interface ChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  summary?: L10n;
  items: { kind: ChangelogKind; text: L10n }[];
}

/** 分组显示顺序与组名（组名是界面文案，渲染时过 t()） */
export const KIND_ORDER: ChangelogKind[] = ["new", "improved", "fixed"];
export const KIND_LABEL: Record<ChangelogKind, string> = { new: "新增", improved: "改进", fixed: "修复" };

/** 取该语言的原文；zh-CN / zh-TW 都返回 zh（zh-TW 的繁体转换交给 t()） */
export function pickText(text: L10n, locale: Locale): string {
  if (locale === "en" && text.en) return text.en;
  if (locale === "ja" && text.ja) return text.ja;
  return text.zh;
}

/** 按 KIND_ORDER 分组，空组省略；组内保持原顺序 */
export function groupItems(entry: ChangelogEntry): { kind: ChangelogKind; texts: L10n[] }[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    texts: entry.items.filter((it) => it.kind === kind).map((it) => it.text)
  })).filter((g) => g.texts.length > 0);
}

export function findEntry(entries: ChangelogEntry[], version: string): ChangelogEntry | null {
  return entries.find((e) => e.version === version) ?? null;
}

export type NoticeDecision =
  /** 显示提示，并把已读版本写成当前版本 */
  | "show"
  /** 不显示，但把已读版本写成当前版本（全新安装） */
  | "record"
  /** 什么都不做 */
  | "none";

/**
 * 是否提示（设计稿 §3）：
 *  - 当前版本无条目（开发版 0.0.2 等）→ none
 *  - 已读 == 当前 → none
 *  - 已读为空：书架为空＝全新安装 → record；书架非空＝老用户首次升级 → show
 *  - 已读为其他版本 → show
 */
export function decideNotice(input: {
  currentVersion: string;
  seenVersion: unknown;
  hasEntry: boolean;
  libraryEmpty: boolean;
}): NoticeDecision {
  const { currentVersion, hasEntry, libraryEmpty } = input;
  if (!currentVersion || !hasEntry) return "none";
  const seen = typeof input.seenVersion === "string" ? input.seenVersion.trim() : "";
  if (seen === currentVersion) return "none";
  if (!seen) return libraryEmpty ? "record" : "show";
  return "show";
}

export const SEEN_KEY = "changelogSeenVersion";

// ---------- 面板开关（App 持有面板；设置·关于与提示链接经这里请求打开） ----------
const listeners = new Set<() => void>();

export function requestOpenChangelog(): void {
  for (const fn of listeners) fn();
}

export function onOpenChangelog(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
