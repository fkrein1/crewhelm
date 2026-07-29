import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_SCOPES,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  ownerScopeClaimSchema,
  type OwnerScope,
} from "@crewhelm/contracts";
import * as z from "zod";

export const VIEW_ACCESS_SCOPE = "crewhelm:view";
export const USE_ACCESS_SCOPE = "crewhelm:use";
export const FULL_ACCESS_SCOPE = "crewhelm:full";
export const ACCESS_LEVEL_SCOPES = [
  VIEW_ACCESS_SCOPE,
  USE_ACCESS_SCOPE,
  FULL_ACCESS_SCOPE,
] as const;

export const accessLevelScopeSchema = z.enum(ACCESS_LEVEL_SCOPES);
export type AccessLevelScope = z.infer<typeof accessLevelScopeSchema>;

const VIEW_CAPABILITIES = [
  OWNER_READ_SCOPE,
  AGENTS_READ_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  INTEGRATIONS_READ_SCOPE,
] as const satisfies readonly OwnerScope[];

const CAPABILITIES_BY_ACCESS_LEVEL = {
  [VIEW_ACCESS_SCOPE]: VIEW_CAPABILITIES,
  [USE_ACCESS_SCOPE]: [...VIEW_CAPABILITIES, RUNS_WRITE_SCOPE],
  [FULL_ACCESS_SCOPE]: [
    OWNER_READ_SCOPE,
    OWNER_WRITE_SCOPE,
    AGENTS_READ_SCOPE,
    AGENTS_WRITE_SCOPE,
    RUNS_WRITE_SCOPE,
    AUTONOMY_WRITE_SCOPE,
    CONNECTIONS_READ_SCOPE,
    CONNECTIONS_WRITE_SCOPE,
    CONNECTION_CONFIGS_READ_SCOPE,
    CONNECTION_CONFIGS_WRITE_SCOPE,
    INTEGRATIONS_READ_SCOPE,
  ],
} as const satisfies Record<AccessLevelScope, readonly OwnerScope[]>;

export function ownerScopeClaimForAccessLevels(levels: readonly AccessLevelScope[]): string | null {
  const capabilities = new Set<OwnerScope>();

  for (const level of levels) {
    for (const capability of CAPABILITIES_BY_ACCESS_LEVEL[level]) {
      capabilities.add(capability);
    }
  }

  const claim = OWNER_SCOPES.filter((scope) => capabilities.has(scope)).join(" ");
  const parsed = ownerScopeClaimSchema.safeParse(claim);
  return parsed.success ? parsed.data : null;
}
