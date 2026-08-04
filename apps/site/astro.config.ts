import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

import { docsSidebar } from "./src/lib/docs-manifest";
import { CREWHELM_SITE, absoluteSiteUrl } from "./src/lib/seo";

export default defineConfig({
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [
    starlight({
      components: {
        Head: "./src/components/docs/Head.astro",
        ThemeProvider: "./src/components/docs/ThemeProvider.astro",
        ThemeSelect: "./src/components/docs/ThemeSelect.astro",
      },
      customCss: ["./src/styles/docs.css"],
      description:
        "Install, operate, and understand Crewhelm's owner-controlled AI Agent control plane.",
      disable404Route: true,
      editLink: {
        baseUrl: "https://github.com/fkrein1/crewhelm/edit/main/apps/site/",
      },
      favicon: "/favicon.svg",
      head: [
        {
          tag: "meta",
          attrs: {
            content: "#f2f0e9",
            media: "(prefers-color-scheme: light)",
            name: "theme-color",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: "#11151e",
            media: "(prefers-color-scheme: dark)",
            name: "theme-color",
          },
        },
        {
          tag: "meta",
          attrs: { content: "light dark", name: "color-scheme" },
        },
        {
          tag: "meta",
          attrs: { content: "index, follow", name: "robots" },
        },
        {
          tag: "meta",
          attrs: {
            content: absoluteSiteUrl(CREWHELM_SITE.socialImage.url),
            property: "og:image",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: CREWHELM_SITE.socialImage.alt,
            property: "og:image:alt",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: CREWHELM_SITE.socialImage.mimeType,
            property: "og:image:type",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: CREWHELM_SITE.socialImage.width.toString(),
            property: "og:image:width",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: CREWHELM_SITE.socialImage.height.toString(),
            property: "og:image:height",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: absoluteSiteUrl(CREWHELM_SITE.socialImage.url),
            name: "twitter:image",
          },
        },
        {
          tag: "meta",
          attrs: {
            content: CREWHELM_SITE.socialImage.alt,
            name: "twitter:image:alt",
          },
        },
      ],
      logo: {
        alt: "Crewhelm",
        dark: "../../packages/design/assets/crewhelm-mark-dark.svg",
        light: "../../packages/design/assets/crewhelm-mark-light.svg",
      },
      pagefind: true,
      prerender: true,
      sidebar: docsSidebar(),
      social: [
        {
          href: CREWHELM_SITE.githubUrl,
          icon: "github",
          label: "Crewhelm on GitHub",
        },
      ],
      title: "Crewhelm Docs",
      titleDelimiter: "—",
    }),
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
