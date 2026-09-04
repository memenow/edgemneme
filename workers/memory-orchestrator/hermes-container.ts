import { Container, getContainer } from "@cloudflare/containers";
import {
  HERMES_DEFAULT_PROFILE,
  HERMES_REQUEST_TIMEOUT_MS,
  resolveModelRunner,
  type HermesTransport,
  type ModelRunner
} from "../../src/quality/model-runner";
import { ANALYSIS_MODEL } from "../../src/workflows/quality";

export const HERMES_CONTAINER_DEFAULT_PORT = 8080;
export const HERMES_CONTAINER_IDLE_TIMEOUT = "10m";
export const HERMES_CONTAINER_CLASS_NAME = "HermesContainer";

export class HermesContainer extends Container {
  override defaultPort = HERMES_CONTAINER_DEFAULT_PORT;
  override sleepAfter = HERMES_CONTAINER_IDLE_TIMEOUT;
}

export interface HermesRunnerEnv {
  AI: Ai;
  HERMES?: DurableObjectNamespace<HermesContainer>;
  MODEL_RUNNER?: string;
  HERMES_PROFILE?: string;
  HERMES_CREDENTIAL_VERSION?: string;
  HERMES_SHARED_SECRET?: string;
}

export function createHermesTransport(
  namespace: DurableObjectNamespace<HermesContainer>,
  sharedSecret: string,
  instanceId: string
): HermesTransport {
  return async ({ profile, idempotencyKey, system, user, functionName }) => {
    const stub = getContainer(namespace, instanceId);
    const response = await stub.fetch(
      new Request("http://hermes/v1/complete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${sharedSecret}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({ profile, system, user, functionName }),
        signal: AbortSignal.timeout(HERMES_REQUEST_TIMEOUT_MS)
      })
    );
    if (!response.ok) {
      throw new Error(
        `Hermes container responded with HTTP ${response.status}.`
      );
    }
    const payload = (await response.json()) as { text?: unknown };
    if (typeof payload.text !== "string" || payload.text.length === 0) {
      throw new Error("Hermes container returned an unsupported response.");
    }
    return { text: payload.text };
  };
}

export function hermesTransportFor(env: HermesRunnerEnv): HermesTransport | undefined {
  if (env.HERMES === undefined) {
    return undefined;
  }
  if (env.HERMES_SHARED_SECRET === undefined || env.HERMES_SHARED_SECRET === "") {
    return undefined;
  }
  const profile = env.HERMES_PROFILE ?? HERMES_DEFAULT_PROFILE;
  return createHermesTransport(env.HERMES, env.HERMES_SHARED_SECRET, `hermes-${profile}`);
}

export function resolveOrchestratorModelRunner(env: HermesRunnerEnv): ModelRunner {
  return resolveModelRunner({
    ai: env.AI,
    model: ANALYSIS_MODEL,
    runnerName: env.MODEL_RUNNER,
    profile: env.HERMES_PROFILE,
    credentialVersion: env.HERMES_CREDENTIAL_VERSION,
    transport: hermesTransportFor(env)
  });
}
