import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        return pathname !== "/404/" && pathname !== "/404.html";
      },
    }),
  ],
  site: "https://crewhelm.app",
  vite: {
    plugins: [tailwindcss()],
  },
});
