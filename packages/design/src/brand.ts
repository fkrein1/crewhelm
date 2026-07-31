export const CREWHELM_BRAND_NAME = "Crewhelm";
export const CREWHELM_BRAND_PROMISE = "Give Agents a mandate. Not a master key.";
export const CREWHELM_BRAND_POSITIONING =
  "The open-source personal control plane for owner-controlled Agents on Cloudflare.";
export const CREWHELM_LOGO_PROMPT = ">_";
export const CREWHELM_LOGO_WORDMARK = "CREWHELM";
export const CREWHELM_LOGO_TEXT = `${CREWHELM_LOGO_PROMPT} ${CREWHELM_LOGO_WORDMARK}`;

export const CREWHELM_LOGO_MARK_PATHS = {
  frame: "M5 5V61H59V38H53V55H11V10H53V27H59V5Z",
  prompt: "M17 18L35 30V34L17 48V41L29 32L17 24Z",
  cursor: "M33 47H48V51H33Z",
} as const;

export const CREWHELM_LOGO_MARK_SVG =
  `<svg class="ch-brand__mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false">` +
  `<defs><linearGradient id="ch-brand-blue" x1="0" y1="0" x2="1" y2="1">` +
  `<stop offset="0" stop-color="#0070ff"></stop><stop offset=".48" stop-color="#0064ff"></stop>` +
  `<stop offset="1" stop-color="#005bfa"></stop></linearGradient></defs>` +
  `<path fill="url(#ch-brand-blue)" d="${CREWHELM_LOGO_MARK_PATHS.frame}"></path>` +
  `<path fill="url(#ch-brand-blue)" d="${CREWHELM_LOGO_MARK_PATHS.prompt}"></path>` +
  `<path fill="url(#ch-brand-blue)" d="${CREWHELM_LOGO_MARK_PATHS.cursor}"></path></svg>`;

export const CREWHELM_COMPACT_BRAND_HTML = `<span class="ch-brand" role="img" aria-label="Crewhelm">${CREWHELM_LOGO_MARK_SVG}<span class="ch-brand__wordmark" aria-hidden="true">CREWHELM</span></span>`;
