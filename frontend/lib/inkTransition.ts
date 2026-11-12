/**
 * Ink-bleed theme transition.
 *
 * Renderer: the View Transitions API takes native snapshots of the page before and after the
 * theme flips (no html2canvas, no DOM capture of our own, nothing to keep in sync with the live
 * dashboard). One snapshot is clipped by an organic polygon that grows from the theme dial
 * until it covers every corner. All keyframes are computed once per transition and played with
 * the Web Animations API on the ::view-transition pseudo-element, so no per-frame JS runs.
 *
 *   forward (light -> dark): the NEW theme's ink spreads outwards from the dial.
 *   reverse (dark -> light): the OLD theme's ink retracts back into the dial.
 *
 * The clicked dial gets its own view-transition-name, so it is drawn live above the ink and its
 * knob/icon animation plays as part of the same interaction.
 *
 * Fallbacks: without View Transitions, a sheet of the target canvas colour bleeds in with the
 * same shape and then fades over the re-themed page. Reduced motion: a 160 ms cross-fade.
 *
 * Shape model adapted from the WebGL2 ink shader of "ink-bleed-theme-changer" by Codemure
 * (https://github.com/codemure-official/ink-bleed-theme-changer, src/gl/shaders.ts and
 * src/ui/inkTransition.ts): domain-warped fbm "blob" in page space + direction-only "lobes",
 * noise-gated tendrils whose length follows the radius, and a late uniform "cleanup" reach that
 * guarantees full coverage. Here it is evaluated on the CPU along the outline instead of per
 * pixel, because the reveal is a clip-path rather than a shader over page screenshots.
 *
 *   MIT License. Copyright (c) 2026 Codemure.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge,
 *   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 *   to whom the Software is furnished to do so, subject to the following conditions: The above
 *   copyright notice and this permission notice shall be included in all copies or substantial
 *   portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 *   EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 *   FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 *   HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 *   USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

export interface InkOptions {
  /** Viewport point the ink starts from (centre of the dial). */
  origin: { x: number; y: number };
  /** Flip the theme in the DOM. Must apply synchronously (it runs inside the snapshot). */
  apply: () => void;
  /** true = retract the old theme into the origin instead of spreading the new one. */
  reverse: boolean;
  /** Canvas colour of the target theme, for the no-View-Transitions fallback. */
  targetCanvas: string;
  /** The control that started it: drawn live above the ink while it runs. */
  live?: HTMLElement;
  durationMs?: number;
}

const POINTS = 200;      // outline vertices
const FRAMES = 56;       // keyframes; WAAPI interpolates linearly between them

// Shape budget (from the reference shader): how far the edge may lead / lag the base circle.
const A_LOBE = 0.22;
const A_BLOB = 0.2;
const A_SUM = A_LOBE + A_BLOB;
const TENDRIL_REACH = 0.24;
// Spread over time: base radius at t = 1 relative to the farthest corner, and the late uniform
// reach that eats whatever the noise left behind so the page is covered exactly at the end.
const SPREAD = { growth: 0.7, cleanupFrom: 0.45, cleanupReach: 0.4, cleanupPow: 2 };

type VT = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
type DocWithVT = Document & { startViewTransition?: (cb: () => void) => VT };

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Small seeded PRNG so one transition's noise field is self-consistent. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2-D gradient noise (Perlin-style), roughly [-1, 1]. */
function gradientNoise(rand: () => number) {
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = [1, -1, 1, -1, 1.414, -1.414, 0, 0];
  const gy = [1, 1, -1, -1, 0, 0, 1.414, -1.414];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (h: number, x: number, y: number) => gx[h & 7] * x + gy[h & 7] * y;
  return (x: number, y: number) => {
    const X = Math.floor(x), Y = Math.floor(y);
    const fx = x - X, fy = y - Y;
    const xi = X & 255, yi = Y & 255;
    const a = perm[xi] + yi, b = perm[xi + 1] + yi;
    const u = fade(fx), v = fade(fy);
    const n00 = dot(perm[a], fx, fy), n10 = dot(perm[b], fx - 1, fy);
    const n01 = dot(perm[a + 1], fx, fy - 1), n11 = dot(perm[b + 1], fx - 1, fy - 1);
    return (n00 + u * (n10 - n00) + v * (n01 + u * (n11 - n01) - n00 - u * (n10 - n00))) * 1.1;
  };
}

