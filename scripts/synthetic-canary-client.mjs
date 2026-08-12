import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  SYNTHETIC_AI_PROBE_CONTENT,
  SYNTHETIC_FORMAL_MEMORY_CONTENT
} from "./synthetic-canary-support.mjs";
import {
  createPinnedGatewayFetch,
  requireGatewayUrl
} from "./canary-process.mjs";

const gatewayExpectedHost = requiredEnvironment(
  "EDGEMNEME_GATEWAY_EXPECTED_HOST"
);
const gatewayExpectedVersion = requiredEnvironment(
  "EDGEMNEME_GATEWAY_EXPECTED_VERSION"
);
const gatewayUrl = requireGatewayUrl(
  "EDGEMNEME_GATEWAY_URL",
  gatewayExpectedHost
);
const token = requiredEnvironment("EDGEMNEME_CANARY_TOKEN");
const projectRef = requiredEnvironment("EDGEMNEME_CANARY_PROJECT_REF");
const projectId = requiredEnvironment("EDGEMNEME_CANARY_PROJECT_ID");
const repositoryId = requiredEnvironment("EDGEMNEME_CANARY_REPOSITORY_ID");
const promotionCandidateId = requiredEnvironment(
  "EDGEMNEME_CANARY_PROMOTION_CANDIDATE_ID"
);
const resultFile = requiredEnvironment("EDGEMNEME_CANARY_RESULT_FILE");
const formalEvidenceLocator = `${projectRef}/formal-promotion`;
const formalEvidenceId = createHash("sha256")
  .update(`${projectId}\nsynthetic_canary\n${formalEvidenceLocator}`)
  .digest("hex");
const workflowTimeoutMs = Number.parseInt(
  process.env.EDGEMNEME_CANARY_WORKFLOW_TIMEOUT_MS ?? "420000",
  10
);
if (!Number.isSafeInteger(workflowTimeoutMs) || workflowTimeoutMs < 10_000) {
  throw new Error("EDGEMNEME_CANARY_WORKFLOW_TIMEOUT_MS must be at least 10000.");
}

const client = new Client(
  { name: "EdgeMneme synthetic canary", version: "2026-07-25" },
  { capabilities: {} }
);
const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
  fetch: createPinnedGatewayFetch(
    gatewayUrl,
    gatewayExpectedHost,
    gatewayExpectedVersion
  ),
  requestInit: { headers: { authorization: `Bearer ${token}` } }
});

