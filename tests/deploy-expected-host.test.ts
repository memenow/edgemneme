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

describe("production canary host pin", () => {
  it("uses only the verified remote gateway trigger for the canary URL and host", () => {
    const validation = workflowStep("Validate deployment inputs");
    const rendering = workflowStep("Render private deployment configs");
    const capture = workflowStep("Capture deployed gateway canary target");
    const canary = workflowStep("Run isolated production canary");

    expect(validation).not.toContain("MEMORY_GATEWAY_PUBLIC_URL");
    expect(validation).not.toContain("MEMORY_GATEWAY_EXPECTED_HOST");
    expect(capture).toContain("gateway-deployment-target.mjs capture-canary-target");
    expect(capture).toContain("EXPECTED_GATEWAY_DEPLOYMENT_TAG");
    expect(canary).toContain(
      "EDGEMNEME_GATEWAY_URL: ${{ steps.gateway_canary_target.outputs.gateway_url }}"
    );
    expect(canary).toContain(
      "EDGEMNEME_GATEWAY_EXPECTED_HOST: ${{ steps.gateway_canary_target.outputs.gateway_host }}"
    );
    expect(canary).toContain(
      "EDGEMNEME_GATEWAY_EXPECTED_VERSION: ${{ steps.gateway_canary_target.outputs.gateway_active_version }}"
    );
    expect(canary).not.toContain("vars.MEMORY_GATEWAY_PUBLIC_URL");
    expect(canary).not.toContain("vars.MEMORY_GATEWAY_EXPECTED_HOST");
    expect(rendering).toContain("MEMORY_GATEWAY_CUSTOM_DOMAIN");
    expect(rendering).not.toContain("MEMORY_GATEWAY_EXPECTED_HOST");
  });

  it("revalidates the exact active version and trigger after canary recovery", () => {
    const revalidate = workflowStep("Revalidate gateway deployment state");
    const reverify = workflowStep("Reverify deployed gateway canary target");

    expect(revalidate).toContain("gateway_trigger_state");
    expect(revalidate).toContain("gateway_trigger_fingerprint");
    expect(revalidate).toContain("gateway-deployment-target.mjs verify-predeploy");
    expect(reverify).toContain("EXPECTED_GATEWAY_ACTIVE_VERSION");
    expect(reverify).toContain("gateway-deployment-target.mjs verify-canary-target");
    expect(reverify).toContain("always() && steps.gateway_canary_target.outcome == 'success'");
  });
});
