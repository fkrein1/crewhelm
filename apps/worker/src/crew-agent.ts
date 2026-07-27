import {
  crewAgentObjectName,
  crewAgentRuntimeConfigSchema,
  type CrewAgentRuntimeConfig,
} from "@crewhelm/contracts";
import {
  Think,
  type ActionAuthorizationDecision,
  type ChatOptions,
  type RunTurnOptions,
  type RunTurnStream,
  type RunTurnSubmit,
  type RunTurnWait,
  type SaveMessagesOptions,
  type SaveMessagesResult,
  type StreamCallback,
  type SubmitMessagesOptions,
  type SubmitMessagesResult,
  type TurnConfig,
  type TurnResult,
  type TurnContext,
} from "@cloudflare/think";

const RUNTIME_ADMISSION_UNAVAILABLE = "CrewAgent runtime admission is not available.";

function runtimeAdmissionError(): Error {
  return new Error(RUNTIME_ADMISSION_UNAVAILABLE);
}

export class CrewAgent extends Think {
  override fetchTools: false = false;
  override includeMcpTools = false;
  override sendReasoning = false;
  override storeMessages = false;
  override storeTools = false;
  override waitForMcpConnections = false;
  override workspaceBash = false;

  override configure(_configuration: unknown): void {
    throw runtimeAdmissionError();
  }

  override fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response("Not found.", { status: 404 }));
  }

  override chat(
    _userMessage: unknown,
    _callback: StreamCallback,
    _options?: ChatOptions,
  ): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override chatWithMessengerContext(
    _userMessage: unknown,
    _callback: StreamCallback,
    _context: unknown,
    _options?: ChatOptions,
  ): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override runTurn(_options: RunTurnWait): Promise<TurnResult>;
  override runTurn(_options: RunTurnSubmit): Promise<SubmitMessagesResult>;
  override runTurn(_options: RunTurnStream): Promise<void>;
  override runTurn(_options: RunTurnOptions): Promise<TurnResult | SubmitMessagesResult | void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override saveMessages(
    _messages: unknown,
    _options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult> {
    return Promise.reject(runtimeAdmissionError());
  }

  override submitMessages(
    _messages: unknown,
    _options?: SubmitMessagesOptions,
  ): Promise<SubmitMessagesResult> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getModel(): string {
    return this.#runtimeConfig().model;
  }

  override getSystemPrompt(): string {
    return this.#runtimeConfig().instructions;
  }

  override beforeTurn(_context?: TurnContext): TurnConfig {
    const configuration = this.#runtimeConfig();

    return {
      activeTools: [],
      chatStreamStallTimeoutMs: configuration.executionLimits.maxDurationSeconds * 1_000,
      maxOutputTokens: configuration.executionLimits.maxModelTokens,
      maxSteps: configuration.executionLimits.maxTurns,
      sendReasoning: false,
    };
  }

  override authorizeTurn(_context?: TurnContext): ActionAuthorizationDecision {
    return false;
  }

  override authorizeAction(): ActionAuthorizationDecision {
    return false;
  }

  #runtimeConfig(): CrewAgentRuntimeConfig {
    const result = crewAgentRuntimeConfigSchema.safeParse(this.getConfig());

    if (!result.success) {
      throw new Error("CrewAgent runtime configuration is missing or invalid.");
    }

    if (this.ctx.id.name !== crewAgentObjectName(result.data)) {
      throw new Error("CrewAgent runtime configuration does not match this object.");
    }

    return result.data;
  }
}
