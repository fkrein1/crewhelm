export const CREWHELM_BRAND_NAME = "Crewhelm";
export const CREWHELM_BRAND_PROMISE = "Give Agents a mandate. Not a master key.";
export const CREWHELM_BRAND_POSITIONING =
  "The open-source personal control plane for owner-controlled Agents on Cloudflare.";
export const CREWHELM_LOGO_WORDMARK = "CREWHELM";

export const CREWHELM_LOGO_MARK_PATHS = {
  lowerLeft: "M107 553h140v237h231v155H107V553Z",
  lowerRight: "M775 551h141v394H544V790h231V551Z",
  upperLeft: "M107 78h371v148H247v272H107V78Z",
  upperRight: "M544 78h372v387H775V226H544V78Z",
} as const;

export const CREWHELM_LOGO_MARK_SVG =
  `<svg class="ch-brand__mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">` +
  `<g class="ch-brand__mark-frame">` +
  Object.values(CREWHELM_LOGO_MARK_PATHS)
    .map((path) => `<path d="${path}"></path>`)
    .join("") +
  `</g><rect class="ch-brand__mark-accent" x="442" y="429" width="140" height="143"></rect></svg>`;

export const CREWHELM_COMPACT_BRAND_HTML = `<span class="ch-brand" role="img" aria-label="Crewhelm">${CREWHELM_LOGO_MARK_SVG}<span class="ch-brand__wordmark" aria-hidden="true">CREWHELM</span></span>`;
