import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(process.cwd(), ".github/workflows/deploy.yml"), "utf8");

function workflowStep(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = deploy.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} was not found.`);
  }
  const next = deploy.indexOf("\n      - name: ", start + marker.length);
  return deploy.slice(start, next === -1 ? undefined : next);
}

function workflowRunScript(name: string): string {
  const step = workflowStep(name);
  const marker = "        run: |\n";
  const start = step.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} does not contain a literal run script.`);
  }
  return step
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

const validEnvironment = {
  ...process.env,
  CF_D1_MEMORY_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
  CF_D1_SEARCH_DATABASE_ID: "987e6543-e21b-43d3-b654-426614174111",
  CF_RATE_LIMIT_NAMESPACE_EDGE: "21001",
  CF_RATE_LIMIT_NAMESPACE_CLIENT: "21002",
  CF_RATE_LIMIT_NAMESPACE_PRINCIPAL: "21003",
  EDGEMNEME_GATEWAY_URL: "https://edgemneme-gateway.example.workers.dev/mcp",
  EDGEMNEME_GATEWAY_EXPECTED_HOST: "edgemneme-gateway.example.workers.dev",
  ENABLE_GITHUB_SYNC: "false",
  GITHUB_CREDENTIAL_VERSION: ""
};

describe("production canary host pin", () => {
  it("uses a dedicated required variable without exposing it to route rendering", () => {
    const validation = workflowStep("Validate deployment inputs");
    const rendering = workflowStep("Render private deployment configs");
    const canary = workflowStep("Run isolated production canary");

    expect(validation).toContain(
      "EDGEMNEME_GATEWAY_EXPECTED_HOST: ${{ vars.MEMORY_GATEWAY_EXPECTED_HOST }}"
    );
    expect(validation).toContain("EDGEMNEME_GATEWAY_EXPECTED_HOST\n");
    expect(validation).toContain('requireGatewayUrl("EDGEMNEME_GATEWAY_URL")');
    expect(validation).not.toContain("vars.MEMORY_GATEWAY_CUSTOM_DOMAIN");
    expect(canary).toContain(
      "EDGEMNEME_GATEWAY_EXPECTED_HOST: ${{ vars.MEMORY_GATEWAY_EXPECTED_HOST }}"
    );
    expect(canary).not.toContain("vars.MEMORY_GATEWAY_CUSTOM_DOMAIN");
    expect(rendering).toContain("MEMORY_GATEWAY_CUSTOM_DOMAIN");
    expect(rendering).not.toContain("MEMORY_GATEWAY_EXPECTED_HOST");
  });

  it("accepts workers.dev only when the public URL matches the exact host pin", () => {
    const script = workflowRunScript("Validate deployment inputs");
    const run = (environment: NodeJS.ProcessEnv) =>
      spawnSync("bash", ["-c", script], { env: environment, encoding: "utf8" });

    const accepted = run(validEnvironment);
    expect(accepted.status, accepted.stderr).toBe(0);

    const missing = run({ ...validEnvironment, EDGEMNEME_GATEWAY_EXPECTED_HOST: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("EDGEMNEME_GATEWAY_EXPECTED_HOST");

    const mismatched = run({
      ...validEnvironment,
      EDGEMNEME_GATEWAY_EXPECTED_HOST: "other-gateway.example.workers.dev"
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("expected HTTPS /mcp endpoint");
  });
});
