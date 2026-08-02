# Documentation information architecture

Crewhelm uses four page types, adapted from Diátaxis. Each type answers a different reader need;
one page must not attempt to serve all four.

| Public path        | Page type   | Reader need                         | Content leads with                 |
| ------------------ | ----------- | ----------------------------------- | ---------------------------------- |
| `/docs/start/`     | Tutorial    | Learn through one successful path   | Guided experience and checkpoints  |
| `/docs/guides/`    | How-to      | Complete a specific task            | Preconditions, steps, and recovery |
| `/docs/concepts/`  | Explanation | Understand a model or design choice | Relationships and boundaries       |
| `/docs/reference/` | Reference   | Look up exact facts                 | The product contract               |

The `/docs/` landing page routes readers by outcome and experience rather than listing every
feature. Security is a cross-cutting boundary: explain it where the reader needs it and link to one
canonical public security explanation rather than repeating guarantees across pages.

## Placement rules

- Put installation and the first bounded success path in `start`.
- Put one concrete operator outcome in each `guides` page. Use verb-led titles.
- Put authority, custody, lifecycle, and Agent/Run/Workflow mental models in `concepts`.
- Put commands, options, tools, schemas, limits, and errors in `reference`; generate them from the
  owning contract where possible.
- Keep contributor process, internal architecture, threat analysis, and operational deployment
  authority in repository documentation unless a public reader need requires a separate page.
- Link across types when a task needs background or exact facts. Do not duplicate the background
  or reference inside the procedure.

## Navigation and routes

Routes are durable public interfaces. Prefer short nouns for concepts and verb phrases for tasks.
Do not encode release labels or implementation packages in a route.

Navigation should expose a small start path, common tasks, core concepts, and reference. Generate
local navigation from page metadata where possible so independent authors do not contend for one
shared list. Shared navigation, content schema, redirects, search, sitemap, and agent-discovery
files have one lead owner per change.

A moved route requires a permanent redirect. A retired route must leave navigation, internal links,
search, sitemap, and agent discovery in the same pull request.

## Page templates

- [Tutorial](templates/tutorial.md)
- [How-to](templates/how-to.md)
- [Explanation](templates/explanation.md)
- [Reference](templates/reference.md)
