import {
  CREWHELM_COMPACT_BRAND_HTML,
  CREWHELM_WEB_STYLES,
  type CrewhelmPageTone,
} from "@crewhelm/design/web";

export const WORKER_PAGE_STYLES = CREWHELM_WEB_STYLES;

interface WorkerPage {
  body: string;
  context?: string;
  heading: string;
  layout?: "form";
  scriptPath?: string;
  title: string;
  tone?: CrewhelmPageTone;
}

interface WorkerPageResponseOptions {
  connections?: boolean;
  formActionOrigin?: string;
  forms?: boolean;
  scripts?: boolean;
  status?: number;
}

export function escapePageHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderWorkerPage(page: WorkerPage): string {
  const script =
    page.scriptPath === undefined
      ? ""
      : `\n    <script src="${escapePageHtml(page.scriptPath)}" defer></script>`;
  const context = escapePageHtml(page.context ?? "secure browser handoff");
  const tone = page.tone ?? "accent";
  const panelClass = page.layout === "form" ? "ch-panel ch-panel--form" : "ch-panel";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>${escapePageHtml(page.title)}</title>
    <link rel="stylesheet" href="/oauth/styles.css">${script}
  </head>
  <body class="ch-page">
    <main class="${panelClass}" data-tone="${tone}">
      <div class="ch-panel__bar">
        <span class="ch-panel__context">${context}</span>
        ${CREWHELM_COMPACT_BRAND_HTML}
      </div>
      <h1>${escapePageHtml(page.heading)}</h1>
${page.body}
    </main>
  </body>
</html>
`;
}

export function workerPageResponse(
  body: string | null,
  options: WorkerPageResponseOptions = {},
): Response {
  const formAction =
    options.forms !== true
      ? "'none'"
      : options.formActionOrigin === undefined
        ? "'self'"
        : `'self' ${options.formActionOrigin}`;
  const scriptSource = options.scripts === true ? "'self'" : "'none'";
  const connectSource = options.connections === true ? "'self'" : "'none'";

  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; base-uri 'none'; connect-src ${connectSource}; form-action ${formAction}; frame-ancestors 'none'; script-src ${scriptSource}; style-src 'self'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
    ...(options.status === undefined ? {} : { status: options.status }),
  });
}

export function workerStylesheetResponse(): Response {
  return new Response(`${WORKER_PAGE_STYLES}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/css; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
