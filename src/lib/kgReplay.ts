// 回放时间轴：事件拍 → 播放日程（纯函数，无 DOM）。
// 轴按真实日历时间摆放（刻度位置不失真）；播放时画面有变化的拍按正常节奏，
// 拍与拍之间的空白（画面不变）用一小段固定时长「快速扫过」——圆点飞快越过这段距离，画面保持。
// 第一拍之前的空白不属于轴：轴从第一次变化开始。

export interface BeatLike {
  start: number;
  end: number;
  dur: number;
}

export interface ReplaySeg {
  /** hold＝本拍动画；gap＝空白快速扫过（画面保持在 beat 这一拍） */
  kind: "hold" | "gap";
  beat: number;
  /** 圆点位置 0..1（真实日历时间） */
  from: number;
  to: number;
  ms: number;
  startMs: number;
}

export interface ReplaySchedule {
  t0: number;
  t1: number;
  segs: ReplaySeg[];
  total: number;
  /** 每拍 hold 段开始的播放时钟（毫秒） */
  holdStart: number[];
}

export const GAP_MIN_MS = 120;
export const GAP_MAX_MS = 400;
const DAY = 86400000;

/** 空白快速扫过的时长：随跨度略增，封顶 GAP_MAX_MS */
export function gapDuration(realGapMs: number): number {
  if (realGapMs <= 0) return 0;
  return Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, GAP_MIN_MS + (realGapMs / DAY) * 20));
}

export function posOf(sch: Pick<ReplaySchedule, "t0" | "t1">, t: number): number {
  const span = sch.t1 - sch.t0;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (t - sch.t0) / span));
}

export function buildSchedule(beats: BeatLike[], nowT: number): ReplaySchedule {
  const t0 = beats.length ? beats[0].start : nowT;
  const t1 = Math.max(nowT, beats.length ? beats[beats.length - 1].end : nowT);
  const sch: ReplaySchedule = { t0, t1, segs: [], total: 0, holdStart: [] };
  let clock = 0;
  const push = (kind: "hold" | "gap", beat: number, from: number, to: number, ms: number) => {
    if (ms <= 0) return;
    sch.segs.push({ kind, beat, from, to, ms, startMs: clock });
    clock += ms;
  };
  beats.forEach((b, i) => {
    sch.holdStart.push(clock);
    push("hold", i, posOf(sch, b.start), posOf(sch, b.end), b.dur);
    const nextT = i + 1 < beats.length ? beats[i + 1].start : t1;
    const nextPos = i + 1 < beats.length ? posOf(sch, nextT) : 1;
    push("gap", i, posOf(sch, b.end), nextPos, gapDuration(nextT - b.end));
  });
  sch.total = clock;
  return sch;
}

/** 播放时钟 clock 处：当前画面拍、圆点位置、是否已播完 */
export function stateAt(sch: ReplaySchedule, clock: number): { beat: number; pos: number; done: boolean } {
  const segs = sch.segs;
  if (!segs.length) return { beat: 0, pos: 1, done: true };
  if (clock >= sch.total) return { beat: segs[segs.length - 1].beat, pos: 1, done: true };
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startMs <= clock) lo = mid;
    else hi = mid - 1;
  }
  const s = segs[lo];
  const f = Math.min(1, Math.max(0, (clock - s.startMs) / s.ms));
  return { beat: s.beat, pos: s.from + (s.to - s.from) * f, done: false };
}

/** 轴上位置 f（0..1）→ 拍序号；落在最后一拍之后（≈现在）返回 null */
export function beatAtFrac(sch: ReplaySchedule, beats: BeatLike[], f: number): number | null {
  if (!beats.length) return null;
  if (f >= 0.999) return null;
  const t = sch.t0 + f * (sch.t1 - sch.t0);
  let idx = 0;
  for (let i = 0; i < beats.length; i++) if (beats[i].start <= t) idx = i;
  return idx;
}
