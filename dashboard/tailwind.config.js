/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      colors: {
        nerv: {
          bg: "#0a0a0f",
          surface: "#12121a",
          border: "#2a2a3a",
          "border-glow": "#3a3a4a",
        },
        amber: {
          nerv: "#ffbf00",
        },
        orange: {
          nerv: "#ff6b00",
        },
        red: {
          nerv: "#ff2d2d",
        },
        green: {
          nerv: "#00ff88",
        },
        text: {
          DEFAULT: "#e0e0e0",
          muted: "#6b6b80",
        },
      },
      fontFamily: {
        heading: ["Exo 2", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "pulse-fast": "pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
      boxShadow: {
        "glow-amber": "0 0 20px rgba(255, 191, 0, 0.3)",
        "glow-green": "0 0 15px rgba(0, 255, 136, 0.3)",
        "glow-red": "0 0 15px rgba(255, 45, 45, 0.3)",
      },
    },
  },
  plugins: [],
};
