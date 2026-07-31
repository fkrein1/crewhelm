import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
} from "@ai-sdk/provider";

export type InferenceAvailabilityFailure =
  | "provider_unavailable"
  | "rate_limited"
  | "timeout"
  | "transport_unavailable";

export type InferenceAttemptEvent =
  | {
      event: "inference.attempt_failed";
      model: string;
      modelCall: number;
      reason: InferenceAvailabilityFailure;
    }
  | {
      event: "inference.model_selected";
      model: string;
      modelCall: number;
    };

type InferenceAttempt = {
  model: LanguageModelV4;
  modelId: string;
};

type InferenceFallbackOptions = {
  attempts: readonly [InferenceAttempt, ...InferenceAttempt[]];
  beforeAttempt(attemptIndex: number, modelId: string): Promise<number>;
  recordEvent(event: InferenceAttemptEvent): Promise<void>;
};

function availabilityFailure(error: unknown): InferenceAvailabilityFailure | undefined {
  if (!APICallError.isInstance(error) || !error.isRetryable) {
    return undefined;
  }

  if (error.statusCode === 408) {
    return "timeout";
  }

  if (error.statusCode === 429) {
    return "rate_limited";
  }

  if (error.statusCode === undefined) {
    return "transport_unavailable";
  }

  return "provider_unavailable";
}

function replayStream(
  buffered: readonly LanguageModelV4StreamPart[],
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    async start(controller) {
      for (const part of buffered) {
        controller.enqueue(part);
      }

      try {
        while (true) {
          const next = await reader.read();

          if (next.done) {
            controller.close();
            return;
          }

          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function selectedStream(
  result: LanguageModelV4StreamResult,
  reader: ReadableStreamDefaultReader<LanguageModelV4StreamPart>,
  buffered: readonly LanguageModelV4StreamPart[],
): LanguageModelV4StreamResult {
  return {
    ...result,
    stream: replayStream(buffered, reader),
  };
}

export function createInferenceFallbackModel(options: InferenceFallbackOptions): LanguageModelV4 {
  const primary = options.attempts[0];

  return {
    doGenerate: async (callOptions: LanguageModelV4CallOptions) => {
      for (const [attemptIndex, attempt] of options.attempts.entries()) {
        const modelCall = await options.beforeAttempt(attemptIndex, attempt.modelId);

        try {
          const result = await attempt.model.doGenerate(callOptions);
          await options.recordEvent({
            event: "inference.model_selected",
            model: attempt.modelId,
            modelCall,
          });
          return result;
        } catch (error) {
          const reason = availabilityFailure(error);

          if (reason === undefined) {
            throw error;
          }

          await options.recordEvent({
            event: "inference.attempt_failed",
            model: attempt.modelId,
            modelCall,
            reason,
          });

          if (attemptIndex === options.attempts.length - 1) {
            throw error;
          }
        }
      }

      throw new Error("Inference attempt order is empty.");
    },
    doStream: async (callOptions: LanguageModelV4CallOptions) => {
      for (const [attemptIndex, attempt] of options.attempts.entries()) {
        const modelCall = await options.beforeAttempt(attemptIndex, attempt.modelId);
        let result: LanguageModelV4StreamResult;

        try {
          result = await attempt.model.doStream(callOptions);
        } catch (error) {
          const reason = availabilityFailure(error);

          if (reason === undefined) {
            throw error;
          }

          await options.recordEvent({
            event: "inference.attempt_failed",
            model: attempt.modelId,
            modelCall,
            reason,
          });

          if (attemptIndex === options.attempts.length - 1) {
            throw error;
          }
          continue;
        }

        const reader = result.stream.getReader();
        const buffered: LanguageModelV4StreamPart[] = [];

        try {
          while (true) {
            const next = await reader.read();

            if (next.done) {
              await options.recordEvent({
                event: "inference.model_selected",
                model: attempt.modelId,
                modelCall,
              });
              return selectedStream(result, reader, buffered);
            }

            const part = next.value;

            if (part.type === "stream-start" || part.type === "response-metadata") {
              buffered.push(part);
              continue;
            }

            if (part.type === "error") {
              const reason = availabilityFailure(part.error);

              if (reason !== undefined) {
                await options.recordEvent({
                  event: "inference.attempt_failed",
                  model: attempt.modelId,
                  modelCall,
                  reason,
                });

                if (attemptIndex < options.attempts.length - 1) {
                  await reader.cancel();
                  break;
                }

                buffered.push(part);
                return selectedStream(result, reader, buffered);
              }
            }

            buffered.push(part);
            await options.recordEvent({
              event: "inference.model_selected",
              model: attempt.modelId,
              modelCall,
            });
            return selectedStream(result, reader, buffered);
          }
        } catch (error) {
          const reason = availabilityFailure(error);

          if (reason === undefined) {
            throw error;
          }

          await options.recordEvent({
            event: "inference.attempt_failed",
            model: attempt.modelId,
            modelCall,
            reason,
          });

          if (attemptIndex === options.attempts.length - 1) {
            throw error;
          }
        }
      }

      throw new Error("Inference attempt order is empty.");
    },
    modelId: primary.modelId,
    provider: "crewhelm",
    specificationVersion: "v4",
    supportedUrls: primary.model.supportedUrls,
  };
}
