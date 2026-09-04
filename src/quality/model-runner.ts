import { readModelFunctionArguments, readModelJson } from "./model-analysis";

export const MODEL_RUNNER_WORKERS_AI = "workers-ai";
export const MODEL_RUNNER_HERMES = "hermes";
export const HERMES_DEFAULT_PROFILE = "meta-muse";
export const HERMES_UNCONFIGURED_CREDENTIAL_VERSION = "unconfigured";
export const HERMES_REQUEST_TIMEOUT_MS = 120_000;

export type ModelCompletionMessages = readonly [
  { readonly role: "system"; readonly content: string },
  { readonly role: "user"; readonly content: string }
];

export interface ModelCompletionRequest {
  messages: ModelCompletionMessages;
  tools: readonly unknown[];
  toolChoice: unknown;
  maxCompletionTokens: number;
  temperature: number;
  functionName: string;
  idempotencyKey: string;
}

export interface ModelRunner {
  readonly kind: typeof MODEL_RUNNER_WORKERS_AI | typeof MODEL_RUNNER_HERMES;
  runCompletion(request: ModelCompletionRequest): Promise<unknown>;
}

export class ModelResponseDecodeError extends Error {
  constructor(
    message = "The model returned a response that could not be decoded.",
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "ModelResponseDecodeError";
  }
}

interface WorkersAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export class WorkersAiRunner implements ModelRunner {
  readonly kind = MODEL_RUNNER_WORKERS_AI;

  constructor(
    private readonly ai: Ai,
    private readonly model: string
  ) {}

  async runCompletion(request: ModelCompletionRequest): Promise<unknown> {
    const binding = this.ai as unknown as WorkersAiBinding;
    const response = await binding.run(this.model, {
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.toolChoice,
      parallel_tool_calls: false,
      max_completion_tokens: request.maxCompletionTokens,
      temperature: request.temperature
    });
    try {
      return readModelFunctionArguments(response, request.functionName);
    } catch (error) {
      throw new ModelResponseDecodeError(undefined, { cause: error });
    }
  }
}

export interface HermesTransportRequest {
  profile: string;
  idempotencyKey: string;
  system: string;
  user: string;
  functionName: string;
}

export interface HermesTransportResponse {
  text: string;
}

export type HermesTransport = (
  request: HermesTransportRequest
) => Promise<HermesTransportResponse>;

export interface ModelRunnerEnv {
  ai: Ai;
  model: string;
  runnerName?: string | undefined;
  profile?: string | undefined;
  credentialVersion?: string | undefined;
  transport?: HermesTransport | undefined;
}

export function resolveModelRunner(env: ModelRunnerEnv): ModelRunner {
  if ((env.runnerName ?? MODEL_RUNNER_WORKERS_AI) !== MODEL_RUNNER_HERMES) {
    return new WorkersAiRunner(env.ai, env.model);
  }
  if (env.transport === undefined) {
    throw new Error("Hermes model runner selected but no transport is configured.");
  }
  if (
    env.credentialVersion === undefined ||
    env.credentialVersion === HERMES_UNCONFIGURED_CREDENTIAL_VERSION
  ) {
    throw new Error("Hermes model runner selected but the credential version is unconfigured.");
  }
  return new HermesRunner(env.transport, env.profile ?? HERMES_DEFAULT_PROFILE);
}

// Non-default path: the Hermes container speaks plain text, so unlike the
// Workers AI path there is no forced tool_choice, temperature, or token
// budget — schema discipline comes from the downstream zod parsers and the
// verbatim-evidence checks, with failures mapping to the existing deferred
// diagnostic codes. Do not assume output parity with Workers AI; the shadow
// comparison in Phase 1.5 measures the schema-valid rate before any cutover.
export class HermesRunner implements ModelRunner {
  readonly kind = MODEL_RUNNER_HERMES;

  constructor(
    private readonly transport: HermesTransport,
    private readonly profile: string
  ) {}

  async runCompletion(request: ModelCompletionRequest): Promise<unknown> {
    const system = request.messages[0]?.content ?? "";
    const user = request.messages[1]?.content ?? "";
    const response = await this.transport({
      profile: this.profile,
      idempotencyKey: request.idempotencyKey,
      system,
      user,
      functionName: request.functionName
    });
    try {
      return readModelJson(response.text);
    } catch (error) {
      throw new ModelResponseDecodeError(undefined, { cause: error });
    }
  }
}
