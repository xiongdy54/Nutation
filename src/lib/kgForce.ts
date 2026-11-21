// v49.143 / D310 关系图物理（设计 docs/design/KG-FORCE-GRAPH.md §3）。
// 速度 Verlet；Barnes–Hut 斥力 + 弹簧（d3 同口径的度数归一）+ 弱向心 + 碰撞。纯模块，无 DOM，可单测。
// 位置不持久化（推翻 §8.6）；初始位置由 id 固定种子生成，同一输入同一结果。

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  r: number;
}
export interface SimLink {
  s: string;
  t: string;
  /** 弹簧强度倍数：骨架边 1、建议边 0.5、情境边 0.15 */
  w: number;
}

/** 32 位 FNV-1a */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export function seeded(id: string, salt: string): number {
  return (hash(id + ":" + salt) % 100000) / 100000;
}

/** 初始位置：按分组（主题）取扇区 + 种子半径 */
export function seedPosition(id: string, group: number, groups: number, radius: number): [number, number] {
  const base = groups > 0 ? (group / groups) * Math.PI * 2 : seeded(id, "g") * Math.PI * 2;
  const a = base + (seeded(id, "a") - 0.5) * 1.1;
  const r = radius * (0.35 + seeded(id, "r") * 0.8);
  return [Math.cos(a) * r, Math.sin(a) * r];
}

interface Cell {
  x: number;
  y: number;
  s: number;
  kids: (Cell | null)[] | null;
  body: SimNode | null;
  extra: SimNode[] | null;
  m: number;
  cx: number;
  cy: number;
}

function newCell(x: number, y: number, s: number): Cell {
  return { x, y, s, kids: null, body: null, extra: null, m: 0, cx: 0, cy: 0 };
}

function buildTree(list: SimNode[]): Cell {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of list) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }
  const root = newCell(x0, y0, Math.max(x1 - x0, y1 - y0, 1) + 1);
  const child = (c: Cell, n: SimNode): Cell => {
    const h = c.s / 2;
    const i = (n.x >= c.x + h ? 1 : 0) + (n.y >= c.y + h ? 2 : 0);
    const kids = c.kids!;
    if (!kids[i]) kids[i] = newCell(c.x + (i & 1 ? h : 0), c.y + (i & 2 ? h : 0), h);
    return kids[i]!;
  };
  const insert = (start: Cell, n: SimNode) => {
    let c = start;
    let depth = 0;
    for (;;) {
      if (!c.kids) {
        if (!c.body) {
          c.body = n;
          return;
        }
        if (depth > 30) {
          (c.extra ||= []).push(n);
          return;
        }
        const old = c.body;
        c.body = null;
        c.kids = [null, null, null, null];
        let oc = child(c, old);
        // 旧体落到子格（递归一层即可：子格必空）
        oc.body = old;
      }
      c = child(c, n);
      depth++;
    }
  };
  for (const n of list) insert(root, n);
  const mass = (c: Cell) => {
    if (!c.kids) {
      const bodies = c.body ? [c.body, ...(c.extra || [])] : [];
      c.m = bodies.length;
      for (const b of bodies) {
        c.cx += b.x;
        c.cy += b.y;
      }
    } else {
      for (const k of c.kids) {
        if (!k) continue;
        mass(k);
        c.m += k.m;
        c.cx += k.cx * k.m;
        c.cy += k.cy * k.m;
      }
    }
    if (c.m) {
      c.cx /= c.m;
      c.cy /= c.m;
    }
  };
  mass(root);
  return root;
}

export interface ForceParams {
  charge: number;
  linkDistance: number;
  center: number;
  theta2: number;
  velocityDecay: number;
  collidePad: number;
}
export const DEFAULT_FORCE: ForceParams = { charge: -62, linkDistance: 46, center: 0.045, theta2: 0.81, velocityDecay: 0.42, collidePad: 3 };

export class ForceSim {
  alpha = 1;
  alphaTarget = 0;
  readonly alphaMin = 0.001;
  readonly alphaDecay = 1 - Math.pow(0.001, 1 / 300);
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  private byId = new Map<string, SimNode>();
  constructor(public p: ForceParams = DEFAULT_FORCE) {}

