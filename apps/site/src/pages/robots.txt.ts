import type { APIRoute } from "astro";

import { robotsText } from "../lib/seo";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(robotsText(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
