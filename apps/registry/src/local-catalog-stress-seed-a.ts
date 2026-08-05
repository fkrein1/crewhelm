import { composioConnection, TOOLKIT_VERSION, type SeedDefinition } from "./testing-seed.js";

const MARKDOWN_OUTPUT = { kind: "markdown" as const };

export const localCatalogStressDefinitionsA = [
  {
    boundaries: ["Cite source records and mark missing context."],
    capabilities: ["sandbox", "web-fetch", "web-search"],
    connections: [
      composioConnection("a-drive-source", "googledrive", "Read planning documents.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "GOOGLEDRIVE_FIND_FILE",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("a-mail-source", "gmail", "Read selected executive threads.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "GMAIL_FETCH_EMAILS",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("a-notion-source", "notion", "Read strategy pages.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "NOTION_SEARCH_NOTION_PAGE",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Combine scattered executive context into a concise weekly decision brief.",
    inputs: [
      {
        description: "The decisions and reporting window to review.",
        kind: "invocation",
        name: "executive-window",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["anthropic/claude-sonnet-5"],
      primaryModel: "openai/gpt-5.6-luna",
    },
    instructions: "Reconcile the selected sources and prepare a grounded executive brief.",
    name: "executive-context-reconciler",
    operation: {
      inputNames: ["executive-window"],
      kind: "workflow",
      name: "reconcile-executive-context",
      objective: "Produce a decision-ready weekly brief from selected company sources.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "Source review", prompt: "Collect material facts and disagreements." },
        { name: "Brief", prompt: "Summarize decisions, risks, and open questions." },
      ],
    },
    outcome: "Leaders receive one traceable view of current decisions and risks.",
    sample: "# Weekly brief\n\nTwo decisions are ready; pricing ownership remains unresolved.",
    schedules: [
      {
        instruction: "Review the current weekly source window and prepare the executive brief.",
        name: "friday-executive-reconciliation",
        outputContract: MARKDOWN_OUTPUT,
        trigger: {
          at: "15:30",
          daysOfWeek: ["friday"],
          frequency: "weekly",
          timeZone: "owner-selected",
          type: "calendar",
        },
      },
    ],
    skillDescription: "Reconcile evidence across company systems without hiding disagreement.",
    skillInstructions: "Map each material claim to a source and label conflicts before synthesis.",
    skillName: "cross-system-evidence-reconciliation",
    suggestedName: "Executive context reconciler",
    summary: "Reconcile company context into an executive brief.",
    tags: ["executive-operations", "multi-source", "weekly-review"],
    title: "Executive Context Reconciler",
  },
  {
    boundaries: ["Never send mail or change issue state automatically."],
    capabilities: ["web-search"],
    connections: [
      composioConnection("b-escalation-mail", "gmail", "Read newly received messages.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "GMAIL_FETCH_EMAILS",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("b-escalation-tracker", "linear", "Read related product issues.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "LINEAR_LIST_ISSUES",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Triage urgent customer email against related product work and evidence.",
    eventTriggers: [
      {
        connectionSlot: "b-escalation-mail",
        delivery: "realtime",
        eventSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        eventVersion: TOOLKIT_VERSION,
        filters: {},
        instruction: "Assess the new message and draft a reviewable escalation brief.",
        integration: "gmail",
        name: "new-customer-escalation",
        outputContract: MARKDOWN_OUTPUT,
      },
    ],
    inputs: [
      {
        description: "A message or customer escalation to assess on demand.",
        kind: "invocation",
        name: "escalation-message",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["openai/gpt-5.6-terra"],
      primaryModel: "anthropic/claude-opus-5",
    },
    instructions: "Triage customer escalations using message and product evidence.",
    name: "customer-escalation-triage",
    operation: {
      inputNames: ["escalation-message"],
      kind: "run",
      name: "triage-customer-escalation",
      outputContract: MARKDOWN_OUTPUT,
      prompt: "Return severity, supporting evidence, missing context, and a proposed owner.",
    },
    outcome: "Teams receive fast, evidence-led escalation briefs without automatic writes.",
    sample: "# Escalation\n\nSeverity: high. Related issue exists; confirm affected account count.",
    skillDescription: "Assess customer escalation severity from bounded evidence.",
    skillInstructions: "Separate customer claims, system facts, impact, and missing verification.",
    skillName: "customer-escalation-assessment",
    suggestedName: "Customer escalation triage steward",
    summary: "Triage incoming customer escalations with product context.",
    tags: ["customer-support", "email", "triage"],
    title: "Customer Escalation Triage",
  },
  {
    boundaries: ["Do not provide legal conclusions or alter source files."],
    capabilities: ["sandbox", "web-fetch"],
    connections: [
      composioConnection("c-contract-archive", "dropbox", "Read archived agreements.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "DROPBOX_SEARCH_FILES",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("c-contract-drive", "googledrive", "Read current agreements.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "GOOGLEDRIVE_FIND_FILE",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Compare long agreements across active and archived document stores.",
    inputs: [
      {
        description: "Contract names and comparison questions.",
        kind: "invocation",
        name: "contract-set",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["anthropic/claude-sonnet-5"],
      primaryModel: "xai/grok-4.5",
    },
    instructions: "Compare supplied agreements, quoting clauses and flagging uncertainty.",
    name: "multi-repository-contract-comparator",
    operation: {
      inputNames: ["contract-set"],
      kind: "workflow",
      name: "compare-contract-repositories",
      objective: "Produce a traceable comparison of selected contract terms.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "Clause map", prompt: "Locate comparable clauses and record their sources." },
        { name: "Difference brief", prompt: "Summarize meaningful differences and questions." },
      ],
    },
    outcome: "Reviewers receive a source-linked comparison for further legal review.",
    sample: "# Contract comparison\n\nRenewal periods differ by 30 days; legal review is required.",
    skillDescription: "Compare lengthy documents while preserving clause provenance.",
    skillInstructions: "Use a stable comparison table and quote only the minimum relevant text.",
    skillName: "contract-clause-comparison",
    suggestedName: "Multi-repository contract comparator",
    summary: "Compare agreements across document repositories.",
    tags: ["contracts", "document-analysis", "operations"],
    title: "Multi-Repository Contract Comparator",
  },
  {
    boundaries: ["Do not create, update, or close Linear issues automatically."],
    capabilities: ["sandbox", "web-search"],
    connections: [
      composioConnection("d-sprint-linear", "linear", "Read sprint and issue changes.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "LINEAR_LIST_ISSUES",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Detect sprint risk from incoming Linear issues and current workload.",
    eventTriggers: [
      {
        connectionSlot: "d-sprint-linear",
        delivery: "realtime",
        eventSlug: "LINEAR_ISSUE_CREATED",
        eventVersion: TOOLKIT_VERSION,
        filters: {},
        instruction: "Assess whether the new issue changes sprint risk and explain why.",
        integration: "linear",
        name: "new-sprint-risk-signal",
        outputContract: MARKDOWN_OUTPUT,
      },
    ],
    inputs: [
      {
        description: "Sprint identifier or planning question.",
        kind: "invocation",
        name: "sprint-window",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["moonshotai/kimi-k3"],
      primaryModel: "mistralai/mistral-large-3.1-reasoning",
    },
    instructions: "Assess sprint delivery risk from issue evidence and stated capacity.",
    name: "linear-sprint-risk-radar",
    operation: {
      inputNames: ["sprint-window"],
      kind: "run",
      name: "assess-linear-sprint-risk",
      outputContract: MARKDOWN_OUTPUT,
      prompt: "Return delivery risks, evidence, confidence, and the smallest mitigation.",
    },
    outcome: "Delivery teams see emerging sprint risks without automated issue changes.",
    sample:
      "# Sprint risk\n\nRisk is elevated: two blockers lack owners and capacity is fully allocated.",
    skillDescription: "Assess sprint risk from workload, dependencies, and uncertainty.",
    skillInstructions:
      "Measure risk consistently and distinguish observed blockers from forecasts.",
    skillName: "sprint-delivery-risk-assessment",
    suggestedName: "Linear sprint risk radar",
    summary: "Surface emerging delivery risk from Linear activity.",
    tags: ["engineering", "linear", "sprint-planning"],
    title: "Linear Sprint Risk Radar",
  },
  {
    boundaries: ["Never modify Jira, Notion, or design files automatically."],
    capabilities: ["sandbox", "web-fetch", "web-search"],
    connections: [
      composioConnection("e-release-design", "figma", "Read selected design files.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "FIGMA_GET_FILE",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("e-release-jira", "jira", "Read release issues.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "JIRA_SEARCH_ISSUES",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("e-release-notion", "notion", "Read launch plans.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "NOTION_SEARCH_NOTION_PAGE",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Reconcile launch plans, delivery issues, and designs into a release risk map.",
    eventTriggers: [
      {
        connectionSlot: "e-release-jira",
        delivery: "provider_polling",
        eventSlug: "JIRA_NEW_ISSUE",
        eventVersion: TOOLKIT_VERSION,
        filters: {},
        instruction: "Assess whether the new issue changes the current release risk map.",
        integration: "jira",
        name: "new-release-issue-signal",
        outputContract: MARKDOWN_OUTPUT,
      },
    ],
    inputs: [
      {
        description: "Release name and decision deadline.",
        kind: "invocation",
        name: "release-context",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["xai/grok-4.5"],
      primaryModel: "moonshotai/kimi-k3",
    },
    instructions: "Build a release risk map from plans, issues, and design evidence.",
    name: "cross-functional-release-risk-map",
    operation: {
      inputNames: ["release-context"],
      kind: "workflow",
      name: "map-cross-functional-release-risk",
      objective: "Produce a current release readiness view across three systems.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "Readiness evidence", prompt: "Reconcile scope, implementation, and design." },
        { name: "Risk map", prompt: "Rank blockers, owners, uncertainty, and next checks." },
      ],
    },
    outcome: "Release owners receive one evidence-backed readiness and risk view.",
    sample:
      "# Release risk map\n\nCheckout is blocked; two design states lack implementation evidence.",
    skillDescription: "Reconcile cross-functional release evidence across systems.",
    skillInstructions: "Evaluate scope, dependencies, validation, and ownership independently.",
    skillName: "cross-functional-release-reconciliation",
    suggestedName: "Cross-functional release risk mapper",
    summary: "Reconcile Jira, Notion, and Figma release evidence.",
    tags: ["jira", "release-management", "risk"],
    title: "Cross-Functional Release Risk Map",
  },
  {
    boundaries: ["Do not send messages, accept invitations, or change calendar events."],
    capabilities: ["web-fetch"],
    connections: [
      composioConnection("f-board-outlook", "outlook", "Read selected mail and events.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "OUTLOOK_LIST_EVENTS",
          version: TOOLKIT_VERSION,
        },
        {
          authorization: "standing",
          effect: "read",
          slug: "OUTLOOK_LIST_MESSAGES",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Prepare a compact daily board agenda from Outlook context and public evidence.",
    inputs: [
      {
        description: "A Brief containing standing board priorities.",
        kind: "brief",
        name: "board-priorities",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["anthropic/claude-haiku-4.5"],
      primaryModel: "openai/gpt-5.6-sol",
    },
    instructions: "Prepare board meeting context without taking calendar or email actions.",
    name: "outlook-board-agenda-preparer",
    operation: {
      inputNames: ["board-priorities"],
      kind: "run",
      name: "prepare-outlook-board-agenda",
      outputContract: MARKDOWN_OUTPUT,
      prompt: "Build an agenda with known context, missing evidence, and decision questions.",
    },
    outcome: "Board participants receive a concise and traceable preparation agenda.",
    sample: "# Board agenda\n\nDecision: approve pilot range. Missing: latest retention cohort.",
    schedules: [
      {
        briefInputNames: ["board-priorities"],
        instruction: "Review the next day of board events and prepare the meeting agenda.",
        name: "daily-board-agenda-preparation",
        outputContract: MARKDOWN_OUTPUT,
        trigger: {
          at: "18:00",
          frequency: "daily",
          timeZone: "owner-selected",
          type: "calendar",
        },
      },
    ],
    skillDescription: "Prepare high-stakes agendas from bounded communication context.",
    skillInstructions: "Prioritize decisions, evidence gaps, and questions over narrative summary.",
    skillName: "board-agenda-evidence-preparation",
    suggestedName: "Outlook board agenda preparer",
    summary: "Prepare board agendas from Outlook context.",
    tags: ["board", "meetings", "outlook"],
    title: "Outlook Board Agenda Preparer",
  },
  {
    boundaries: ["Do not change Airtable records or infer missing operational facts."],
    capabilities: ["sandbox", "web-search"],
    connections: [
      composioConnection("g-operations-airtable", "airtable", "Read selected operational bases.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "AIRTABLE_LIST_RECORDS",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Audit wide operational tables for data quality, bottlenecks, and exceptions.",
    inputs: [
      {
        description: "Base, table, and operational question to audit.",
        kind: "invocation",
        name: "operations-table",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["openai/gpt-5.6-luna"],
      primaryModel: "mistralai/mistral-medium-3.1-instruct-long-context",
    },
    instructions: "Profile operational records before reporting patterns or exceptions.",
    name: "airtable-operations-quality-auditor",
    operation: {
      inputNames: ["operations-table"],
      kind: "workflow",
      name: "audit-airtable-operations-quality",
      objective: "Produce a reproducible operational quality and bottleneck audit.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "Quality profile", prompt: "Measure completeness and consistency." },
        { name: "Operations brief", prompt: "Report bottlenecks, exceptions, and caveats." },
      ],
    },
    outcome: "Operators receive a reproducible audit with clear limitations.",
    sample: "# Operations audit\n\nTwelve records lack owners; cycle-time findings exclude them.",
    skillDescription: "Audit operational tables with data-quality-first methods.",
    skillInstructions: "Profile schema, missingness, duplicates, and outliers before analysis.",
    skillName: "operational-table-quality-audit",
    suggestedName: "Airtable operations quality auditor",
    summary: "Audit Airtable operations data before acting on it.",
    tags: ["airtable", "data-quality", "operations"],
    title: "Airtable Operations Quality Auditor",
  },
  {
    boundaries: ["Never reassign tasks or modify Asana projects automatically."],
    capabilities: ["sandbox", "web-fetch", "web-search"],
    connections: [
      composioConnection("h-workload-asana", "asana", "Read projects and assigned tasks.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "ASANA_GET_TASKS",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Analyze cross-project workload and propose a balanced review plan.",
    inputs: [
      {
        description: "Teams, projects, and planning horizon to assess.",
        kind: "invocation",
        name: "workload-scope",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["mistralai/mistral-large-3.1-reasoning"],
      primaryModel: "anthropic/claude-sonnet-5",
    },
    instructions: "Assess workload from task evidence and state capacity assumptions.",
    name: "asana-portfolio-capacity-reviewer",
    operation: {
      inputNames: ["workload-scope"],
      kind: "run",
      name: "review-asana-portfolio-capacity",
      outputContract: MARKDOWN_OUTPUT,
      prompt: "Return workload hotspots, dependencies, assumptions, and review options.",
    },
    outcome: "Managers receive a reviewable portfolio capacity assessment.",
    sample:
      "# Capacity review\n\nDesign has three overlapping deadlines; allocation data is incomplete.",
    schedules: [
      {
        instruction: "Review the active portfolio and prepare the weekly capacity readout.",
        name: "monday-portfolio-capacity-review",
        outputContract: MARKDOWN_OUTPUT,
        trigger: {
          at: "08:15",
          daysOfWeek: ["monday"],
          frequency: "weekly",
          timeZone: "owner-selected",
          type: "calendar",
        },
      },
    ],
    skillDescription: "Assess portfolio capacity without assuming task estimates are complete.",
    skillInstructions: "Separate committed load, unestimated work, dependencies, and assumptions.",
    skillName: "portfolio-capacity-evidence-review",
    suggestedName: "Asana portfolio capacity reviewer",
    summary: "Review portfolio capacity and workload from Asana.",
    tags: ["asana", "capacity-planning", "portfolio"],
    title: "Asana Portfolio Capacity Reviewer",
  },
  {
    boundaries: ["Do not delete, move, or overwrite campaign assets."],
    capabilities: ["web-fetch", "web-search"],
    connections: [
      composioConnection("i-campaign-archive", "dropbox", "Read campaign asset archives.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "DROPBOX_SEARCH_FILES",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("i-campaign-plan", "notion", "Read campaign plans.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "NOTION_SEARCH_NOTION_PAGE",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Map campaign plans to archived assets and identify coverage gaps.",
    inputs: [
      {
        description: "Campaign name and channels to inspect.",
        kind: "invocation",
        name: "campaign-scope",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["openai/gpt-5.6-sol"],
      primaryModel: "moonshotai/kimi-k3",
    },
    instructions: "Match campaign requirements to available assets without changing files.",
    name: "campaign-asset-coverage-mapper",
    operation: {
      inputNames: ["campaign-scope"],
      kind: "workflow",
      name: "map-campaign-asset-coverage",
      objective: "Produce a channel-by-channel campaign asset coverage map.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "Requirement map", prompt: "Extract required assets by channel." },
        { name: "Coverage review", prompt: "Match assets and report gaps or ambiguity." },
      ],
    },
    outcome: "Campaign owners see usable assets, missing coverage, and uncertain matches.",
    sample: "# Asset coverage\n\nEmail is complete; paid social lacks a square final asset.",
    skillDescription: "Map campaign requirements to assets using traceable matching criteria.",
    skillInstructions: "Record required format, status, source, and confidence for every match.",
    skillName: "campaign-asset-coverage-analysis",
    suggestedName: "Campaign asset coverage mapper",
    summary: "Map archived assets to campaign requirements.",
    tags: ["campaigns", "content-operations", "dropbox"],
    title: "Campaign Asset Coverage Mapper",
  },
  {
    boundaries: ["Do not edit design files or create implementation tickets."],
    capabilities: ["sandbox", "web-fetch", "web-search"],
    connections: [
      composioConnection("j-design-figma", "figma", "Read selected product designs.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "FIGMA_GET_FILE",
          version: TOOLKIT_VERSION,
        },
      ]),
      composioConnection("j-design-jira", "jira", "Read linked implementation issues.", [
        {
          authorization: "standing",
          effect: "read",
          slug: "JIRA_SEARCH_ISSUES",
          version: TOOLKIT_VERSION,
        },
      ]),
    ],
    description: "Compare detailed Figma states with implementation issue coverage.",
    inputs: [
      {
        description: "Design file and release scope to inspect.",
        kind: "invocation",
        name: "handoff-scope",
        required: true,
      },
    ],
    inference: {
      fallbackModels: ["moonshotai/kimi-k3"],
      primaryModel: "xai/grok-4.5",
    },
    instructions: "Audit design handoff coverage and keep visual inference explicit.",
    name: "figma-implementation-coverage-auditor",
    operation: {
      inputNames: ["handoff-scope"],
      kind: "workflow",
      name: "audit-figma-implementation-coverage",
      objective: "Produce a state-by-state design handoff coverage audit.",
      outputContract: MARKDOWN_OUTPUT,
      stages: [
        { name: "State inventory", prompt: "Inventory visible states and requirements." },
        { name: "Coverage audit", prompt: "Compare states to issues and report gaps." },
      ],
    },
    outcome: "Teams receive a traceable view of design states missing implementation coverage.",
    sample: "# Handoff audit\n\nEmpty and error states have no linked implementation evidence.",
    skillDescription: "Audit design-to-implementation coverage across product states.",
    skillInstructions: "Inventory states first, then map each to explicit issue evidence.",
    skillName: "design-implementation-coverage-audit",
    suggestedName: "Figma implementation coverage auditor",
    summary: "Audit whether implementation work covers each design state.",
    tags: ["design-systems", "figma", "quality"],
    title: "Figma Implementation Coverage Auditor",
  },
] satisfies readonly SeedDefinition[];