  setGraph(nodes: SimNode[], links: SimLink[]): void {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.links = links.filter((l) => this.byId.has(l.s) && this.byId.has(l.t) && l.s !== l.t);
  }
  get(id: string): SimNode | undefined {
    return this.byId.get(id);
  }
  running(): boolean {
    return this.alpha > this.alphaMin || this.alphaTarget > 0;
  }
  reheat(a: number): void {
    this.alpha = Math.max(this.alpha, a);
  }

  tick(): void {
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay;
    const a = this.alpha;
    const { charge, linkDistance, center, theta2, velocityDecay, collidePad } = this.p;
    const ns = this.nodes;
    if (ns.length > 1) {
      const root = buildTree(ns);
      const apply = (n: SimNode, c: Cell | null) => {
        if (!c || !c.m) return;
        if (!c.kids) {
          const bodies = c.body ? [c.body, ...(c.extra || [])] : [];
          for (const b of bodies) {
            if (b === n) continue;
            let ex = b.x - n.x;
            let ey = b.y - n.y;
            let l = ex * ex + ey * ey;
            if (l < 1) {
              ex = ((hash(n.id + b.id) % 7) - 3) * 0.1 || 0.1;
              ey = 0.1;
              l = 1;
            }
            const f = (charge * a) / l;
            n.vx += ex * f;
            n.vy += ey * f;
          }
          return;
        }
        const dx = c.cx - n.x;
        const dy = c.cy - n.y;
        const d2 = Math.max(1, dx * dx + dy * dy);
        if ((c.s * c.s) / d2 < theta2) {
          const f = (charge * a * c.m) / d2;
          n.vx += dx * f;
          n.vy += dy * f;
          return;
        }
        for (const k of c.kids) apply(n, k);
      };
      for (const n of ns) apply(n, root);
    }
    const deg = new Map<string, number>();
    for (const l of this.links) {
      deg.set(l.s, (deg.get(l.s) || 0) + 1);
      deg.set(l.t, (deg.get(l.t) || 0) + 1);
    }
    for (const l of this.links) {
      const s = this.byId.get(l.s)!;
      const t = this.byId.get(l.t)!;
      let x = t.x + t.vx - s.x - s.vx;
      let y = t.y + t.vy - s.y - s.vy;
      let len = Math.sqrt(x * x + y * y) || 1e-6;
      const ds = deg.get(l.s)!;
      const dt = deg.get(l.t)!;
      const str = l.w / Math.min(ds, dt);
      const bias = ds / (ds + dt);
      len = ((len - linkDistance) / len) * a * str;
      x *= len;
      y *= len;
      t.vx -= x * bias;
      t.vy -= y * bias;
      s.vx += x * (1 - bias);
      s.vy += y * (1 - bias);
    }
    for (const n of ns) {
      n.vx -= n.x * center * a;
      n.vy -= n.y * center * a;
    }
    // 碰撞：按格子只看邻近（O(N)）
    const cell = 24;
    const grid = new Map<number, SimNode[]>();
    const key = (gx: number, gy: number) => gx * 73856093 ^ gy * 19349663;
    for (const n of ns) {
      const k = key(Math.floor(n.x / cell), Math.floor(n.y / cell));
      const arr = grid.get(k);
      if (arr) arr.push(n);
      else grid.set(k, [n]);
    }
    for (const p of ns) {
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++) {
          const arr = grid.get(key(gx + ox, gy + oy));
          if (!arr) continue;
          for (const q of arr) {
            if (q.id <= p.id) continue;
            const rr = p.r + q.r + collidePad * 2;
            let dx = q.x - p.x;
            let dy = q.y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr) continue;
            const d = Math.sqrt(d2) || 0.01;
            const k = ((rr - d) / d) * 0.35;
            dx *= k;
            dy *= k;
            q.vx += dx;
            q.vy += dy;
            p.vx -= dx;
            p.vy -= dy;
          }
        }
    }
    for (const n of ns) {
      if (n.fx != null && n.fy != null) {
        n.x = n.fx;
        n.y = n.fy;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 1 - velocityDecay;
      n.vy *= 1 - velocityDecay;
      n.x += n.vx;
      n.y += n.vy;
    }
  }

  /** 同步跑到静止（动效关闭时、或首帧预演） */
  settle(maxTicks = 320): void {
    for (let i = 0; i < maxTicks && this.alpha > this.alphaMin; i++) this.tick();
  }
}
