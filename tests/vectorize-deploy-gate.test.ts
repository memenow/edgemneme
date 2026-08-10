import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(join(process.cwd(), ".github", "workflows", "deploy.yml"), "utf8");

const requiredIndexes = [
  { propertyName: "model_generation", indexType: "string" },
  { propertyName: "status", indexType: "string" },
  { propertyName: "repository_partition", indexType: "string" },
  { propertyName: "kind", indexType: "string" },
  { propertyName: "memory_class", indexType: "string" },
  { propertyName: "scope_key", indexType: "string" },
  { propertyName: "valid_from_epoch_ms", indexType: "number" },
  { propertyName: "valid_until_epoch_ms", indexType: "number" }
] as const;

function workflowRunScript(source: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow step ${name} was not found.`);
  }
  const next = source.indexOf("\n      - name: ", start + marker.length);
  const step = source.slice(start, next === -1 ? undefined : next);
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  if (runStart === -1) {
    throw new Error(`Workflow step ${name} does not contain a literal run script.`);
  }
  return step
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

interface GateOptions {
  failCommand?: "create" | "list";
  readyOnListCall?: number;
  readyOutput?: string;
}

function runVectorizeMetadataGate(initialOutput: string, options: GateOptions = {}) {
  const script = workflowRunScript(deploy, "Ensure semantic Vectorize metadata indexes");
  const stateDirectory = mkdtempSync(join(tmpdir(), "edgemneme-vectorize-gate-"));
  const harness = `
pnpm() {
  if [[ "\${1-}" != "exec" || "\${2-}" != "wrangler" || "\${3-}" != "vectorize" ]]; then
    echo "unexpected pnpm command" >&2
    return 2
  fi
  case "\${4-}" in
    list-metadata-index)
      if [[ "$#" -ne 6 || "\${5-}" != "edgemneme-memory" || "\${6-}" != "--json" ]]; then
        echo "unexpected Vectorize list command" >&2
        return 2
      fi
      if [[ "\${FAIL_COMMAND-}" == "list" ]]; then
        return 1
      fi
      local list_count=0
      if [[ -f "$STATE_DIRECTORY/list-count" ]]; then
        read -r list_count < "$STATE_DIRECTORY/list-count"
      fi
      list_count=$((list_count + 1))
      printf '%s\n' "$list_count" > "$STATE_DIRECTORY/list-count"
      if (( list_count >= READY_ON_LIST_CALL )); then
        printf '%s' "$READY_OUTPUT"
      else
        printf '%s' "$INITIAL_OUTPUT"
      fi
      ;;
    create-metadata-index)
      if [[ "$#" -ne 7 || "\${5-}" != "edgemneme-memory" || "\${6-}" != --property-name=* || "\${7-}" != --type=* ]]; then
        echo "unexpected Vectorize create command" >&2
        return 2
      fi
      if [[ "\${FAIL_COMMAND-}" == "create" ]]; then
        return 1
      fi
      local property_name="\${6#--property-name=}"
      local index_type="\${7#--type=}"
      if [[ -z "$property_name" || -z "$index_type" ]]; then
        echo "empty Vectorize create argument" >&2
        return 2
      fi
      printf '%s\t%s\n' "$property_name" "$index_type" >> "$STATE_DIRECTORY/create-log"
      ;;
    *)
      echo "unexpected Wrangler operation: \${4-}" >&2
      return 2
      ;;
  esac
}
sleep() {
  :
}
${script}
`;

  const result = spawnSync("bash", ["-c", harness], {
    env: {
      ...process.env,
      FAIL_COMMAND: options.failCommand ?? "",
      INITIAL_OUTPUT: initialOutput,
      READY_ON_LIST_CALL: String(options.readyOnListCall ?? 1),
      READY_OUTPUT: options.readyOutput ?? initialOutput,
      STATE_DIRECTORY: stateDirectory
    },
    encoding: "utf8"
  });
  const createLogPath = join(stateDirectory, "create-log");
  const listCountPath = join(stateDirectory, "list-count");
  const created = existsSync(createLogPath)
    ? readFileSync(createLogPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const listCalls = existsSync(listCountPath)
    ? Number.parseInt(readFileSync(listCountPath, "utf8"), 10)
    : 0;
  rmSync(stateDirectory, { recursive: true });
  return { ...result, created, listCalls };
}

describe("production Vectorize metadata-index ensure gate", () => {
  it("accepts the exact metadata-index contract without mutating it", () => {
    const exactIndexes = requiredIndexes.map((index, position) => ({
      ...index,
      indexType: position % 2 === 0 ? index.indexType.toUpperCase() : index.indexType
    }));
    const result = runVectorizeMetadataGate(JSON.stringify(exactIndexes));

    expect(result.status, result.stderr).toBe(0);
    expect(result.created).toEqual([]);
    expect(result.listCalls).toBe(1);
    expect(result.stdout).toContain("already satisfies the exact required contract");
  });

  it("creates only missing required indexes and polls until the exact set is ready", () => {
    const initialIndexes = [requiredIndexes[0], requiredIndexes[2]];
    const initialPropertyNames = new Set<string>(
      initialIndexes.map((index) => index.propertyName)
    );
    const result = runVectorizeMetadataGate(JSON.stringify(initialIndexes), {
      readyOnListCall: 3,
      readyOutput: JSON.stringify(requiredIndexes)
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.created).toEqual(
      requiredIndexes
        .filter((index) => !initialPropertyNames.has(index.propertyName))
        .map((index) => `${index.propertyName}\t${index.indexType}`)
    );
    expect(result.listCalls).toBe(3);
    expect(result.stdout).toContain("satisfies the exact required contract");
  });

  it.each([
    [
      "a wrong required type",
      requiredIndexes.map((index) =>
        index.propertyName === "status" ? { ...index, indexType: "number" } : index
      ),
      "metadata index status must use type string, found number"
    ],
    [
      "an unexpected property",
      [...requiredIndexes, { propertyName: "project_id", indexType: "string" }],
      "unexpected metadata index project_id"
    ],
    [
      "a duplicate required property",
      [...requiredIndexes, requiredIndexes[1]],
      "duplicate metadata index status"
    ],
    ["a non-array response", { metadataIndexes: requiredIndexes }, "must be a JSON array"],
    [
      "a malformed index entry",
      [...requiredIndexes.slice(0, -1), { propertyName: "valid_until_epoch_ms" }],
      "contains a malformed entry"
    ]
  ])("fails closed for %s before creating indexes", (_case, indexes, expectedError) => {
    const result = runVectorizeMetadataGate(JSON.stringify(indexes));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expect(result.created).toEqual([]);
    expect(result.listCalls).toBe(1);
  });

  it("fails closed when Wrangler returns malformed JSON", () => {
    const result = runVectorizeMetadataGate("not-json");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Vectorize metadata index output is not valid JSON");
    expect(result.created).toEqual([]);
  });

  it("does not evaluate an unexpected property name as shell code", () => {
    const marker = join(tmpdir(), `edgemneme-vectorize-shell-${process.pid}`);
    const maliciousProperty = `$(touch ${marker})`;
    const result = runVectorizeMetadataGate(
      JSON.stringify([...requiredIndexes, { propertyName: maliciousProperty, indexType: "string" }])
    );

    expect(result.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(result.created).toEqual([]);
  });

  it("fails closed when Wrangler cannot list metadata indexes", () => {
    const result = runVectorizeMetadataGate("[]", { failCommand: "list" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Unable to list Vectorize metadata indexes; deployment is blocked."
    );
  });

  it("fails closed when Wrangler cannot create a missing metadata index", () => {
    const result = runVectorizeMetadataGate(JSON.stringify(requiredIndexes.slice(0, -1)), {
      failCommand: "create"
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Unable to create Vectorize metadata index valid_until_epoch_ms; deployment is blocked."
    );
  });

  it("fails closed when missing metadata indexes do not become ready in time", () => {
    const incompleteIndexes = requiredIndexes.slice(0, -1);
    const result = runVectorizeMetadataGate(JSON.stringify(incompleteIndexes), {
      readyOnListCall: 10_000,
      readyOutput: JSON.stringify(requiredIndexes)
    });

    expect(result.status).toBe(1);
    expect(result.created).toEqual(["valid_until_epoch_ms\tnumber"]);
    expect(result.listCalls).toBe(31);
    expect(result.stderr).toContain(
      "Vectorize metadata indexes did not reach the exact required contract after 30 polling attempts"
    );
  });
});
