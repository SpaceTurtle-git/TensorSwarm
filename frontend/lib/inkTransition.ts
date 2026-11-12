/**
 * Ink-bleed theme transition (TensorSwarm's own implementation).
 *
 * Technique: the View Transitions API takes native snapshots of the page before and after the
 * theme flips (no html2canvas, no DOM capture of our own). We then clip one snapshot with an
 * organic, noise-warped polygon that grows from the theme toggle until it covers every corner.
 * The polygon keyframes are precomputed once per transition and played with the Web
 * Animations API on the ::view-transition pseudo-element, so no per-frame JS runs.
 *
 *   forward (dark -> light): the NEW theme bleeds outwards from the toggle.
 *   reverse (light -> dark): the OLD theme's ink retracts back into the toggle.
 *
 * Browsers without View Transitions get an overlay of the target canvas colour that bleeds in,
 * then fades away over the re-themed page. Reduced motion gets a 160 ms cross-fade.
 */

export interface InkOptions {
  /** Viewport point the ink starts from (centre of the toggle). */
  origin: { x: number; y: number };
  /** Flip the theme in the DOM. Must apply synchronously (it runs inside the snapshot). */
  apply: () => void;
  /** true = retract the old theme into the origin instead of spreading the new one. */
  reverse: boolean;
  /** Canvas colour of the target theme, for the no-View-Transitions fallback. */
  targetCanvas: string;
  durationMs?: number;
}

const POINTS = 168;      // polygon vertices: enough for a fluid edge at 4K
const FRAMES = 56;       // keyframes; WAAPI interpolates linearly between them

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

/**
 * Builds the clip-path keyframes. The edge radius at angle θ and progress t is
 *   r = R(t) · (1 + A(t)·fbm(θ, t)) + tendrils(θ, t)
 * R grows with an ease-out (ink spreads fast, then slows), A fades towards the end so the
 * shape is guaranteed to cover the farthest corner at t = 1.
 */
function buildFrames(origin: { x: number; y: number }, w: number, h: number): string[] {
  const rand = rng((Math.random() * 2 ** 32) | 0);
  const far = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(w - origin.x, origin.y),
    Math.hypot(origin.x, h - origin.y),
    Math.hypot(w - origin.x, h - origin.y),
  );

  // Periodic 1-D fbm on the angle: integer frequencies keep the outline closed.
  const octaves = [2, 3, 5, 7, 11, 17, 26, 39].map((k) => ({
    k,
    amp: 1 / Math.pow(k, 0.85),
    phase: rand() * Math.PI * 2,
    drift: (rand() - 0.5) * 2.2,
  }));
  const ampSum = octaves.reduce((s, o) => s + o.amp, 0);
  // A few narrow tendrils that reach ahead of the front, then get absorbed.
  const tendrils = Array.from({ length: 7 }, () => ({
    angle: rand() * Math.PI * 2,
    width: 18 + rand() * 30,          // higher = narrower
    reach: 0.05 + rand() * 0.09,      // fraction of `far`
    peak: 0.25 + rand() * 0.35,       // progress at which it is longest
  }));

  const frames: string[] = [];
  for (let f = 0; f <= FRAMES; f++) {
    const t = f / FRAMES;
    // Gentle ease-out: the drop lands quickly, then spreads at a readable pace and reaches the
    // farthest corner at ~90% of the duration (not halfway, which would waste the tail).
    const eased = 1 - Math.pow(1 - t, 1.8);
    const A = 0.22 * Math.pow(1 - t, 1.3) + 0.02;
    // Final radius: the most inward point of the edge (R·(1-A)) still clears the farthest corner.
    const R = 4 + eased * far * 1.07;
    const pts: string[] = [];
    for (let i = 0; i < POINTS; i++) {
      const th = (i / POINTS) * Math.PI * 2;
      let n = 0;
      for (const o of octaves) n += o.amp * Math.sin(o.k * th + o.phase + o.drift * t * 2.4);
      n /= ampSum;                                              // ~[-1, 1]
      let tendril = 0;
      for (const td of tendrils) {
        const c = Math.cos(th - td.angle);
        if (c <= 0) continue;
        const life = Math.max(0, 1 - Math.abs(t - td.peak) / 0.5);
        tendril += Math.pow(c, td.width) * td.reach * far * life;
      }
      const r = Math.max(0, R * (1 + A * n) + tendril);
      pts.push(`${(origin.x + r * Math.cos(th)).toFixed(1)}px ${(origin.y + r * Math.sin(th)).toFixed(1)}px`);
    }
    frames.push(`polygon(${pts.join(",")})`);
  }
  return frames;
}

/** Runs one theme transition. Resolves when it has finished (or fallen back). */
export async function runInkTransition(opts: InkOptions): Promise<void> {
  const { origin, apply, reverse, targetCanvas, durationMs = 950 } = opts;
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
    const frames = buildFrames(origin, w, h);

    if (!doc.startViewTransition) {
      await overlayFallback(frames, targetCanvas, durationMs, applyOnce);
      return;
    }

    root.style.setProperty("--ink-x", `${origin.x}px`);
    root.style.setProperty("--ink-y", `${origin.y}px`);
    root.dataset.ink = reverse ? "reverse" : "forward";
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
