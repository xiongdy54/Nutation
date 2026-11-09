// 选区浮条图标集（D266）——24 网格 / 1.8 描边 / 圆头圆角 / 无填充，渲染 18px。
// 文字版完全不渲染本文件里的图标；图标版六个动作与两个形式段全部走这里。
// 功能名称由按钮 aria-label + data-tip（120ms 自绘 tooltip）承担；颜色一律 currentColor。
import type { ReactNode } from "react";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

/** 摘录：左竖线 + 三行文本（沿用品牌 excerpt 语义） */
export const IconSelExcerpt = () => (
  <Svg>
    <path d="M5 4.5v15" {...S} />
    <path d="M9 7h10M9 12h10M9 17h6.5" {...S} />
  </Svg>
);

/** 批注：气泡 + 一条短线 */
export const IconSelNote = () => (
  <Svg>
    <path d="M5 5.5h14a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6h-8.4L6 20v-3.9H5a1.6 1.6 0 0 1-1.6-1.6V7.1A1.6 1.6 0 0 1 5 5.5z" {...S} />
    <path d="M7.5 10h9" {...S} />
  </Svg>
);

/** 制卡：单卡 + 加号 */
export const IconSelCard = () => (
  <Svg>
    <rect x="4.5" y="5.5" width="15" height="13" rx="1.8" {...S} />
    <path d="M12 9.5v5M9.5 12h5" {...S} />
  </Svg>
);

/** AI 制卡：单卡 + 四角星（AI 通用星芒） */
export const IconSelAiCards = () => (
  <Svg>
    <rect x="3.5" y="7" width="12.5" height="11.5" rx="1.6" {...S} />
    <path d="M18 3.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" {...S} />
  </Svg>
);

/** AI 解释：灯泡 + 灯座线 */
export const IconSelExplain = () => (
  <Svg>
    <path d="M12 3.5a5.6 5.6 0 0 0-3.3 10.2c.5.4.8.9.8 1.5v.3h5v-.3c0-.6.3-1.1.8-1.5A5.6 5.6 0 0 0 12 3.5z" {...S} />
    <path d="M9.5 18.5h5" {...S} />
  </Svg>
);

/** 查词：放大镜 */
export const IconSelLookup = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.2" {...S} />
    <path d="M15.2 15.2L20 20" {...S} />
  </Svg>
);

/** 形式 · 底色：荧光笔 + 基线（仅图标版） */
export const IconSelFormFill = () => (
  <Svg>
    <path d="M4 20h16" {...S} />
    <path d="M7 16.5l8.2-8.2 3 3L10 19.5H7z" {...S} />
    <path d="M14.2 5.8l3 3" {...S} />
  </Svg>
);

/** 形式 · 下划线：U + 基线（仅图标版） */
export const IconSelFormUnderline = () => (
  <Svg>
    <path d="M7 4.5v7a5 5 0 0 0 10 0v-7" {...S} />
    <path d="M5 20h14" {...S} />
  </Svg>
);

/* ---------- 批注浮层 v2（D267）：复用同一 <Svg> 包装，尺寸由消费方 CSS 覆盖 ---------- */

/** 卡片计数：卡面 + 两行字（不是「加卡」动作，与 IconSelCard 区分） */
export const IconSelCardCount = () => (
  <Svg>
    <rect x="4.5" y="5.5" width="15" height="13" rx="1.8" {...S} />
    <path d="M8 9.5h8M8 13.5h5" {...S} />
  </Svg>
);

/** 删除：垃圾桶 */
export const IconSelTrash = () => (
  <Svg>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M7 7l.9 12.5h8.2L17 7" {...S} />
    <path d="M10.5 11v5M13.5 11v5" {...S} />
  </Svg>
);

/** 保存完成：对勾 */
export const IconSelCheck = () => (
  <Svg>
    <path d="M4.5 12.5l5 5L19.5 7" {...S} />
  </Svg>
);
