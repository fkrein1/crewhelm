export const WORKER_PAGE_STYLES = `
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

[hidden] {
  display: none !important;
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

p,
li {
  color: #526071;
  line-height: 1.6;
}

ul {
  margin: 20px 0;
  padding: 18px 18px 18px 38px;
  border-radius: 10px;
  background: #f7f8fa;
}

li + li {
  margin-top: 8px;
}

.meta {
  padding-top: 16px;
  border-top: 1px solid #e6e9ee;
  font-size: 14px;
}

code {
  overflow-wrap: anywhere;
  color: #263244;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 26px;
}

.actions form {
  margin: 0;
}

button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  text-decoration: none;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

button:hover,
.button:hover {
  transform: translateY(-1px);
}

button:focus-visible,
.button:focus-visible {
  outline: 3px solid rgb(37 99 235 / 28%);
  outline-offset: 2px;
}

button:disabled,
.button[aria-disabled="true"] {
  cursor: wait;
  opacity: 0.62;
  transform: none;
  box-shadow: none;
}

.primary {
  color: #ffffff;
  background: #18212f;
  box-shadow: 0 6px 16px rgb(24 33 47 / 18%);
}

.secondary {
  color: #344054;
  border-color: #d0d5dd;
  background: #ffffff;
}

@media (max-width: 520px) {
  body {
    padding: 14px;
  }

  main {
    padding: 26px 22px;
    border-radius: 13px;
  }

  .actions button,
  .actions .button,
  .actions form {
    width: 100%;
  }
}
`.trim();

interface WorkerPage {
  body: string;
  heading: string;
  scriptPath?: string;
  title: string;
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapePageHtml(page.title)}</title>
    <link rel="stylesheet" href="/oauth/styles.css">${script}
  </head>
  <body>
    <main>
      <p class="eyebrow">Crewhelm</p>
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
