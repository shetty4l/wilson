import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  outDir: "dist",
  base: "/dashboard",
  vite: {
    plugins: [tailwindcss()],
  },
});