/** Builds the clip-path keyframes for one transition. */
function buildFrames(origin: { x: number; y: number }, w: number, h: number, durationMs: number): string[] {
  const rand = rng((Math.random() * 2 ** 32) | 0);
  const noise = gradientNoise(rand);
  // Rotated, scaled octaves (same lattice walk as the reference shader).
  const fbm = (x: number, y: number, octaves: number) => {
    let s = 0, a = 0.5, norm = 0;
    for (let i = 0; i < octaves; i++) {
      s += a * noise(x, y);
      norm += a;
      const nx = (0.8 * x + 0.6 * y) * 2.03 + 17.13;
      y = (-0.6 * x + 0.8 * y) * 2.03 + 17.13;
      x = nx;
      a *= 0.5;
    }
    return s / norm;
  };

  const far = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(w - origin.x, origin.y),
    Math.hypot(origin.x, h - origin.y),
    Math.hypot(w - origin.x, h - origin.y),
  ) + 4;
  const ref = Math.max(w, h);                     // noise space scales with the viewport
  const seed = { x: rand() * 64 - 32, y: rand() * 64 - 32 };
  const rot = rand() * Math.PI * 2;
  const seconds = durationMs / 1000;

  // Direction-dependent terms do not change with the radius: precompute per vertex.
  const dirs = Array.from({ length: POINTS }, (_, i) => {
    const th = (i / POINTS) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    const rx = Math.cos(rot) * dx - Math.sin(rot) * dy, ry = Math.sin(rot) * dx + Math.cos(rot) * dy;
    const gate = Math.min(1, Math.max(0, (fbm(rx * 1.6 + seed.x * 0.61 + 3.7, ry * 1.6 + seed.y * 0.61 + 3.7, 3) + 0.35) / 0.75));
    const lenN = noise(rx * 3.1 + seed.x * 0.43, ry * 3.1 + seed.y * 0.43) * 0.5 + 0.5;
    return { dx, dy, rx, ry, gate, lenN };
  });
  // Sharpen the gate into a few distinct filaments rather than a uniform fringe.
  const tendrilAt = (i: number, R: number, tau: number) => {
    const d = dirs[i];
    const ridge = Math.abs(fbm(d.rx * 2.2 + seed.x * 1.7, d.ry * 2.2 + seed.y * 1.7 + 0.18 * tau, 4));
    const thin = Math.max(0, 1 - ridge / 0.12);   // 1 on the noise's zero-lines
    return TENDRIL_REACH * R * d.gate * (0.35 + 0.65 * d.lenN) * thin * thin;
  };
  const reachAt = (i: number, r: number, tau: number) => {
    const d = dirs[i];
    const qx = (d.dx * r) / ref * 2.4 + seed.x, qy = (d.dy * r) / ref * 2.4 + seed.y;
    const wx = fbm(qx, qy + 0.31 * tau, 3);
    const wy = fbm(qx + 5.2 - 0.27 * tau, qy + 1.3, 3);
    const blob = fbm(qx + 2.3 * wx + 0.12 * tau, qy + 2.3 * wy - 0.08 * tau, 5);
    const lx = d.rx * 0.9 + seed.y * 0.37 + 0.06 * tau, ly = d.ry * 0.9 + seed.x * 0.37 + 0.06 * tau;
    const lobes = noise(lx, ly) * 0.75 + noise(lx * 2.1 + 9.1, ly * 2.1 + 9.1) * 0.25;
    return Math.min(1 + A_SUM, Math.max(1 - A_SUM, 1 + A_LOBE * 1.6 * lobes + A_BLOB * 1.5 * blob));
  };

  const frames: string[] = [];
  for (let f = 0; f <= FRAMES; f++) {
    const t = f / FRAMES;
    const tau = t * seconds;                     // the edge "boils" over time, not just scales
    const eased = 1 - Math.pow(1 - t, 2.4);      // the drop lands fast, then spreads readably
    const R = 2 + eased * far * SPREAD.growth;
    const ramp = Math.max(0, (t - SPREAD.cleanupFrom) / (1 - SPREAD.cleanupFrom));
    const cleanup = Math.pow(ramp, SPREAD.cleanupPow) * far * SPREAD.cleanupReach + Math.max(0, (t - 0.97) / 0.03) * far;
    const raw = new Float64Array(POINTS);
    for (let i = 0; i < POINTS; i++) {
      // The blob is sampled where the edge is (page space): two fixed-point steps find it.
      let r = R;
      r = R * reachAt(i, r, tau);
      r = R * reachAt(i, r, tau);
      raw[i] = r + tendrilAt(i, R, tau);
    }
    // A shader would feather the frontier; a clip-path cannot, so smooth along the outline
    // instead (circular [1 2 3 2 1] kernel): fluid curves and tapered tendrils, not shards.
    const pts: string[] = [];
    for (let i = 0; i < POINTS; i++) {
      const at = (k: number) => raw[(i + k + POINTS) % POINTS];
      const r = Math.max(0, (at(-2) + 2 * at(-1) + 3 * at(0) + 2 * at(1) + at(2)) / 9 + cleanup);
      const d = dirs[i];
      pts.push(`${(origin.x + r * d.dx).toFixed(1)}px ${(origin.y + r * d.dy).toFixed(1)}px`);
    }
    frames.push(`polygon(${pts.join(",")})`);
  }
  return frames;
}

