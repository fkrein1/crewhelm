# Declaration-check exception

`skipLibCheck` is allowed only in a leaf-package tsconfig after a no-skip run proves every
suppressed diagnostic comes from exact-pinned third-party declarations and none from Crewhelm
source. Crewhelm source must still typecheck; audit and license review must pass; and focused
runtime integration tests must cover the affected imports.

Never enable it in a root or shared config. Record the packages, diagnostic classes, evidence, and
removal trigger in the relevant decision record. On any affected dependency or TypeScript upgrade,
rerun without the exception and remove it when clean.
