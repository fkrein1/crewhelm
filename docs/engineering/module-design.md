# Module design

Crewhelm favors deep modules: callers learn a small interface while the module owns substantial
behavior behind it. This keeps security decisions, failure handling, and provider complexity local
instead of spreading them across MCP handlers, agents, and tests.

## Shared vocabulary

- **Module**: code with an interface and an implementation, at any scale.
- **Interface**: everything a caller must know, including types, invariants, ordering, errors,
  configuration, permissions, and cost characteristics.
- **Seam**: the place where behavior can vary without editing the caller.
- **Adapter**: an implementation that fills a seam.
- **Depth**: the leverage callers receive for the interface they must learn.
- **Locality**: related behavior, knowledge, and verification changing in one place.

Use these terms in design discussions so `interface` is never mistaken for only a TypeScript type.

## Design rules

1. Put seams where ownership, trust, persistence, or an external dependency genuinely changes.
2. Keep the external interface small and explicit; hide orchestration, retries, normalization, and
   policy-safe defaults inside the module.
3. Accept dependencies at the appropriate internal seam instead of constructing remote clients in
   domain behavior.
4. Add an adapter abstraction when behavior actually varies, normally through production and
   faithful test adapters. Do not add pass-through layers for hypothetical flexibility.
5. Treat the external interface as the primary test surface. Tests should survive an internal
   rewrite that preserves observable behavior.
6. Apply the deletion test: removing a valuable module should make its hidden complexity reappear
   in multiple callers. If deletion merely removes indirection, the module is too shallow.

## Consequential-seam checkpoint

When an R2 or R3 change creates or materially changes a public or cross-trust seam:

1. Name the module, its callers, the behavior it owns, and the facts callers must know.
2. Classify dependencies as in-process, locally substitutable, owned remote, or external.
3. Sketch at least two materially different interfaces before selecting one.
4. Compare them for depth, locality, testability, least privilege, and failure containment.
5. Map acceptance tests to the selected interface.

Routine changes should not manufacture alternative designs when the seam is already settled.

## Provenance

This standard adapts the vocabulary and techniques in Matt Pocock's MIT-licensed
[codebase-design skill](https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design),
which in turn draws on John Ousterhout's _A Philosophy of Software Design_. Crewhelm keeps a
project-specific, compact version instead of vendoring the upstream skill suite.
