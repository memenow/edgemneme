import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import {
  scheduleGitHubSyncWorkflows,
  type Env,
  type GitHubDispatchWorkflowPayload,
  type GitHubRefSyncWorkflowPayload,
  type GitHubRetentionWorkflowPayload
} from "./index";
import {
  runGitHubDispatchWorkflow,
  runGitHubRefSyncWorkflow,
  runGitHubRetentionWorkflow
} from "./workflow-core";

export class GitHubDispatchWorkflow extends WorkflowEntrypoint<
  Env,
  GitHubDispatchWorkflowPayload
> {
  override run(
    event: WorkflowEvent<GitHubDispatchWorkflowPayload>,
    step: WorkflowStep
  ): Promise<void> {
    return runGitHubDispatchWorkflow(event.payload, event.instanceId, step, this.env);
  }
}

export class GitHubRefSyncWorkflow extends WorkflowEntrypoint<
  Env,
  GitHubRefSyncWorkflowPayload
> {
  override run(
    event: WorkflowEvent<GitHubRefSyncWorkflowPayload>,
    step: WorkflowStep
  ): Promise<void> {
    return runGitHubRefSyncWorkflow(event.payload, event.instanceId, step, this.env);
  }
}

export class GitHubRetentionWorkflow extends WorkflowEntrypoint<
  Env,
  GitHubRetentionWorkflowPayload
> {
  override run(
    event: WorkflowEvent<GitHubRetentionWorkflowPayload>,
    step: WorkflowStep
  ): Promise<void> {
    return runGitHubRetentionWorkflow(
      event.payload,
      event.instanceId,
      step,
      this.env
    );
  }
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    await scheduleGitHubSyncWorkflows(controller, env);
  }
} satisfies ExportedHandler<Env>;
