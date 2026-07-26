# Simplification review

Use this after focused tests pass for nontrivial code. The standard is
`docs/engineering/code-philosophy.md`.

1. Freeze observable behavior, contracts, and invariants.
2. Limit review to changed code and immediate callers.
3. Ask: would a clean implementation use a materially simpler design?
4. Remove accidental concepts, indirection, nesting, duplication, weak names, and scattered logic.
5. Preserve security, recovery, observability, and ownership boundaries.
6. Re-run focused tests and `pnpm verify`.

Clarity outranks line count. Do not turn simplification into unrelated cleanup or a dense rewrite.
