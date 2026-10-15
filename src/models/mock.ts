import {
  ModelRequestSchema, ModelResponseSchema, NormalizedProviderError, type ModelAdapter, type ModelRequest, type ModelResponse,
} from "./contracts.ts";

export type MockOutcome = Omit<ModelResponse, "provider" | "requested_model" | "generation_settings"> | Error;

export class MockModelAdapter implements ModelAdapter {
  readonly provider = "mock";
  readonly requests: ModelRequest[] = [];
  readonly modelId: string;
  private readonly outcomes: MockOutcome[];

  constructor(modelId: string, outcomes: MockOutcome[]) {
    this.modelId = modelId;
    this.outcomes = outcomes;
  }

  async generate(input: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    if (options?.signal?.aborted) throw options.signal.reason ?? new Error("Model request aborted");
    const request = ModelRequestSchema.parse(input);
    this.requests.push(structuredClone(request));
    const outcome = this.outcomes.shift();
    if (!outcome) throw new NormalizedProviderError(this.provider, "invalid_response", false, "Mock provider has no queued outcome");
    if (outcome instanceof Error) throw outcome;
    return ModelResponseSchema.parse({
      ...outcome,
      provider: this.provider,
      requested_model: this.modelId,
      generation_settings: request.settings,
    });
  }
}
