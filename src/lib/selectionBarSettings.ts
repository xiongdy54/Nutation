// 选区浮条呈现设置（D122 / D266）——app.selectionBarStyle 的读侧归一 + 订阅 hook。
//   app.selectionBarStyle   "text" | "icon"   默认 "text"（D266：六个动作全部文字、全条无 svg；
//                                              "icon"＝六个动作全部图标、全条无文字，名称走 tooltip + aria-label）
// 取代 D95 §K.4 的 app.readerActionsFloat（该键与悬浮动作组一并退役）。
// 写侧归一在 electron/main.js settings:set；这里是渲染层读侧的第二道（非法值一律回落 text）。
import { useEffect, useState } from "react";
import { settingsStore } from "./settings";
import { eventBus } from "./eventbus";

export type SelectionBarStyle = "icon" | "text";
export const DEFAULT_SELECTION_BAR_STYLE: SelectionBarStyle = "text";

export function normalizeSelectionBarStyle(v: unknown): SelectionBarStyle {
  return v === "icon" ? "icon" : "text";
}

/** 订阅（设置页改动即时生效） */
export function useSelectionBarStyle(): SelectionBarStyle {
  const [style, setStyle] = useState<SelectionBarStyle>(DEFAULT_SELECTION_BAR_STYLE);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void settingsStore
        .get<unknown>("app", "selectionBarStyle", DEFAULT_SELECTION_BAR_STYLE)
        .then((v) => {
          if (alive) setStyle(normalizeSelectionBarStyle(v));
        });
    };
    load();
    const off = eventBus.on("settings/changed", (p) => {
      const payload = p as { scope?: string; key?: string } | undefined;
      if (payload?.scope === "app" && payload.key === "selectionBarStyle") load();
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  return style;
}
