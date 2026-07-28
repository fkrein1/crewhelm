import type { OwnerAuthority } from "@crewhelm/contracts";

export interface OwnerControlPlaneClient {
  cancelRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  changeAuthority(authorityInput: unknown, input: unknown): Promise<unknown>;
  configureAgentConnection(authorityInput: unknown, input: unknown): Promise<unknown>;
  createAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
  completeConnectionLink(authorityInput: unknown, input: unknown): Promise<unknown>;
  completeIntegrationEnablement(authorityInput: unknown, input: unknown): Promise<unknown>;
  decideRunToolApproval(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgentRevision(authorityInput: unknown, input: unknown): Promise<unknown>;
  inspectRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentRevisions(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgents(authorityInput: unknown, input: unknown): Promise<unknown>;
  listConnections(authorityInput: unknown, input: unknown): Promise<unknown>;
  listRunToolApprovals(authorityInput: unknown, input: unknown): Promise<unknown>;
  lookupAgentConnectionConfiguration(authorityInput: unknown, input: unknown): Promise<unknown>;
  reserveConnectionLink(authorityInput: unknown, input: unknown): Promise<unknown>;
  reserveIntegrationEnablement(authorityInput: unknown, input: unknown): Promise<unknown>;
  reconcileToolExecution(authorityInput: unknown, input: unknown): Promise<unknown>;
  resolveConnectionForAttachment(authorityInput: unknown, input: unknown): Promise<unknown>;
  startRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  status(authorityInput: unknown): Promise<unknown>;
  updateAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
}

export interface McpEnvironment {
  BETTER_AUTH_SECRET: string;
  COMPOSIO_API_KEY?: string | undefined;
  PUBLIC_ORIGIN: string;
  OWNER_CONTROL_PLANE: {
    getByName(ownerKey: string): OwnerControlPlaneClient;
  };
}

export interface McpToolContext {
  authority: OwnerAuthority;
  controlPlane: OwnerControlPlaneClient;
}
