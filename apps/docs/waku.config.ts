import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { defineConfig } from "waku/config";

export default defineConfig({
  vite: {
    resolve: {
      tsconfigPaths: true,
      external: ["takumi-js/response"],
    },

    plugins: [tailwindcss(), mdx()],
  },
});
