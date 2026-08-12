import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";
const SEARCH_CLEANUP_COLUMNS = [
  "memory_fts",
  "memory_projection_heads",
  "memory_fts_chunk_ledger",
  "memory_search_projection_write_leases",
  "memory_search_projection_deletions",
  "memory_search_vector_cleanup_receipts",
  "memory_search_vector_cleanup_janitor_state"
] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic canary cleanup completion", () => {
  it("atomically publishes a scoped mode-0600 receipt and revalidates it without reclaiming", () => {
    const harness = createHarness({ allowCleanupFence: true });

    const initialCleanup = runCleanupOnly(harness);
    expect(initialCleanup.status, initialCleanup.stderr).toBe(0);
    expect(initialCleanup.stdout).toContain(
      "Synthetic D1, Vectorize, and R2 records cleaned."
    );
    expect(existsSync(harness.ledgerPath)).toBe(false);
    expect(JSON.parse(readFileSync(harness.markerPath, "utf8"))).toEqual({
      schema_version: 1,
      project_id: PROJECT_ID,
      principal_id: PRINCIPAL_ID,
      vector_ids: [],
      r2_keys: []
    });
    expect(statSync(harness.markerPath).mode & 0o777).toBe(0o600);

    writeFileSync(harness.commandLogPath, "");
    const repeatedCleanup = runCleanupOnly(harness);
    expect(repeatedCleanup.status, repeatedCleanup.stderr).toBe(0);
    expect(repeatedCleanup.stdout).toContain(
      "Synthetic cleanup completion revalidated."
    );
    const repeatedCommands = readCommands(harness.commandLogPath);
    expect(repeatedCommands).toHaveLength(5);
    expect(repeatedCommands.every((command) => command.includes("--command"))).toBe(
      true
    );
    expect(repeatedCommands.some((command) => command.includes("--file"))).toBe(false);
    expect(
      repeatedCommands.some((command) => command.join(" ").includes("cleanup_claim_id"))
    ).toBe(false);
  });

  it("recovers a verified authority-absent interruption from the retained ledger", () => {
    const harness = createHarness({ allowCleanupFence: false });
    writeFileSync(
      harness.ledgerPath,
      `${JSON.stringify({
        schema_version: 1,
        project_id: PROJECT_ID,
        principal_id: PRINCIPAL_ID,
        vector_ids: [],
        r2_keys: []
      })}\n`,
      { mode: 0o600 }
    );

    const result = runCleanupOnly(harness);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Synthetic D1, Vectorize, and R2 records cleaned."
    );
    expect(existsSync(harness.ledgerPath)).toBe(false);
    expect(JSON.parse(readFileSync(harness.markerPath, "utf8"))).toEqual({
      schema_version: 1,
      project_id: PROJECT_ID,
      principal_id: PRINCIPAL_ID,
      vector_ids: [],
      r2_keys: []
    });
    const commands = readCommands(harness.commandLogPath);
    expect(
      commands.some((command) => command.join(" ").includes("cleanup_claim_id"))
    ).toBe(true);
    expect(commands.some((command) => command.includes("--file"))).toBe(true);
  });

  it("fails closed when exact authority is empty but no completion marker exists", () => {
    const harness = createHarness({ allowCleanupFence: false });

    const result = runCleanupOnly(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Synthetic cleanup failed for reserved project");
    expect(existsSync(harness.markerPath)).toBe(false);
    expect(
      readCommands(harness.commandLogPath).some((command) =>
        command.join(" ").includes("cleanup_claim_id")
      )
    ).toBe(true);
  });

  it("rejects a completion marker for a different synthetic identity before remote cleanup", () => {
    const harness = createHarness({ allowCleanupFence: false });
    writeFileSync(
      harness.markerPath,
      `${JSON.stringify({
        schema_version: 1,
        project_id: "33333333-3333-4333-8333-333333333333",
        principal_id: PRINCIPAL_ID,
        vector_ids: [],
        r2_keys: []
      })}\n`,
      { mode: 0o600 }
    );

    const result = runCleanupOnly(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Synthetic cleanup failed for reserved project");
    expect(existsSync(harness.commandLogPath)).toBe(false);
  });
});

