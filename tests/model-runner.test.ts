import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ANALYSIS_MODEL } from "../src/workflows/quality";
import {
  HERMES_DEFAULT_PROFILE,
  HermesRunner,
  ModelResponseDecodeError,
  WorkersAiRunner,
  resolveModelRunner,
  type ModelCompletionRequest
} from "../src/quality/model-runner";

function completionRequest(overrides: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  return {
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "{\"candidate\":\"hello\"}" }
    ],
    tools: [{ type: "function" }],
    toolChoice: { type: "function", function: { name: "candidate_analysis" } },
    maxCompletionTokens: 128,
    temperature: 0,
    functionName: "candidate_analysis",
    idempotencyKey: "candidate-analysis-project-0123456789abcdef",
    ...overrides
  };
}

function workersAiToolResponse(name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              type: "function",
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        }
      }
    ]
  };
}

function fakeAi(response: unknown): Ai {
  return {
    run: vi.fn(async () => response)
  } as unknown as Ai;
}

describe("WorkersAiRunner", () => {
  it("forwards the configured model and completion input, then returns decoded arguments", async () => {
    const args = { persistent_value: false, confidence: 0.2 };
    const ai = fakeAi(workersAiToolResponse("candidate_analysis", args));
    const runner = new WorkersAiRunner(ai, ANALYSIS_MODEL);

    await expect(runner.runCompletion(completionRequest())).resolves.toEqual(args);
    expect(ai.run).toHaveBeenCalledOnce();
    const [model, input] = (ai.run as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(model).toBe(ANALYSIS_MODEL);
    expect(input).toMatchObject({
      tool_choice: { type: "function", function: { name: "candidate_analysis" } },
      parallel_tool_calls: false,
      temperature: 0
    });
  });

  it("maps undecodable tool responses to a decode error for stage diagnostics", async () => {
    const runner = new WorkersAiRunner(fakeAi({ choices: [] }), ANALYSIS_MODEL);

    await expect(runner.runCompletion(completionRequest())).rejects.toBeInstanceOf(
      ModelResponseDecodeError
    );
  });

  it("propagates model failures to the caller deferral logic", async () => {
    const ai = {
      run: vi.fn(async () => {
        throw new Error("Synthetic model failure");
      })
    } as unknown as Ai;
    const runner = new WorkersAiRunner(ai, ANALYSIS_MODEL);

    await expect(runner.runCompletion(completionRequest())).rejects.toThrow(
      "Synthetic model failure"
    );
  });
});

describe("HermesRunner", () => {
  it("sends profile, prompts, and idempotency key, then parses the JSON answer", async () => {
    const transport = vi.fn(async () => ({ text: "{\"persistent_value\":false}" }));
    const runner = new HermesRunner(transport, "meta-muse");

    await expect(runner.runCompletion(completionRequest())).resolves.toEqual({
      persistent_value: false
    });
    expect(transport).toHaveBeenCalledWith({
      profile: "meta-muse",
      idempotencyKey: "candidate-analysis-project-0123456789abcdef",
      system: "system prompt",
      user: "{\"candidate\":\"hello\"}",
      functionName: "candidate_analysis"
    });
  });

  it("propagates transport failures and non-JSON answers", async () => {
    const failing = new HermesRunner(
      vi.fn(async () => {
        throw new Error("Hermes container responded with HTTP 429.");
      }),
      "meta-muse"
    );
    await expect(failing.runCompletion(completionRequest())).rejects.toThrow("HTTP 429");

    const invalid = new HermesRunner(vi.fn(async () => ({ text: "not json" })), "meta-muse");
    await expect(invalid.runCompletion(completionRequest())).rejects.toThrow();
  });
});

describe("resolveModelRunner", () => {
  const ai = () => fakeAi(workersAiToolResponse("candidate_analysis", {}));

  it("defaults to Workers AI when no runner is selected", () => {
    expect(resolveModelRunner({ ai: ai(), model: ANALYSIS_MODEL }).kind).toBe("workers-ai");
    expect(
      resolveModelRunner({ ai: ai(), model: ANALYSIS_MODEL, runnerName: "workers-ai" }).kind
    ).toBe("workers-ai");
  });

  it("selects the configured Hermes profile with a versioned credential", () => {
    const runner = resolveModelRunner({
      ai: ai(),
      model: ANALYSIS_MODEL,
      runnerName: "hermes",
      profile: "meta-muse",
      credentialVersion: "meta-key-v1",
      transport: vi.fn(async () => ({ text: "{}" }))
    });

    expect(runner.kind).toBe("hermes");
  });

  it("uses the default profile when none is configured", async () => {
    const transport = vi.fn(async () => ({ text: "{}" }));
    const runner = resolveModelRunner({
      ai: ai(),
      model: ANALYSIS_MODEL,
      runnerName: "hermes",
      credentialVersion: "meta-key-v1",
      transport
    });

    await runner.runCompletion(completionRequest());
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ profile: HERMES_DEFAULT_PROFILE }));
  });

  it("fails closed on a missing transport instead of silently using Workers AI", () => {
    expect(() =>
      resolveModelRunner({
        ai: ai(),
        model: ANALYSIS_MODEL,
        runnerName: "hermes",
        credentialVersion: "meta-key-v1"
      })
    ).toThrow(/no transport/iu);
  });

  it.each([["unconfigured"], [undefined]])(
    "fails closed on credential version %s instead of silently using Workers AI",
    (credentialVersion) => {
      expect(() =>
        resolveModelRunner({
          ai: ai(),
          model: ANALYSIS_MODEL,
          runnerName: "hermes",
          credentialVersion,
          transport: vi.fn(async () => ({ text: "{}" }))
        })
      ).toThrow(/credential version/iu);
    }
  );
});

describe("Hermes deployment contract", () => {
  it("keeps the orchestrator template free of secrets with disabled Hermes defaults", () => {
    const source = readFileSync("wrangler/memory-orchestrator.jsonc", "utf8");
    const config = JSON.parse(source) as {
      vars: Record<string, string>;
      containers: Array<{ class_name: string; image: string; max_instances: number }>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      exports: Record<string, unknown>;
    };

    expect(config.vars).toEqual({
      MODEL_RUNNER: "workers-ai",
      HERMES_PROFILE: "meta-muse",
      HERMES_CREDENTIAL_VERSION: "unconfigured"
    });
    expect(config.containers).toEqual([
      {
        class_name: "HermesContainer",
        image: "../containers/hermes/Dockerfile",
        max_instances: 2
      }
    ]);
    expect(config.durable_objects.bindings).toContainEqual({
      name: "HERMES",
      class_name: "HermesContainer"
    });
    expect(config.exports).toEqual({
      ProjectCoordinator: {
        type: "durable-object",
        state: "created",
        storage: "sqlite"
      },
      HermesContainer: {
        type: "durable-object",
        state: "created",
        storage: "sqlite"
      }
    });
    expect(config).not.toHaveProperty("migrations");
    expect(source).not.toContain("MODEL_API_KEY");
    expect(source).not.toContain("HERMES_SHARED_SECRET");
  });
});
