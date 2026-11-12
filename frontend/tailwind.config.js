/** @type {import('tailwindcss').Config} */

// Every colour is a semantic token defined once, per theme, in app/globals.css as an
// "R G B" triplet, so Tailwind's opacity modifiers keep working (bg-accent/15, border-line/60).
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: token("canvas"),
        surface: token("surface"),
        elevated: token("elevated"),
        line: { DEFAULT: token("line"), strong: token("line-strong") },
        fg: token("fg"),
        muted: token("muted"),
        accent: {
          DEFAULT: token("accent"),
          hover: token("accent-hover"),
          fg: token("accent-fg"),
          edge: token("accent-edge"),
          soft: token("accent-soft"),
        },
        sidebar: token("sidebar"),
        seat: { free: token("seat-free"), taken: token("seat-taken"), offline: token("seat-offline") },
        ok: { DEFAULT: token("ok"), fg: token("ok-fg") },
        warn: { DEFAULT: token("warn"), fg: token("warn-fg") },
        danger: { DEFAULT: token("danger"), fg: token("danger-fg") },
        viz: token("viz"),
        icon: token("icon"),
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      keyframes: {
        "slide-in": { from: { opacity: "0", transform: "translateY(-6px)" }, to: { opacity: "1", transform: "none" } },
        "drawer-in": { from: { transform: "translateX(100%)" }, to: { transform: "none" } },
        "drawer-in-left": { from: { transform: "translateX(-100%)" }, to: { transform: "none" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "seat-pop": { "0%": { transform: "scale(1)" }, "45%": { transform: "scale(1.12)" }, "100%": { transform: "scale(1.04)" } },
        "status-ping": { "0%": { transform: "scale(1)", opacity: "0.55" }, "80%, 100%": { transform: "scale(2.4)", opacity: "0" } },
      },
      animation: {
        "slide-in": "slide-in 250ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "drawer-in": "drawer-in 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "drawer-in-left": "drawer-in-left 260ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 200ms ease-out both",
        "seat-pop": "seat-pop 180ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "status-ping": "status-ping 2.4s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
    },
  },
  plugins: [],
};
