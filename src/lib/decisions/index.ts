// D299：判断层对外入口（渲染层）。首次 decide 时惰性注册 LLM 后端（经 aiGateway，走用户已配置的模型）。
// 将来：registerDecisionBackend(createJevBackend(...)) / createCloudBackend(...) + setDecisionBackendOrder([...])。
import { aiGateway, aiConfigUsable } from "../ai";
import { decide as rawDecide, registerDecisionBackend, setDecisionLogSink, type DecideOptions, type DecisionLogEntry } from "./gateway";
import { createLlmBackend } from "./llmBackend";
import type { DecisionInput, DecisionResult, DecisionSpec } from "./types";

declare global {
  interface Window {
    /** v49.132（D299）：判断层留痕桥（decision_log；主进程逐字段归一、不记正文） */
    decisionsAPI?: {
      append: (entry: DecisionLogEntry) => Promise<unknown>;
      patchLast: (specId: string, inputHash: string, override: Record<string, unknown>) => Promise<unknown>;
      list: (limit?: number) => Promise<DecisionLogEntry[]>;
    };
  }
}

let installed = false;
function ensureDefaultBackends() {
  if (installed) return;
  installed = true;
  // 日志落 SQLite（无桥＝单测/独立页：保留 gateway 缺省的内存 sink）；写失败静默，不影响判断
  const api = typeof window !== "undefined" ? window.decisionsAPI : undefined;
  if (api) {
    setDecisionLogSink({
      append: (e) => void api.append(e).catch(() => undefined),
      patchLast: (id, h, o) => void api.patchLast(id, h, o).catch(() => undefined),
      list: (limit) => api.list(limit).catch(() => [])
    });
  }
  registerDecisionBackend(
    createLlmBackend(
      (messages, temperature, onCancelRegister, feature) =>
        aiGateway.chat(messages, undefined, temperature, undefined, onCancelRegister, feature ?? "judge"),
      async () => {
        try {
          const cfg = await window.aiAPI?.getConfig();
          return aiConfigUsable(cfg ?? null);
        } catch {
          return false;
        }
      }
    )
  );
}

export function decide(spec: DecisionSpec, input: DecisionInput, opts?: DecideOptions): Promise<DecisionResult> {
  ensureDefaultBackends();
  return rawDecide(spec, input, opts);
}

export { recordDecisionOverride, registerDecisionBackend, setDecisionBackendOrder, decisionLog } from "./gateway";
export * from "./types";
export { CARD_INTENT_SPEC, PRESENTATION_SPEC, presentationKinds } from "./specs";

/** 改判回填前确保 sink 已就位（用户可能在任何 decide 之前就改了判断） */
export { ensureDefaultBackends as ensureDecisionLayer };
