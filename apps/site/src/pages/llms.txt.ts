import type { APIRoute } from "astro";

import { llmsText } from "../lib/seo";

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(llmsText(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
