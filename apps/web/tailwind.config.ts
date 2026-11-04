import type { Config } from "tailwindcss";

const rgb = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    screens: {
      xs: "375px",
      sm: "430px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1440px",
    },
    extend: {
      colors: {
        background: rgb("background"),
        surface: {
          1: rgb("surface-1"),
          2: rgb("surface-2"),
          3: rgb("surface-3"),
          hover: rgb("surface-hover"),
          nav: rgb("surface-nav"),
        },
        foreground: {
          DEFAULT: rgb("foreground"),
          secondary: rgb("foreground-secondary"),
          muted: rgb("foreground-muted"),
        },
        border: {
          DEFAULT: rgb("border"),
          strong: rgb("border-strong"),
        },
        /* "gold" is the primary action token. Payment-first palette (2026-11-04 delta §9.1):
           emerald CTA with ink text (#16191C on #20A37A = 6.0:1, AA); deeper emerald for
           text/links/focus (#146D56 on #FAFAF8 = 6.3:1). */
        gold: {
          DEFAULT: "#20A37A",
          hover: "#1B9470",
          ochre: "#146D56",
        },
        /* Rare premium accent (DEMO/TEST badges only). */
        mineral: "#C4A56C",
        accent: rgb("accent"),
        ink: "#16191C",
        success: rgb("success"),
        progress: rgb("progress"),
        warning: rgb("warning"),
        danger: rgb("danger"),
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        // One legible sans across UI and headlines (no ornamental display face on payment surfaces).
        display: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      fontSize: {
        micro: ["11px", { lineHeight: "15px", letterSpacing: "0.02em" }],
        label: ["12px", { lineHeight: "16px" }],
      },
      borderRadius: {
        input: "6px",
        panel: "14px",
        overlay: "16px",
      },
      maxWidth: {
        marketing: "1280px",
        app: "1440px",
      },
      boxShadow: {
        panel: "0 1px 2px 0 rgb(22 25 28 / 0.04)",
        overlay: "0 24px 48px -20px rgb(22 25 28 / 0.18)",
      },
      transitionDuration: { DEFAULT: "180ms" },
      keyframes: {
        fadeIn: { "0%": { opacity: "0", transform: "translateY(3px)" }, "100%": { opacity: "1", transform: "none" } },
        scaleIn: { "0%": { opacity: "0", transform: "scale(0.98)" }, "100%": { opacity: "1", transform: "none" } },
        slideIn: { "0%": { opacity: "0", transform: "translateX(16px)" }, "100%": { opacity: "1", transform: "none" } },
      },
      animation: {
        "fade-in": "fadeIn 180ms cubic-bezier(0.16,1,0.3,1) both",
        "scale-in": "scaleIn 160ms cubic-bezier(0.16,1,0.3,1) both",
        "slide-in": "slideIn 220ms cubic-bezier(0.16,1,0.3,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