type Harness = {
  directory: string;
  commandLogPath: string;
  ledgerPath: string;
  markerPath: string;
  path: string;
};

function createHarness({ allowCleanupFence }: { allowCleanupFence: boolean }): Harness {
  const directory = mkdtempSync(join(tmpdir(), "edgemneme-canary-completion-"));
  temporaryDirectories.push(directory);
  const commandLogPath = join(directory, "commands.jsonl");
  const ledgerPath = join(directory, "cleanup-ledger.json");
  const markerPath = `${ledgerPath}.complete`;
  const fakePnpmPath = join(directory, "pnpm");
  const cleanupClaimId = `canary-${createHash("sha256")
    .update(`${PROJECT_ID}\n${PRINCIPAL_ID}`)
    .digest("hex")
    .slice(0, 48)}`;
  writeFileSync(
    fakePnpmPath,
    fakePnpmSource({ commandLogPath, cleanupClaimId, allowCleanupFence }),
    { mode: 0o700 }
  );
  chmodSync(fakePnpmPath, 0o700);
  return {
    directory,
    commandLogPath,
    ledgerPath,
    markerPath,
    path: `${directory}:${process.env.PATH ?? ""}`
  };
}

function runCleanupOnly(harness: Harness) {
  return spawnSync(process.execPath, ["scripts/run-synthetic-canary.mjs", "--cleanup-only"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: harness.path,
      EDGEMNEME_CANARY_PROJECT_ID: PROJECT_ID,
      EDGEMNEME_CANARY_PRINCIPAL_ID: PRINCIPAL_ID,
      EDGEMNEME_CANARY_CLEANUP_LEDGER: harness.ledgerPath,
      EDGEMNEME_PROJECTION_BUCKET: "edgemneme-projections",
      EDGEMNEME_VECTOR_INDEX: "edgemneme-memory",
      EDGEMNEME_WRANGLER_CONFIG: "wrangler/test-memory-gateway.jsonc"
    }
  });
}

function readCommands(commandLogPath: string): string[][] {
  return readFileSync(commandLogPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function fakePnpmSource(input: {
  commandLogPath: string;
  cleanupClaimId: string;
  allowCleanupFence: boolean;
}): string {
  const searchCleanupRow = Object.fromEntries(
    SEARCH_CLEANUP_COLUMNS.map((column) => [column, 0])
  );
  return `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(input.commandLogPath)}, JSON.stringify(args) + "\\n");
if (!args.includes("d1") || !args.includes("execute")) {
  process.exit(91);
}
if (args.includes("--file")) {
  process.exit(0);
}
const database = args[args.indexOf("execute") + 1];
const commandIndex = args.indexOf("--command");
const command = commandIndex < 0 ? "" : args[commandIndex + 1];
let rows = [];
if (
  command.includes("SELECT cleanup_claim_id, cleanup_fenced_at") &&
  command.includes("FROM synthetic_cleanup_registry")
) {
  rows = ${input.allowCleanupFence ? `[{ cleanup_claim_id: ${JSON.stringify(input.cleanupClaimId)}, cleanup_fenced_at: "2026-08-12T00:00:00.000Z" }]` : "[]"};
} else if (command.includes("AS pending_outbox")) {
  rows = [{ pending_outbox: 0, pending_workflows: 0 }];
} else if (
  database === "SEARCH_DB" &&
  command.trimStart().startsWith("SELECT") &&
  command.includes("memory_search_vector_cleanup_janitor_state")
) {
  rows = [${JSON.stringify(searchCleanupRow)}];
} else if (database === "MEMORY_DB" && command.includes("AS github_expiry_warnings")) {
  rows = [{ projects: 0, principals: 0 }];
}
process.stdout.write(JSON.stringify([{ success: true, results: rows }]));
`;
}
