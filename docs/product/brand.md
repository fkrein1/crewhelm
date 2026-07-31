# Crewhelm brand

Crewhelm gives Agents a mandate, not a master key.

That sentence is the shortest expression of the product: useful autonomy inside authority an owner
can understand, change, and recover. Every Crewhelm surface should make power feel legible rather
than magical.

## What Crewhelm stands for

- **Owner control.** The system runs in infrastructure the owner controls. Crewhelm works for the
  owner; it does not become another principal.
- **Bounded autonomy.** Routine work should move without repeated ceremony. Work that crosses an
  authority boundary should stop with context.
- **Legible authority.** A tool, connection, or visible action is not permission. Show the exact
  grant, Agent revision, budget, decision, and line of custody that matters.
- **Recoverable operations.** Denial, expiry, interruption, and partial failure are product states.
  Explain what is known, whether retrying is safe, and the bounded next action.
- **Infrastructure clarity.** Cloudflare runs durable execution, Composio holds provider
  credentials, and Crewhelm owns the authority between intent and action.

## Voice

Crewhelm sounds calm, direct, and exact. It is confident because the boundaries are explicit, not
because the copy makes sweeping claims.

Write in short declarative sentences. Lead with the outcome, then name the boundary or next action.
Prefer concrete verbs: create, grant, approve, deny, run, stop, inspect, retry, revoke. Use the domain
language in `CONTEXT.md`, including capitalized **Agent** and **Agent revision**.

Good Crewhelm copy:

- “Crewhelm is ready.”
- “This client is requesting Full control.”
- “Authorization stopped. Return to your MCP client and request a new link.”
- “No hard dollar limit is configured.”

Avoid:

- hype such as “revolutionary,” “effortless,” “limitless,” or “AI magic”;
- personifying the control plane or implying that it grants itself authority;
- vague success (“All done!”) or vague failure (“Something went wrong”);
- platform jargon when an owner-facing description is clearer; and
- security claims that name a feeling instead of the actual control.

### Errors and waiting states

State four things when they apply: what stopped, what Crewhelm knows, whether retrying is safe, and
what the owner can do next. Do not expose raw provider payloads, credentials, signed URLs, or
internal exception text to make an error sound more detailed.

## Visual language

The visual system is an editorial operations manual: functional, typographic, and deliberately
plain-spoken.

- **Paper, ink, signal blue.** Warm paper and near-black ink carry the content. Blue marks control,
  navigation, and Crewhelm identity. Green, amber, and red are reserved for operational meaning.
- **Type creates hierarchy.** Use a bold sans serif for decisive headings, a mono face for metadata
  and machine state, and a restrained serif italic only for human emphasis.
- **Rules show structure.** Thin borders, ledgers, numbered sections, and custody diagrams make the
  system inspectable. Prefer square geometry and offset shadows to soft cards and ambient blur.
- **Motion confirms action.** Keep it brief and functional. Never animate past a decision or make a
  waiting state look complete.
- **Dense where authority matters.** Marketing may breathe. Approval, setup, and diagnostic
  surfaces should prioritize exact names, scopes, destinations, status, and next actions.

The compact mark is `>_ CREWHELM`. Keep the prompt blue, the wordmark uppercase, and enough clear
space for it to read as a signature rather than terminal decoration.

## Surface rules

### Public site

Start with the owner outcome, demonstrate an authority decision, explain the operating philosophy,
then show the custody boundary. The public site may be expressive, but every product claim must map
to a current capability or be clearly framed as future direction.

### Authorization and setup pages

These pages are decisions, not campaigns. Name the client, access level, return destination, and
consequence. Primary and deny actions must remain visually distinct. Do not trade exact permission
language for friendlier but weaker language.

### CLI

The CLI bootstraps and diagnoses; it is not a control center. Use the compact mark once, concise
section headings, aligned operational facts, and explicit `PASS`, `FAIL`, `SKIP`, or `WAITING`
states. Preserve copy-pastable plain output when color is disabled.

### MCP and future product UI

Structured results remain authoritative. Presentation should progressively disclose detail while
keeping Agent revision, grant, budget, approval, and recovery state reachable. Future recipe pages
must distinguish popularity from trust and requested authority from granted authority.

## Review checklist

Before shipping a user-facing surface, verify:

1. Is the owner’s outcome stated before implementation detail?
2. Are authority, custody, and external effects named precisely?
3. Does every wait, denial, and failure provide an honest next action?
4. Does the design use the shared tokens and compact mark instead of inventing a local brand?
5. Are green, amber, and red carrying operational meaning only?
6. Does the surface remain clear without color, animation, or JavaScript?
7. Would the language still be accurate in an audit record or support conversation?
