import { describe, expect, it, vi } from "vitest";

import {
  composioEventMatchesConfiguration,
  composioProviderTriggerConfiguration,
  createComposioEventCatalog,
} from "./triggers.js";

function catalogResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return Response.json(body, { ...init, headers });
}

function trigger(overrides: Record<string, unknown> = {}) {
  return {
    config: {
      owner: {
        description: "Repository owner",
        required: true,
        type: "string",
      },
      repo: {
        display_name: "Repository",
        required: true,
        type: "string",
      },
    },
    description: "Triggers when a pull request changes.",
    name: "Pull request changed",
    requires_webhook_endpoint_setup: false,
    slug: "GITHUB_PULL_REQUEST_EVENT",
    toolkit: { name: "GitHub", slug: "github" },
    type: "webhook",
    version: "20260701_00",
    ...overrides,
  };
}

describe("Composio event catalog adapter", () => {
  it("discovers only the bounded initial Watch cohort through fixed paginated requests", async () => {
    const apiKey = "composio-project-secret";
    const cancellation = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        catalogResponse({
          items: [
            trigger(),
            trigger({
              name: "Commit created",
              slug: "GITHUB_COMMIT_EVENT",
            }),
          ],
          next_cursor: "second-page",
        }),
      )
      .mockResolvedValueOnce(
        catalogResponse({
          items: [
            trigger({
              config: {
                action: {
                  label: "Action",
                  options: ["created", "updated"],
                  type: "enum",
                },
                includeDrafts: {
                  name: "Include drafts",
                  type: "boolean",
                },
                minimumReviewers: {
                  type: "integer",
                },
              },
              description: null,
              name: "Issue changed",
              slug: "GITHUB_ISSUE_EVENT",
              type: "polling",
              version: "20260702_00",
            }),
          ],
          next_cursor: null,
        }),
      );
    const result = await createComposioEventCatalog({
      apiKey,
      fetch: fetchMock,
      signal: cancellation.signal,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [index, [rawEndpoint, init]] of fetchMock.mock.calls.entries()) {
      expect(rawEndpoint).toBeInstanceOf(URL);
      if (!(rawEndpoint instanceof URL)) {
        throw new TypeError("Expected the adapter to use a fixed URL.");
      }

      expect(rawEndpoint.origin).toBe("https://backend.composio.dev");
      expect(rawEndpoint.pathname).toBe("/api/v3.1/triggers_types");
      expect(Object.fromEntries(rawEndpoint.searchParams)).toEqual({
        ...(index === 1 ? { cursor: "second-page" } : {}),
        limit: "50",
        toolkit_slugs: "github",
        toolkit_versions: "latest",
      });
      expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }

    cancellation.abort();
    expect(result).toEqual({
      events: [
        {
          configuration: [
            {
              description: null,
              id: "action",
              label: "Action",
              options: ["created", "updated"],
              required: false,
              type: "select",
            },
            {
              description: null,
              id: "includeDrafts",
              label: "Include drafts",
              options: [],
              required: false,
              type: "boolean",
            },
            {
              description: null,
              id: "minimumReviewers",
              label: "Minimum reviewers",
              options: [],
              required: false,
              type: "number",
            },
          ],
          delivery: "provider_polling",
          description: null,
          integration: { name: "GitHub", slug: "github" },
          name: "Issue changed",
          slug: "GITHUB_ISSUE_EVENT",
          version: "20260702_00",
        },
        {
          configuration: [
            {
              description: "Repository owner",
              id: "owner",
              label: "Owner",
              options: [],
              required: true,
              type: "string",
            },
            {
              description: null,
              id: "repo",
              label: "Repository",
              options: [],
              required: true,
              type: "string",
            },
          ],
          delivery: "realtime",
          description: "Triggers when a pull request changes.",
          integration: { name: "GitHub", slug: "github" },
          name: "Pull request changed",
          slug: "GITHUB_PULL_REQUEST_EVENT",
          version: "20260701_00",
        },
      ],
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("returns no event cohort for unsupported integrations without contacting Composio", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const catalog = createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    });
    const results = await Promise.all([
      catalog.listWatchableEvents({ integrationSlug: "notion" }),
      catalog.listWatchableEvents({ integrationSlug: "constructor" }),
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toEqual([
      { events: [], ok: true },
      { events: [], ok: true },
    ]);
  });

  it.each([
    ["gmail", "GMAIL_NEW_MESSAGE"],
    ["gmail", "GMAIL_MESSAGE_RECEIVED"],
  ])("accepts supported %s message-event aliases", async (toolkit, slug) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          trigger({
            config: {},
            name: "Message received",
            slug,
            toolkit: { name: toolkit, slug: toolkit },
          }),
        ],
        next_cursor: null,
      }),
    );

    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: toolkit });

    expect(result).toMatchObject({
      events: [{ slug }],
      ok: true,
    });
  });

  it.each(["SLACK_NEW_CHANNEL_MESSAGE", "SLACK_CHANNEL_MESSAGE_RECEIVED"])(
    "excludes unverified Slack message source %s",
    async (slug) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        catalogResponse({
          items: [
            trigger({
              config: {},
              name: "Message received",
              slug,
              toolkit: { name: "Slack", slug: "slack" },
            }),
          ],
          next_cursor: null,
        }),
      );
      const result = await createComposioEventCatalog({
        apiKey: "composio-project-secret",
        fetch: fetchMock,
      }).listWatchableEvents({ integrationSlug: "slack" });

      expect(result).toEqual({ events: [], ok: true });
    },
  );

  it("normalizes current JSON Schema trigger configurations", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          trigger({
            config: {
              properties: {
                channel: {
                  description: "Optional channel",
                  enum: ["general", "rehearsals"],
                  title: "Slack channel",
                  type: "string",
                },
              },
              required: ["channel"],
              title: "Slack message trigger",
              type: "object",
            },
            name: "Message received",
            slug: "SLACK_RECEIVE_MESSAGE",
            toolkit: { name: "Slack", slug: "slack" },
          }),
        ],
        next_cursor: null,
      }),
    );

    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "slack" });

    expect(result).toMatchObject({
      events: [
        {
          configuration: [
            {
              description: "Optional channel",
              id: "channel",
              label: "Slack channel",
              options: ["general", "rehearsals"],
              required: true,
              type: "select",
            },
          ],
          slug: "SLACK_RECEIVE_MESSAGE",
        },
      ],
      ok: true,
    });
  });

  it("requires and locally enforces a channel for unfiltered Slack message sources", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          trigger({
            config: {},
            name: "Message received",
            slug: "SLACK_RECEIVE_MESSAGE",
            toolkit: { name: "Slack", slug: "slack" },
          }),
        ],
        next_cursor: null,
      }),
    );
    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "slack" });

    expect(result).toMatchObject({
      events: [
        {
          configuration: [
            {
              id: "channelId",
              label: "Slack channel",
              required: true,
              type: "string",
            },
          ],
          slug: "SLACK_RECEIVE_MESSAGE",
        },
      ],
      ok: true,
    });
    expect(
      composioProviderTriggerConfiguration("SLACK_RECEIVE_MESSAGE", {
        channelId: "C0BM0EQS27R",
      }),
    ).toEqual({});
    expect(
      composioEventMatchesConfiguration(
        "SLACK_RECEIVE_MESSAGE",
        { channelId: "C0BM0EQS27R" },
        { channel: "C0BM0EQS27R" },
      ),
    ).toBe(true);
    expect(
      composioEventMatchesConfiguration(
        "SLACK_RECEIVE_MESSAGE",
        { channelId: "C0BM0EQS27R" },
        { channel: "CGTGMUMNC" },
      ),
    ).toBe(false);
  });

  it("omits provider-setup and unsupported-configuration triggers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          trigger({
            requires_webhook_endpoint_setup: true,
            slug: "GITHUB_ISSUE_EVENT",
          }),
          trigger({
            config: { repository: { type: "secret-provider-shape" } },
            slug: "GITHUB_ISSUE_CHANGED_EVENT",
          }),
        ],
        next_cursor: null,
      }),
    );
    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(result).toEqual({ events: [], ok: true });
  });

  it("fails closed for substituted toolkit identities and incomplete pagination", async () => {
    const substituted = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        catalogResponse({
          items: [trigger({ toolkit: { name: "Slack", slug: "slack" } })],
          next_cursor: null,
        }),
      ),
    }).listWatchableEvents({ integrationSlug: "github" });
    const repeatedCursor = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(catalogResponse({ items: [], next_cursor: "same-cursor" })),
    }).listWatchableEvents({ integrationSlug: "github" });

    for (const result of [substituted, repeatedCursor]) {
      expect(result).toEqual({
        error: {
          code: "integration_catalog_unavailable",
          message: "Integration event catalog request denied.",
        },
        ok: false,
      });
    }
  });

  it("rejects secret-bearing cursors before they can enter a request URL", async () => {
    const apiKey = "composio-project-secret";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [],
        next_cursor: `reflected-${apiKey}`,
      }),
    );
    const result = await createComposioEventCatalog({
      apiKey,
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("normalizes loose toolkit data and deduplicates identical cross-page events", async () => {
    const duplicate = trigger({
      toolkit: {
        credentials: "provider-secret",
        name: "GitHub",
        nested: { unexpected: true },
        slug: "github",
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catalogResponse({ items: [duplicate], next_cursor: "second-page" }))
      .mockResolvedValueOnce(catalogResponse({ items: [duplicate], next_cursor: null }));
    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected a bounded event catalog.");
    }

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.integration).toEqual({ name: "GitHub", slug: "github" });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("unexpected");
  });

  it("rejects conflicting duplicate event identities", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catalogResponse({ items: [trigger()], next_cursor: "second-page" }))
      .mockResolvedValueOnce(
        catalogResponse({
          items: [trigger({ description: "Substituted event definition." })],
          next_cursor: null,
        }),
      );
    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(result.ok).toBe(false);
  });

  it("rejects duplicate identities that disagree about configuration eligibility", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(catalogResponse({ items: [trigger()], next_cursor: "second-page" }))
      .mockResolvedValueOnce(
        catalogResponse({
          items: [trigger({ config: { repository: { type: "secret-provider-shape" } } })],
          next_cursor: null,
        }),
      );
    const result = await createComposioEventCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    }).listWatchableEvents({ integrationSlug: "github" });

    expect(result.ok).toBe(false);
  });

  it("rejects unavailable, oversized, invalid, or secret-bearing provider responses", async () => {
    const apiKey = "composio-project-secret";
    const cases: Array<() => Promise<Response>> = [
      async () => catalogResponse({}, { status: 503 }),
      async () => new Response("not json", { status: 200 }),
      async () =>
        catalogResponse({
          items: [trigger({ description: apiKey })],
          next_cursor: null,
        }),
      async () =>
        catalogResponse({
          items: [trigger({ name: "x".repeat(161) })],
          next_cursor: null,
        }),
      async () =>
        new Response(`{"padding":"${"x".repeat(512 * 1_024)}"}`, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    ];

    for (const response of cases) {
      const result = await createComposioEventCatalog({
        apiKey,
        fetch: vi.fn<typeof fetch>().mockImplementation(response),
      }).listWatchableEvents({ integrationSlug: "github" });

      expect(result.ok).toBe(false);
    }
  });
});