try {
  await client.connect(transport);
  const availableTools = await client.listTools();
  const requiredTools = [
    "project_resolve",
    "session_open",
    "memory_search",
    "candidate_submit",
    "memory_change_submit",
    "candidate_review",
    "session_close",
    "workflow_get"
  ];
  for (const name of requiredTools) {
    if (!availableTools.tools.some((tool) => tool.name === name)) {
      throw new Error(`Required tool ${name} is unavailable.`);
    }
  }

  decodeToolResult(
    await client.callTool({
      name: "project_resolve",
      arguments: { locator: projectRef }
    })
  );
  const opened = decodeToolResult(
    await client.callTool({
      name: "session_open",
      arguments: {
        project_ref: projectRef,
        agent_meta: { agent: "synthetic-canary", purpose: "production-readiness" },
        worktree_meta: {
          repository_id: repositoryId,
          repository_ref: "refs/heads/main"
        }
      }
    })
  );
  const searched = decodeToolResult(
    await client.callTool({
      name: "memory_search",
      arguments: {
        project_ref: projectRef,
        session_id: opened.session_id,
        filters: {},
        limit: 5
      }
    })
  );
  if (!Array.isArray(searched.memories) || searched.memories.length !== 0) {
    throw new Error("Synthetic project search was not isolated.");
  }

  const submitted = decodeToolResult(
    await client.callTool({
      name: "candidate_submit",
      arguments: {
        project_ref: projectRef,
        session_id: opened.session_id,
        content: SYNTHETIC_AI_PROBE_CONTENT,
        evidence: [
          {
            source_type: "synthetic_canary",
            locator: `synthetic://${projectRef}/architecture`
          }
        ],
        idempotency_key: `synthetic-submit-${randomUUID()}`
      }
    })
  );
  if (
    submitted.status !== "queued" ||
    typeof submitted.workflow_id !== "string" ||
    typeof submitted.candidate_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      submitted.candidate_id
    )
  ) {
    throw new Error("Synthetic candidate was not queued.");
  }
  writeFileSync(
    resultFile,
    `${JSON.stringify({
      candidate_id: submitted.candidate_id,
      workflow_id: submitted.workflow_id
    })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );

  const workflow = await waitForWorkflow(client, projectRef, submitted.workflow_id);
  if (workflow.status !== "complete") {
    throw new Error(`Synthetic workflow ended with ${String(workflow.status)}.`);
  }
  const promoted = decodeToolResult(
    await client.callTool({
      name: "candidate_review",
      arguments: {
        candidate_id: promotionCandidateId,
        expected_candidate_version: 1,
        decision: "approve",
        reason: "Synthetic canary approval for an isolated production-readiness check.",
        idempotency_key: `synthetic-review-${randomUUID()}`
      }
    })
  );
  if (
    promoted.status !== "promoted" ||
    promoted.memory_version !== 1 ||
    promoted.project_version !== 1 ||
    typeof promoted.memory_id !== "string" ||
    typeof promoted.revision_id !== "string"
  ) {
    throw new Error("Synthetic candidate was not promoted into a formal first revision.");
  }

  const projection = await waitForWorkflow(
    client,
    projectRef,
    `${projectId}:${promoted.project_version}`
  );
  if (projection.status !== "complete") {
    throw new Error(`Synthetic projection workflow ended with ${String(projection.status)}.`);
  }

  await waitForHybridSearch(
    client,
    projectRef,
    opened.session_id,
    promoted.memory_id,
    promoted.revision_id
  );

  const manifest = await readJsonResource(
    client,
    `memory://projects/${projectRef}/manifest`
  );
  if (
    manifest.project_id !== projectId ||
    manifest.project_version !== promoted.project_version ||
    !Array.isArray(manifest.memories) ||
    !manifest.memories.some(
      (memory) =>
        memory.memory_id === promoted.memory_id && memory.revision_id === promoted.revision_id
    )
  ) {
    throw new Error("Synthetic R2 projection manifest did not contain the formal memory head.");
  }

  const head = await readJsonResource(
    client,
    `memory://projects/${projectRef}/memories/${promoted.memory_id}`
  );
  if (
    head.revision_id !== promoted.revision_id ||
    head.memory_version !== 1 ||
    head.content !== SYNTHETIC_FORMAL_MEMORY_CONTENT
  ) {
    throw new Error("Synthetic canonical memory resource did not match the formal revision.");
  }

  const kindIndex = await readJsonResource(
    client,
    `memory://projects/${projectRef}/indexes/by-kind/fact`
  );
  if (
    kindIndex.project_id !== projectId ||
    kindIndex.project_version !== promoted.project_version ||
    kindIndex.dimension?.type !== "kind" ||
    kindIndex.dimension?.value !== "fact" ||
    !Array.isArray(kindIndex.memories) ||
    !kindIndex.memories.some(
      (memory) =>
        memory.memory_id === promoted.memory_id &&
        memory.revision_id === promoted.revision_id &&
        memory.memory_version === 1
    )
  ) {
    throw new Error("Synthetic kind index did not contain the formal memory revision.");
  }

  const classIndex = await readJsonResource(
    client,
    `memory://projects/${projectRef}/indexes/by-class/semantic`
  );
  if (
    classIndex.project_id !== projectId ||
    classIndex.project_version !== promoted.project_version ||
    classIndex.dimension?.type !== "class" ||
    classIndex.dimension?.value !== "semantic" ||
    !Array.isArray(classIndex.memories) ||
    !classIndex.memories.some(
      (memory) =>
        memory.memory_id === promoted.memory_id &&
        memory.revision_id === promoted.revision_id &&
        memory.memory_version === 1
    )
  ) {
    throw new Error("Synthetic class index did not contain the formal memory revision.");
  }

  const revision = await readJsonResource(
    client,
    `memory://projects/${projectRef}/memories/${promoted.memory_id}/versions/1`
  );
  if (
    revision.memory_id !== promoted.memory_id ||
    revision.revision_id !== promoted.revision_id ||
    revision.memory_version !== 1 ||
    revision.content !== SYNTHETIC_FORMAL_MEMORY_CONTENT
  ) {
    throw new Error("Synthetic immutable revision resource did not match the formal memory.");
  }

  const candidate = await readJsonResource(
    client,
    `memory://projects/${projectRef}/candidates/${promotionCandidateId}`
  );
  if (
    candidate.observation_id !== promotionCandidateId ||
    candidate.candidate_version !== 2 ||
    candidate.status !== "promoted"
  ) {
    throw new Error("Synthetic candidate resource did not match the formal promotion.");
  }

  const evidence = await readJsonResource(
    client,
    `memory://projects/${projectRef}/evidence/${formalEvidenceId}`
  );
  if (
    evidence.evidence_id !== formalEvidenceId ||
    evidence.source_type !== "synthetic_canary" ||
    evidence.locator !== formalEvidenceLocator ||
    evidence.sensitivity_status !== "clear"
  ) {
    throw new Error("Synthetic evidence resource did not match the promoted evidence.");
  }

  const workflowResource = await readJsonResource(
    client,
    `memory://projects/${projectRef}/workflows/${submitted.workflow_id}`
  );
  if (
    workflowResource.status !== "complete" ||
    workflowResource.workflow_type !== "candidate.submitted" ||
    (workflowResource.workflow_id !== submitted.workflow_id &&
      workflowResource.root_workflow_id !== submitted.workflow_id)
  ) {
    throw new Error("Synthetic workflow resource did not match the completed candidate workflow.");
  }

  const audit = await readJsonResource(
    client,
    `memory://projects/${projectRef}/audit/${projectId}:1`
  );
  if (
    audit.audit_id !== `${projectId}:1` ||
    audit.sequence !== 1 ||
    audit.event_type !== "candidate_promoted"
  ) {
    throw new Error("Synthetic audit resource did not match the formal promotion.");
  }

  const closed = decodeToolResult(
    await client.callTool({
      name: "session_close",
      arguments: {
        session_id: opened.session_id,
        expected_session_version: 1,
        summary: "Synthetic production canary completed.",
        trigger_consolidation: false,
        idempotency_key: `synthetic-close-${randomUUID()}`
      }
    })
  );
  if (closed.status !== "closed" || closed.session_version !== 2) {
    throw new Error("Synthetic session CAS close failed.");
  }

  console.log("Synthetic MCP lane passed with all tools and resource templates verified.");
} finally {
  await client.close();
}

