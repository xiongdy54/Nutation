// v49.132 / D299：生成式 UI 设置（读侧归一；与主进程 settings:set 写侧同规）。
// app.genuiAutoCards：追问中自动识别制卡意图（默认开，仅严格 false 为关）。
import { useEffect, useState } from "react";
import { settingsStore } from "./settings";

export function normalizeGenuiAutoCards(v: unknown): boolean {
  return v !== false;
}

export async function readGenuiAutoCards(): Promise<boolean> {
  try {
    return normalizeGenuiAutoCards(await settingsStore.get<unknown>("app", "genuiAutoCards", true));
  } catch {
    return true;
  }
}

export function useGenuiAutoCards(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    let alive = true;
    void readGenuiAutoCards().then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    void settingsStore.set("app", "genuiAutoCards", v);
  };
  return [on, set];
}
