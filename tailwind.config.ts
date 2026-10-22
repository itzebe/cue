import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#07070b",
          900: "#0b0b12",
          850: "#101018",
          800: "#15151f",
          700: "#1e1e2b",
          600: "#2a2a3a",
        },
        ember: {
          400: "#ff9f5a",
          500: "#ff7a1a",
          600: "#e85d04",
        },
        signal: {
          300: "#7ce8c0",
          400: "#3ddc97",
          500: "#12b76a",
        },
        haze: {
          100: "#f5f4f8",
          300: "#b9b7c9",
          500: "#7c7a92",
          700: "#4a4859",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(255,122,26,0.25), 0 18px 60px -18px rgba(255,122,26,0.45)",
        card: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 24px 60px -32px rgba(0,0,0,0.9)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        "bar-grow": {
          "0%": { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both",
        "pulse-soft": "pulse-soft 1.8s ease-in-out infinite",
        "bar-grow": "bar-grow 0.9s cubic-bezier(0.22,1,0.36,1) both",
      },
    },
  },
  plugins: [],
};

export default config;
