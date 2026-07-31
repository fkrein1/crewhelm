/** @param {string} source */
export function normalizeSourceMapText(source) {
  const sourceMap = JSON.parse(source);

  if (typeof sourceMap !== "object" || sourceMap === null || Array.isArray(sourceMap)) {
    throw new TypeError("Source map must be a JSON object.");
  }

  sourceMap.sourceRoot = ".";
  return `${JSON.stringify(sourceMap)}\n`;
}
