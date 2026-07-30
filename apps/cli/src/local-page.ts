export const LOCAL_PAGE_STYLES_PATH = "/assets/crewhelm.css";

export const LOCAL_PAGE_STYLES = `
:root {
  color-scheme: light;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #18212f;
  background: #f4f6f8;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top, #ffffff 0, #f4f6f8 52%),
    #f4f6f8;
}

main {
  width: min(100%, 560px);
  padding: 36px;
  border: 1px solid #dfe4ea;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 18px 50px rgb(25 35 50 / 9%);
}

.eyebrow {
  margin: 0 0 12px;
  color: #526071;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  color: #111827;
  font-size: clamp(28px, 5vw, 36px);
  line-height: 1.12;
  letter-spacing: -0.025em;
}

p {
  color: #526071;
  line-height: 1.6;
}

.actions {
  margin-top: 26px;
}

button {
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: #ffffff;
  background: #18212f;
  box-shadow: 0 6px 16px rgb(24 33 47 / 18%);
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

button:hover {
  transform: translateY(-1px);
}

button:focus-visible {
  outline: 3px solid rgb(37 99 235 / 28%);
  outline-offset: 2px;
}

@media (max-width: 520px) {
  body {
    padding: 14px;
  }

  main {
    padding: 26px 22px;
    border-radius: 13px;
  }

  button {
    width: 100%;
  }
}
`.trim();

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
    .map((paragraph) => `      <p>${escapeHtml(paragraph)}</p>`)
    .join("\n");
  const form =
    page.form === undefined
      ? ""
      : `
      <form class="actions" method="post" action="${escapeHtml(page.form.action)}">
${Object.entries(page.form.fields)
  .map(
    ([name, value]) =>
      `        <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  )
  .join("\n")}
        <button type="submit">${escapeHtml(page.form.label)}</button>
      </form>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(page.title)}</title>
    <link rel="stylesheet" href="${LOCAL_PAGE_STYLES_PATH}">
  </head>
  <body>
    <main>
      <p class="eyebrow">Crewhelm</p>
      <h1>${escapeHtml(page.heading)}</h1>
${paragraphs}${form}
    </main>
  </body>
</html>
`;
}
