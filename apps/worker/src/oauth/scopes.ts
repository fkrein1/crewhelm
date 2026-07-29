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
  ownerScopeSchema,
  type OwnerScope,
} from "@crewhelm/contracts";
import * as z from "zod";

import {
  ACCESS_LEVEL_SCOPES,
  FULL_ACCESS_SCOPE,
  accessLevelScopeSchema,
  ownerScopeClaimForAccessLevels,
} from "./access-levels.js";

export const OFFLINE_ACCESS_SCOPE = "offline_access";
export const OAUTH_SCOPES = [...ACCESS_LEVEL_SCOPES, OFFLINE_ACCESS_SCOPE] as const;
export const LEGACY_OAUTH_SCOPES = [
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
] as const;
export const OAUTH_ACCEPTED_SCOPES = [
  ...LEGACY_OAUTH_SCOPES,
  ...ACCESS_LEVEL_SCOPES,
  OFFLINE_ACCESS_SCOPE,
] as const;
export const OAUTH_DEFAULT_SCOPES = [FULL_ACCESS_SCOPE, OFFLINE_ACCESS_SCOPE] as const;
export const OAUTH_DEFAULT_SCOPE_CLAIM = OAUTH_DEFAULT_SCOPES.join(" ");
const OAUTH_MAXIMUM_SCOPE_CLAIM = OAUTH_ACCEPTED_SCOPES.join(" ");

export const oauthScopesSchema = z
  .array(z.enum(OAUTH_SCOPES))
  .min(1)
  .max(OAUTH_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Duplicate OAuth scope.")
  .refine(
    (scopes) => scopes.some((scope) => scope !== OFFLINE_ACCESS_SCOPE),
    "An OAuth grant must include an access level.",
  );

export const acceptedOAuthScopesSchema = z
  .array(z.enum(OAUTH_ACCEPTED_SCOPES))
  .min(1)
  .max(OAUTH_ACCEPTED_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Duplicate OAuth scope.")
  .refine(
    (scopes) => scopes.some((scope) => scope !== OFFLINE_ACCESS_SCOPE),
    "An OAuth grant must include Crewhelm authority.",
  );

export const oauthScopeClaimSchema = z
  .string()
  .min(1)
  .max(OAUTH_MAXIMUM_SCOPE_CLAIM.length)
  .transform((claim, context) => {
    const parsedScopes = acceptedOAuthScopesSchema.safeParse(claim.split(" "));

    if (!parsedScopes.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid OAuth scope claim.",
      });
      return z.NEVER;
    }

    return OAUTH_ACCEPTED_SCOPES.filter((scope) => parsedScopes.data.includes(scope)).join(" ");
  });

export function ownerScopeClaimFromOAuthClaim(claim: string): string | null {
  const parsed = oauthScopeClaimSchema.safeParse(claim);

  if (!parsed.success) {
    return null;
  }

  const requestedScopes = parsed.data.split(" ");
  const levels = requestedScopes
    .filter((scope) => scope !== OFFLINE_ACCESS_SCOPE)
    .flatMap((scope) => {
      const level = accessLevelScopeSchema.safeParse(scope);
      return level.success ? [level.data] : [];
    });
  const capabilities = new Set<OwnerScope>();
  const accessLevelClaim = ownerScopeClaimForAccessLevels(levels);

  if (accessLevelClaim !== null) {
    for (const scope of accessLevelClaim.split(" ")) {
      capabilities.add(ownerScopeSchema.parse(scope));
    }
  }

  for (const scope of LEGACY_OAUTH_SCOPES) {
    if (requestedScopes.includes(scope)) {
      capabilities.add(scope);
    }
  }

  // Before access levels, agents:write also authorized run actions.
  if (capabilities.has(AGENTS_WRITE_SCOPE)) {
    capabilities.add(RUNS_WRITE_SCOPE);
  }

  const ownerClaim = OWNER_SCOPES.filter((scope) => capabilities.has(scope)).join(" ");
  const ownerScopes = ownerScopeClaimSchema.safeParse(ownerClaim);
  return ownerScopes.success ? ownerScopes.data : null;
}

export type OAuthOwnerScope = OwnerScope;