async function waitForWorkflow(mcpClient, authorizedProjectRef, workflowId) {
  const deadline = Date.now() + workflowTimeoutMs;
  while (Date.now() < deadline) {
    const result = await mcpClient.callTool({
      name: "workflow_get",
      arguments: {
        project_ref: authorizedProjectRef,
        workflow_id: workflowId
      }
    });
    if (!result.isError) {
      const workflow = decodeToolResult(result);
      if (["complete", "failed", "terminated"].includes(workflow.status)) {
        return workflow;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Synthetic workflow did not reach a terminal state before the deadline.");
}

async function waitForHybridSearch(
  mcpClient,
  authorizedProjectRef,
  sessionId,
  memoryId,
  revisionId
) {
  const deadline = Date.now() + workflowTimeoutMs;
  while (Date.now() < deadline) {
    const result = await mcpClient.callTool({
      name: "memory_search",
      arguments: {
        project_ref: authorizedProjectRef,
        session_id: sessionId,
        query: SYNTHETIC_FORMAL_MEMORY_CONTENT,
        filters: { status: "active" },
        limit: 5
      }
    });
    if (!result.isError) {
      const searched = decodeToolResult(result);
      if (
        searched.abstained === false &&
        Array.isArray(searched.memories) &&
        searched.memories.some(
          (memory) => memory.memoryId === memoryId && memory.revisionId === revisionId
        )
      ) {
        return searched;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error("Synthetic formal memory was not returned by hybrid search.");
}

function decodeToolResult(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("Tool response did not contain JSON text.");
  }
  const body = JSON.parse(text);
  if (result.isError) {
    throw new Error(`Tool failed with ${String(body.code ?? "UNKNOWN")}.`);
  }
  return body;
}

async function readJsonResource(mcpClient, uri) {
  const result = await mcpClient.readResource({ uri });
  const text = result.contents?.find(
    (entry) => entry.uri === uri && typeof entry.text === "string"
  )?.text;
  if (!text) {
    throw new Error(`Resource ${uri} did not contain JSON text.`);
  }
  return JSON.parse(text);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
