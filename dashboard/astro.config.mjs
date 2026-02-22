import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  outDir: "build",
  base: "/dashboard",
  vite: {
    plugins: [tailwindcss()],
  },
});
