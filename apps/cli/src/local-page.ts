import {
  CREWHELM_COMPACT_BRAND_HTML,
  CREWHELM_WEB_STYLES,
  type CrewhelmPageTone,
} from "@crewhelm/design/web";

export const LOCAL_PAGE_STYLES_PATH = "/assets/crewhelm.css";

export const LOCAL_PAGE_STYLES = CREWHELM_WEB_STYLES;

interface LocalPageForm {
  action: string;
  fields: Readonly<Record<string, string>>;
  label: string;
}

interface LocalPage {
  form?: LocalPageForm;
  heading: string;
  paragraphs: readonly string[];
  title: string;
  tone?: CrewhelmPageTone;
}

export function localPageHeaders(formAction = "'none'"): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; base-uri 'none'; form-action ${formAction}; frame-ancestors 'none'; style-src 'self'`,
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderLocalPage(page: LocalPage): string {
  const paragraphs = page.paragraphs
    .map((paragraph) => `      <p class="ch-copy">${escapeHtml(paragraph)}</p>`)
    .join("\n");
  const form =
    page.form === undefined
      ? ""
      : `
      <form class="ch-actions" method="post" action="${escapeHtml(page.form.action)}">
${Object.entries(page.form.fields)
  .map(
    ([name, value]) =>
      `        <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  )
  .join("\n")}
        <button class="ch-button ch-button--primary" type="submit">${escapeHtml(page.form.label)}</button>
      </form>`;
  const tone = page.tone ?? "accent";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>${escapeHtml(page.title)}</title>
    <link rel="stylesheet" href="${LOCAL_PAGE_STYLES_PATH}">
  </head>
  <body class="ch-page">
    <main class="ch-panel" data-tone="${tone}">
      <div class="ch-panel__bar">
        <span class="ch-panel__context">local setup handoff</span>
        ${CREWHELM_COMPACT_BRAND_HTML}
      </div>
      <h1>${escapeHtml(page.heading)}</h1>
${paragraphs}${form}
    </main>
  </body>
</html>
`;
}
