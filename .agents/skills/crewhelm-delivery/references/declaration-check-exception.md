# Declaration-check exception

`skipLibCheck` is allowed only in a leaf-package tsconfig after a no-skip run proves every
suppressed diagnostic comes from exact-pinned third-party declarations and none from Crewhelm
source. Crewhelm source must still typecheck; audit and license review must pass; and focused
runtime integration tests must cover the affected imports.

Never enable it in a root or shared config. Record the packages, diagnostic classes, evidence, and
removal trigger beside the leaf config. On any affected dependency or TypeScript upgrade, rerun
without the exception and remove it when clean.

The current Worker exception covers exact-pinned Better Auth, OAuth Provider, Better Fetch, and
Drizzle declarations for optional non-Worker runtimes. Better Auth `1.7.0-beta.10` includes the fix
for GHSA-p2fr-6hmx-4528; `1.7.0-rc.2` was rejected because its Drizzle adapter generated an invalid
account lookup. Re-review the pin and the exception together.
