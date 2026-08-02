import { afterEach, describe, expect, it, vi } from "vitest";

import { createComposioTriggerInstances } from "./trigger-instances.js";

const API_KEY = "composio-project-key-at-least-sixteen";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("Composio trigger instances", () => {
  afterEach(() => vi.restoreAllMocks());

  it("upserts one exact connected-account event source", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ trigger_id: "ti_issue_created" }, 201));
    const triggers = createComposioTriggerInstances({ apiKey: API_KEY, fetch: fetchMock });

    await expect(
      triggers.upsert({
        configuration: { repo: "crewhelm" },
        integrationSlug: "github",
        ownerKey: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
        providerConnectionId: "ca_github",
        sourceSlug: "GITHUB_ISSUE_CREATED",
        sourceVersion: "20260802_00",
      }),
    ).resolves.toEqual({ ok: true, providerTriggerId: "ti_issue_created" });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://backend.composio.dev/api/v3.1/trigger_instances/GITHUB_ISSUE_CREATED/upsert",
    );
    expect(request).toMatchObject({ method: "POST", redirect: "manual" });
    expect(typeof request?.body === "string" ? JSON.parse(request.body) : null).toEqual({
      connected_account_id: "ca_github",
      toolkit_versions: { github: "20260802_00" },
      trigger_config: { repo: "crewhelm" },
      user_id: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
    });
  });

  it("reconciles a documented 204 upsert to one exact active trigger", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              connected_account_id: "ca_github",
              id: "ti_issue_created",
              trigger_config: { repo: "crewhelm", state: "open" },
              trigger_name: "GITHUB_ISSUE_CREATED",
              user_id: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
              version: "20260802_00",
            },
          ],
          next_cursor: null,
        }),
      );
    const triggers = createComposioTriggerInstances({ apiKey: API_KEY, fetch: fetchMock });

    await expect(
      triggers.upsert({
        configuration: { state: "open", repo: "crewhelm" },
        integrationSlug: "github",
        ownerKey: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
        providerConnectionId: "ca_github",
        sourceSlug: "GITHUB_ISSUE_CREATED",
        sourceVersion: "20260802_00",
      }),
    ).resolves.toEqual({ ok: true, providerTriggerId: "ti_issue_created" });

    const [url, request] = fetchMock.mock.calls[1] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      "https://backend.composio.dev/api/v3.1/trigger_instances/active?connected_account_ids=ca_github&limit=2&trigger_names=GITHUB_ISSUE_CREATED&user_ids=owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
    );
    expect(request).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("proves an ambiguous create is absent or resolves it to one exact active trigger", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              connected_account_id: "ca_github",
              id: "ti_wrong_version",
              trigger_config: { repo: "crewhelm" },
              trigger_name: "GITHUB_ISSUE_CREATED",
              user_id: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
              version: "20260701_00",
            },
          ],
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              connected_account_id: "ca_github",
              id: "ti_issue_created",
              trigger_config: { repo: "crewhelm" },
              trigger_name: "GITHUB_ISSUE_CREATED",
              user_id: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
              version: "20260802_00",
            },
          ],
          next_cursor: null,
        }),
      );
    const triggers = createComposioTriggerInstances({ apiKey: API_KEY, fetch: fetchMock });
    const coordinates = {
      configuration: { repo: "crewhelm" },
      ownerKey: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
      providerConnectionId: "ca_github",
      sourceSlug: "GITHUB_ISSUE_CREATED",
      sourceVersion: "20260802_00",
    };

    await expect(triggers.find(coordinates)).resolves.toEqual({
      ok: true,
      providerTriggerId: null,
    });
    await expect(triggers.find(coordinates)).resolves.toEqual({
      ok: true,
      providerTriggerId: "ti_issue_created",
    });
  });

  it("enables and disables only the exact trigger instance", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: "success" }));
    const triggers = createComposioTriggerInstances({ apiKey: API_KEY, fetch: fetchMock });

    await expect(
      triggers.setEnabled({ enabled: false, providerTriggerId: "ti_issue_created" }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://backend.composio.dev/api/v3.1/trigger_instances/manage/ti_issue_created"),
      expect.objectContaining({ body: JSON.stringify({ status: "disable" }), method: "PATCH" }),
    );
  });

  it("treats an already-absent trigger as an idempotent deletion", async () => {
    const triggers = createComposioTriggerInstances({
      apiKey: API_KEY,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 })),
    });

    await expect(triggers.delete({ providerTriggerId: "ti_issue_created" })).resolves.toEqual({
      ok: true,
    });
  });

  it("fails closed before dispatch for malformed trigger coordinates", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const triggers = createComposioTriggerInstances({ apiKey: API_KEY, fetch: fetchMock });

    await expect(triggers.delete({ providerTriggerId: "wrong" })).resolves.toMatchObject({
      error: { code: "trigger_unavailable" },
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trust a successful provider response that reflects the project key", async () => {
    const triggers = createComposioTriggerInstances({
      apiKey: API_KEY,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ detail: API_KEY, trigger_id: "ti_issue_created" }, 201)),
    });

    await expect(
      triggers.upsert({
        configuration: {},
        integrationSlug: "github",
        ownerKey: "owner_23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijk",
        providerConnectionId: "ca_github",
        sourceSlug: "GITHUB_ISSUE_CREATED",
        sourceVersion: "20260802_00",
      }),
    ).resolves.toMatchObject({ error: { code: "trigger_operation_unknown" }, ok: false });
  });
});
