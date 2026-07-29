import { AGENTS_WRITE_SCOPE, OWNER_WRITE_SCOPE, RUN_BUDGET_WINDOW_MS } from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";

import { digestRunPrompt } from "../../agent/admitted-runs/index.js";
import { controlPlaneSchema } from "../schema.js";
import { agentInput, authorityFor } from "../testkit.js";
import { AiGatewayUsage, currentFleetAiSpendMicrousd } from "./module.js";

describe("OwnerControlPlane AI Gateway usage", () => {
  it("settles exact Gateway logs idempotently and replaces expired run reservations", async () => {
    const authority = await authorityFor("ai-usage-owner-1", [
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("ai-usage-agent-1"));
    const prompt = "Record one exact AI Gateway call.";

    if (!created.ok) {
      throw new Error("Expected AI usage Agent fixture.");
    }

    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "ai-usage-run-1",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected AI usage run admission.");
    }
    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });

    const { expiresAt: _expiresAt, nonce: _nonce, ...reference } = admission.permit;
    const getLog = vi.fn<(logId: string) => Promise<AiGatewayLog>>(async () => {
      return {
        cached: false,
        cost: 0.012_345,
        created_at: new Date(),
        duration: 10,
        id: "gateway-log-1",
        metadata: {
          crewhelm_agent: admission.permit.agentId,
          crewhelm_run: admission.permit.runId,
        },
        model: created.agent.model,
        path: "/",
        provider: "workers-ai",
        request_content_type: "application/json",
        request_head: "{}",
        request_head_complete: true,
        request_size: 2,
        response_content_type: "application/json",
        response_head: "{}",
        response_head_complete: true,
        response_size: 2,
        status_code: 200,
        step: 1,
        success: true,
        tokens_in: 123,
        tokens_out: 45,
      };
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const database = drizzle(state.storage, {
        logger: false,
        schema: controlPlaneSchema,
      });
      const usage = new AiGatewayUsage(
        database,
        state.storage,
        {
          gateway: () => ({ getLog }),
        },
        "crewhelm",
      );

      await usage.record({ gatewayLogId: "gateway-log-1", reference });
      await usage.record({ gatewayLogId: "gateway-log-1", reference });

      expect(getLog).toHaveBeenCalledTimes(1);
      expect(
        state.storage.sql
          .exec(
            `SELECT
               gateway_log_id,
               status,
               reservation_microusd,
               cost_microusd,
               input_tokens,
               output_tokens
             FROM ai_gateway_calls`,
          )
          .one(),
      ).toEqual({
        cost_microusd: 12_345,
        gateway_log_id: "gateway-log-1",
        input_tokens: 123,
        output_tokens: 45,
        reservation_microusd: admission.permit.budgetReservation.aiSpendReservationMicrousd,
        status: "settled",
      });
      expect(currentFleetAiSpendMicrousd(database, Date.now())).toBe(
        admission.permit.budgetReservation.aiSpendReservationMicrousd,
      );

      state.storage.sql.exec(
        "UPDATE run_admissions SET created_at = ? WHERE run_id = ?",
        Date.now() - admission.permit.budgetReservation.maxDurationSeconds * 1_000 - 1,
        admission.permit.runId,
      );
      expect(currentFleetAiSpendMicrousd(database, Date.now())).toBe(12_345);

      const boundaryTime = Date.now();
      state.storage.sql.exec(
        `UPDATE ai_gateway_calls
         SET status = 'pending',
             cost_microusd = NULL,
             settled_at = NULL,
             recorded_at = ?,
             next_reconciliation_at = ?
         WHERE gateway_log_id = ?`,
        boundaryTime,
        boundaryTime + 1_000,
        "gateway-log-1",
      );
      state.storage.sql.exec(
        "UPDATE run_admissions SET created_at = ? WHERE run_id = ?",
        boundaryTime - RUN_BUDGET_WINDOW_MS - 1,
        admission.permit.runId,
      );
      expect(currentFleetAiSpendMicrousd(database, boundaryTime)).toBe(
        admission.permit.budgetReservation.aiSpendReservationMicrousd,
      );
    });
  });
});
