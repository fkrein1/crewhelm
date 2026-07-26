/**
 * @typedef {object} Toolchain
 * @property {string} actualNodeVersion
 * @property {string} expectedNodeVersion
 * @property {unknown} expectedPackageManager
 * @property {string | undefined} packageManagerExecutable
 * @property {string | undefined} userAgent
 */

/**
 * Validate the executable toolchain before repository checks run.
 *
 * @param {Toolchain} toolchain
 * @returns {string[]}
 */
export function validateToolchain(toolchain) {
  const errors = [];
  const expectedPackageManager =
    typeof toolchain.expectedPackageManager === "string" ? toolchain.expectedPackageManager : "";
  const packageManagerMatch = /^pnpm@([^+]+)\+sha512\.([a-f0-9]{128})$/.exec(
    expectedPackageManager,
  );

  if (toolchain.actualNodeVersion !== toolchain.expectedNodeVersion) {
    errors.push(
      `Expected Node.js ${toolchain.expectedNodeVersion}, received ${toolchain.actualNodeVersion}.`,
    );
  }

  if (!packageManagerMatch) {
    errors.push("package.json must pin pnpm with an exact version and SHA-512 integrity hash.");
  }

  const expectedPnpmVersion = packageManagerMatch?.[1];
  const actualPnpmVersion = /^pnpm\/(\S+)/.exec(toolchain.userAgent ?? "")?.[1];

  if (!actualPnpmVersion) {
    errors.push("Run verification through pnpm.");
  } else if (expectedPnpmVersion && actualPnpmVersion !== expectedPnpmVersion) {
    errors.push(`Expected pnpm ${expectedPnpmVersion}, received ${actualPnpmVersion}.`);
  }

  const executableName = toolchain.packageManagerExecutable?.split(/[\\/]/).at(-1)?.toLowerCase();

  if (!executableName?.includes("pnpm")) {
    errors.push("The active package-manager executable must be pnpm.");
  }

  return errors;
}
