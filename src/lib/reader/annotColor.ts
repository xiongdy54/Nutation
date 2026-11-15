// 批注色的渲染取值（批 4 修正：规格 §5.4「颜色对应」一处实现）。
// 用户 2026-09-28 指出：文中高亮必须与栏内竖线/色点/角标**同色**——此前阅读器把
// 所有标记都按 accent 画（样张的 `.q` 是 `--qcol`/`--qline` 按条取色），
// 结果「角标跟色、高亮不跟色」自相矛盾。
//
// 色值两种来源：色板 id（red/orange/…）→ 取 `--annot-<id>` Token 族；
// `#hex`（设置里的自定义色）→ 原样用实色，透明档用 color-mix 现场算。
// 透明档口径由 Token 族自带（浅档「实色逐色定透明度 27–41%」，v49.129 / D296；深档「实色混白 30% 后
// 逐色定透明度 31–40%」，v49.128 / D295）；`#hex` 现场算的那一支不写死百分比，改读两枚「口径 Token」
// （--annot-hex-soft-mix / -alpha，浅档 100% × 34%、深档 70% × 38%）——自定义色必须跟色板同一套深浅口径，
// 否则浅色下明显更淡、深色下明显更暗。
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

/** 该批注色的**实色**（栏内竖线、色点、角标、文中的左缘条） */
export function annotSolid(color?: string | null, fallback = "var(--accent)"): string {
  const c = String(color ?? "").trim();
  if (!c) return fallback;
  return HEX_RE.test(c) ? c : `var(--annot-${c})`;
}

/** 该批注色的**透明档**（文中高亮底色） */
export function annotSoft(color?: string | null, fallback = "var(--accent-soft)"): string {
  const c = String(color ?? "").trim();
  if (!c) return fallback;
  if (!HEX_RE.test(c)) return `var(--annot-${c}-soft)`;
  // 自定义 #hex：口径取 Token（--annot-hex-soft-mix / -alpha 由 :root / body.theme-dark 各声明一次，
  // 混色目标色取 --annot-soft-whiten）——与色板 id 同一条深色提亮规则，不写死百分比与裸色值
  return `color-mix(in srgb, color-mix(in srgb, ${c} var(--annot-hex-soft-mix), var(--annot-soft-whiten)) var(--annot-hex-soft-alpha), transparent)`;
}

/** 参与 CSS 名字/键的稳定标识（同一色恒同键，便于按色分组注册高亮） */
export function annotKey(color?: string | null): string {
  const c = String(color ?? "").trim();
  if (!c) return "default";
  return HEX_RE.test(c) ? `hex-${c.slice(1).toLowerCase()}` : c;
}
