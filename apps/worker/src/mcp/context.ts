import type { OwnerAuthority } from "@crewhelm/contracts";

export interface OwnerControlPlaneClient {
  activateVerifiedConnection?(authorityInput: unknown, input: unknown): Promise<unknown>;
  agentInbox(authorityInput: unknown, input: unknown): Promise<unknown>;
  agentEventTriggers?(authorityInput: unknown, input: unknown): Promise<unknown>;
  batchDisableAgents(authorityInput: unknown, input: unknown): Promise<unknown>;
  cancelRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  cancelAgentWorkflow?(authorityInput: unknown, input: unknown): Promise<unknown>;
  changeAuthority(authorityInput: unknown, input: unknown): Promise<unknown>;
  configureAgentConnection(authorityInput: unknown, input: unknown): Promise<unknown>;
  configureAgentRemoteMcpConnection?(authorityInput: unknown, input: unknown): Promise<unknown>;
  configureAgentSchedule(authorityInput: unknown, input: unknown): Promise<unknown>;
  createAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
  createRemoteMcpConnection?(authorityInput: unknown, input: unknown): Promise<unknown>;
  beginRemoteMcpOAuth?(authorityInput: unknown, input: unknown): Promise<unknown>;
  completeRemoteMcpOAuth?(authorityInput: unknown, input: unknown): Promise<unknown>;
  completeConnectionLink(authorityInput: unknown, input: unknown): Promise<unknown>;
  completeIntegrationEnablement(authorityInput: unknown, input: unknown): Promise<unknown>;
  configureFleetConfiguration(authorityInput: unknown, input: unknown): Promise<unknown>;
  createBrief(authorityInput: unknown, input: unknown): Promise<unknown>;
  decideRunToolApproval(authorityInput: unknown, input: unknown): Promise<unknown>;
  deleteAgentSession?(authorityInput: unknown, input: unknown): Promise<unknown>;
  deleteAgentWorkflow?(authorityInput: unknown, input: unknown): Promise<unknown>;
  deleteBrief(authorityInput: unknown, input: unknown): Promise<unknown>;
  deleteRemoteMcpConnection?(authorityInput: unknown, input: unknown): Promise<unknown>;
  failRemoteMcpOAuth?(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgentBlueprint(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgentRevision(authorityInput: unknown, input: unknown): Promise<unknown>;
  getAgentSchedule(authorityInput: unknown, input: unknown): Promise<unknown>;
  getFleetConfiguration(authorityInput: unknown, input: unknown): Promise<unknown>;
  getSkill(authorityInput: unknown, input: unknown): Promise<unknown>;
  executeRemoteMcpTool?(input: unknown): Promise<unknown>;
  inspectRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  inspectAgentWorkflow?(authorityInput: unknown, input: unknown): Promise<unknown>;
  inspectAgentSession?(authorityInput: unknown, input: unknown): Promise<unknown>;
  inspectBrief(authorityInput: unknown, input: unknown): Promise<unknown>;
  inspectRemoteMcpConnection?(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentRevisions(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentBlueprints(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentRuns(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentSchedules(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentWorkflows?(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgentSessions?(authorityInput: unknown, input: unknown): Promise<unknown>;
  listAgents(authorityInput: unknown, input: unknown): Promise<unknown>;
  listBriefs(authorityInput: unknown, input: unknown): Promise<unknown>;
  listConnections(authorityInput: unknown, input: unknown): Promise<unknown>;
  listSkills(authorityInput: unknown, input: unknown): Promise<unknown>;
  listUnresolvedToolEffects(authorityInput: unknown, input: unknown): Promise<unknown>;
  listRunToolApprovals(authorityInput: unknown, input: unknown): Promise<unknown>;
  lookupAgentConnectionConfiguration(authorityInput: unknown, input: unknown): Promise<unknown>;
  lookupRemoteMcpConnectionCreation?(authorityInput: unknown, input: unknown): Promise<unknown>;
  reserveConnectionLink(authorityInput: unknown, input: unknown): Promise<unknown>;
  reserveRemoteMcpOAuthSetup?(authorityInput: unknown, input: unknown): Promise<unknown>;
  recipes?(authorityInput: unknown, input: unknown): Promise<unknown>;
  recipePublications?(authorityInput: unknown, input: unknown): Promise<unknown>;
  reserveIntegrationEnablement(authorityInput: unknown, input: unknown): Promise<unknown>;
  reconcileToolExecution(authorityInput: unknown, input: unknown): Promise<unknown>;
  readBrief(authorityInput: unknown, input: unknown): Promise<unknown>;
  publishSkill(authorityInput: unknown, input: unknown): Promise<unknown>;
  publishAgentBlueprint(authorityInput: unknown, input: unknown): Promise<unknown>;
  instantiateAgentBlueprint(authorityInput: unknown, input: unknown): Promise<unknown>;
  retireAgentBlueprint(authorityInput: unknown, input: unknown): Promise<unknown>;
  retireSkill(authorityInput: unknown, input: unknown): Promise<unknown>;
  reviseBrief(authorityInput: unknown, input: unknown): Promise<unknown>;
  resolveConnectionForAttachment(authorityInput: unknown, input: unknown): Promise<unknown>;
  startRun(authorityInput: unknown, input: unknown): Promise<unknown>;
  startAgentWorkflow?(authorityInput: unknown, input: unknown): Promise<unknown>;
  status(authorityInput: unknown, input?: unknown): Promise<unknown>;
  updateAgent(authorityInput: unknown, input: unknown): Promise<unknown>;
}

export interface McpEnvironment {
  AI_GATEWAY_ID?: string | undefined;
  BETTER_AUTH_SECRET: string;
  BRAVE_SEARCH_API_KEY?: string | undefined;
  CODE_SANDBOX?: unknown;
  COMPOSIO_API_KEY?: string | undefined;
  PUBLIC_ORIGIN: string;
  OWNER_CONTROL_PLANE: {
    getByName(ownerKey: string): OwnerControlPlaneClient;
  };
}

export interface McpToolContext {
  authority: OwnerAuthority;
  availableAgentCapabilityPrerequisites: ReadonlySet<string>;
  controlPlane: OwnerControlPlaneClient;
}
