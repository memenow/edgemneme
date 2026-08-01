import type { WorkflowStep } from "cloudflare:workers";
import { GitHubSyncError } from "../../src/github/client";
import { githubRetentionIdentity } from "../../src/github/sync-scheduling";
import { maintainGitHubTreeManifestRetention } from "../../src/github/tree-manifest-retention";
import {
  type Env,
  type GitHubRetentionWorkflowPayload
} from "./index";
import {
  STEP_RETRY,
  activeWorkflowEnv
} from "./workflow-runtime";

export {
  ensureGitHubRefWorkflowBatch,
  runGitHubDispatchWorkflow
} from "./workflow-dispatch";
export { runGitHubRefSyncWorkflow } from "./workflow-ref";
export {
  MAX_DISPATCH_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_LIST_RECONCILIATION_SUBREQUESTS,
  MAX_ORPHAN_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_PENDING_RECONCILIATION_SUBREQUESTS_PER_ROW,
  MAX_PRIOR_RECONCILIATION_PAGES,
  MAX_PRIOR_RECONCILIATION_SUBREQUESTS,
  MAX_RUNNING_RECONCILIATION_QUERIES_PER_INVOCATION_ROW,
  MAX_RUNNING_RECONCILIATION_ROWS,
  MAX_RUNNING_RECONCILIATION_SUBREQUESTS_PER_ROW,
  createPriorReconciliationBudget,
  reconcilePriorDispatchState
} from "./workflow-runtime";

export async function runGitHubRetentionWorkflow(
  payload: GitHubRetentionWorkflowPayload,
  instanceId: string,
  step: WorkflowStep,
  env: Env
): Promise<void> {
  const active = activeWorkflowEnv(env);
  const expectedIdentity = await githubRetentionIdentity(
    Date.parse(payload.scheduledFor)
  );
  if (
    payload.scheduledFor !== expectedIdentity.scheduledFor ||
    payload.utcDate !== expectedIdentity.utcDate ||
    instanceId !== expectedIdentity.instanceId
  ) {
    throw new GitHubSyncError("GITHUB_RECONCILIATION_REQUIRED");
  }
  await step.do("maintain GitHub manifest retention", STEP_RETRY, async () => {
    const result = await maintainGitHubTreeManifestRetention(
      active.MEMORY_DB,
      Date.parse(payload.scheduledFor)
    );
    if (result.errors > 0) {
      throw new Error("GitHub manifest retention completed with isolated errors.");
    }
  });
}