/** Runs one theme transition. Resolves when it has finished (or fallen back). */
export async function runInkTransition(opts: InkOptions): Promise<void> {
  const { origin, apply, reverse, targetCanvas, live, durationMs = 1000 } = opts;
  const root = document.documentElement;
  const doc = document as DocWithVT;
  let applied = false;
  const applyOnce = () => {
    if (!applied) {
      applied = true;
      apply();
    }
  };

  try {
    if (prefersReducedMotion()) {
      if (doc.startViewTransition) {
        root.dataset.ink = "fade";
        await doc.startViewTransition(applyOnce).finished;
      } else {
        applyOnce();
      }
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const frames = buildFrames(origin, w, h, durationMs);

    if (!doc.startViewTransition) {
      await overlayFallback(frames, targetCanvas, durationMs, applyOnce);
      return;
    }

    root.style.setProperty("--ink-x", `${origin.x}px`);
    root.style.setProperty("--ink-y", `${origin.y}px`);
    root.dataset.ink = reverse ? "reverse" : "forward";
    if (live) live.style.setProperty("view-transition-name", "theme-dial");
    const vt = doc.startViewTransition(applyOnce);
    // A resize mid-transition would leave the precomputed shape short of the new corners.
    const onResize = () => vt.skipTransition();
    window.addEventListener("resize", onResize, { once: true });
    let anim: Animation | null = null;
    try {
      await vt.ready;
      anim = root.animate(
        { clipPath: reverse ? [...frames].reverse() : frames },
        {
          duration: durationMs,
          easing: "linear",
          fill: "both",
          pseudoElement: reverse ? "::view-transition-old(root)" : "::view-transition-new(root)",
        },
      );
      await anim.finished.catch(() => undefined);
      await vt.finished.catch(() => undefined);
    } finally {
      window.removeEventListener("resize", onResize);
      // fill:"both" keeps a finished animation attached to <html>; drop it so toggles never pile up.
      anim?.cancel();
    }
  } catch {
    // Any failure: make sure the theme still changes (conventional switch).
    applyOnce();
  } finally {
    delete root.dataset.ink;
    root.style.removeProperty("--ink-x");
    root.style.removeProperty("--ink-y");
    live?.style.removeProperty("view-transition-name");
  }
}

/** No View Transitions: bleed a flat sheet of the target canvas colour, then reveal the page. */
async function overlayFallback(frames: string[], color: string, durationMs: number, apply: () => void) {
  const sheet = document.createElement("div");
  sheet.setAttribute("aria-hidden", "true");
  Object.assign(sheet.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    background: color,
    clipPath: frames[0],
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(sheet);
  try {
    await sheet.animate({ clipPath: frames }, { duration: durationMs, easing: "linear", fill: "forwards" }).finished;
    apply();
    await sheet.animate({ opacity: [1, 0] }, { duration: 220, easing: "ease-out", fill: "forwards" }).finished;
  } finally {
    sheet.remove();
    apply();
  }
}
