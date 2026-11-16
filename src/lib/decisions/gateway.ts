// D299：判断网关——decide(spec, input) 的唯一入口。
// 流程：本地实现先算（同步、零网络）→ spec.shouldEscalate 判定是否值得走远端 → 按后端优先序尝试
// → 任一失败/超时/不可用即回落本地（fellBack=true），绝不阻断用户操作。
// 将来接 Jev / Gemini Decision 1 / Nutation 托管用量：registerDecisionBackend(adapter) + 调整优先序，调用方零改动。
import type { BackendId, DecisionAnswers, DecisionBackend, DecisionInput, DecisionResult, DecisionSpec } from "./types";
import { actionOf } from "./types";

const backends = new Map<BackendId, DecisionBackend>();

export function registerDecisionBackend(b: DecisionBackend): void {
  backends.set(b.id, b);
}

export function unregisterDecisionBackend(id: BackendId): void {
  backends.delete(id);
}

/** 全局后端优先序覆盖（设置页 / 托管用量模式写入）；null＝按 spec.backends */
let globalOrder: BackendId[] | null = null;
export function setDecisionBackendOrder(order: BackendId[] | null): void {
  globalOrder = order;
}

// ---------- 判断日志（本地；不记正文，只记长度与指纹——与 behavior/track 同纪律） ----------
export interface DecisionLogEntry {
  at: number;
  specId: string;
  specVersion: number;
  backend: BackendId;
  fellBack: boolean;
  ms: number;
  inputLen: number;
  inputHash: string;
  answers: Record<string, { value: unknown; confidence: number; calibrated: boolean }>;
  action: string;
  /** 用户事后改判（recordDecisionOverride 回填）——将来校准阈值 / 对比测试的免费标注 */
  override?: Record<string, unknown>;
}

export interface DecisionLogSink {
  append(e: DecisionLogEntry): void;
  patchLast(specId: string, inputHash: string, override: Record<string, unknown>): void;
  list(limit?: number): DecisionLogEntry[] | Promise<DecisionLogEntry[]>;
}

const MEM_CAP = 500;

/** 缺省 sink：进程内环形缓冲（单测 / 无主进程桥时）。生产由 decisions/index.ts 换成 SQLite（decision_log，经 window.decisionsAPI） */
export function createMemorySink(): DecisionLogSink {
  let mem: DecisionLogEntry[] = [];
  return {
    append(e) {
      mem = [...mem, e].slice(-MEM_CAP);
    },
    patchLast(specId, inputHash, override) {
      for (let i = mem.length - 1; i >= 0; i--) {
        if (mem[i].specId === specId && mem[i].inputHash === inputHash) {
          mem[i] = { ...mem[i], override: { ...(mem[i].override ?? {}), ...override } };
          return;
        }
      }
    },
    list: (limit) => (limit ? mem.slice(-limit) : mem.slice())
  };
}

let sink: DecisionLogSink = createMemorySink();
export function setDecisionLogSink(s: DecisionLogSink): void {
  sink = s;
}
export async function decisionLog(limit?: number): Promise<DecisionLogEntry[]> {
  return sink.list(limit);
}

/** FNV-1a 32 位指纹：只用于把「改判」对回同一次判断，不可逆、不存正文 */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 用户改判回填（例如手动把材料类型从 concept 改成 formula） */
export function recordDecisionOverride(specId: string, inputText: string, override: Record<string, unknown>): void {
  try {
    sink.patchLast(specId, fingerprint(inputText), override);
  } catch {
    /* 日志失败不影响功能 */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error("decision timeout"));
    }, ms);
  });
  return Promise.race([p, t]).finally(() => timer && clearTimeout(timer));
}

export interface DecideOptions {
  onCancelRegister?: (cancel: () => void) => void;
  /** 覆盖 spec.llm.timeoutMs / 缺省 8000 */
  timeoutMs?: number;
  /** 只用本地（例如离线模式、或调用方明确不想多一次请求） */
  localOnly?: boolean;
}

export async function decide(spec: DecisionSpec, input: DecisionInput, opts: DecideOptions = {}): Promise<DecisionResult> {
  const started = Date.now();
  const local = spec.local(input);
  const finish = (backend: BackendId, answers: DecisionAnswers, fellBack: boolean): DecisionResult => {
    // 远端只答了部分问题 → 其余用本地答案补位
    const merged: DecisionAnswers = { ...local, ...answers };
    const res: DecisionResult = {
      specId: spec.id,
      specVersion: spec.version,
      backend,
      answers: merged,
      action: actionOf(spec, merged),
      fellBack,
      ms: Date.now() - started
    };
    try {
      sink.append({
        at: Date.now(),
        specId: spec.id,
        specVersion: spec.version,
        backend,
        fellBack,
        ms: res.ms,
        inputLen: input.text.length,
        inputHash: fingerprint(input.text),
        answers: Object.fromEntries(Object.entries(merged).map(([k, a]) => [k, { value: a.value, confidence: a.confidence, calibrated: a.calibrated }])),
        action: res.action
      });
    } catch {
      /* 日志失败不影响功能 */
    }
    return res;
  };

  if (opts.localOnly) return finish("local", local, false);
  if (spec.shouldEscalate && !spec.shouldEscalate(local, input)) return finish("local", local, false);

  const order = (globalOrder ?? spec.backends ?? ["llm", "local"]).filter((id) => !spec.backends || spec.backends.includes(id));
  const wantsRemote = order.some((id) => id !== "local");
  for (const id of order) {
    if (id === "local") break;
    const b = backends.get(id);
    if (!b || !b.supports(spec)) continue;
    let ok = false;
    try {
      ok = await b.available();
    } catch {
      ok = false;
    }
    if (!ok) continue;
    let cancel: (() => void) | null = null;
    try {
      const answers = await withTimeout(
        b.decide(spec, input, {
          onCancelRegister: (c) => {
            cancel = c;
            opts.onCancelRegister?.(c);
          }
        }),
        opts.timeoutMs ?? spec.llm?.timeoutMs ?? 8000,
        () => cancel?.()
      );
      return finish(id, answers, false);
    } catch {
      /* 试下一个后端 */
    }
  }
  // fellBack＝想走远端但没有任何远端给出答案（未配置 / 不可用 / 失败 / 超时）
  return finish("local", local, wantsRemote);
}
