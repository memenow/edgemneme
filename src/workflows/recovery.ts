interface WorkflowStatusLike {
  status: string;
}

interface WorkflowInstanceLike {
  status(): Promise<WorkflowStatusLike>;
}

export interface WorkflowBindingLike<Payload> {
  create(options: { id: string; params: Payload }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstanceLike> | WorkflowInstanceLike;
}

const TERMINAL_FAILURES = new Set(["errored", "terminated"]);
const REUSABLE_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
  "complete"
]);

export class WorkflowControlPlaneStatusError extends Error {
  constructor() {
    super("The Workflow control-plane status is unavailable.");
    this.name = "WorkflowControlPlaneStatusError";
  }
}

export class WorkflowRepairExhaustedError extends Error {
  readonly lastFailure: unknown;

  constructor(lastFailure: unknown) {
    super(
      lastFailure instanceof Error
        ? lastFailure.message
        : "The workflow exhausted its repair attempts."
    );
    this.name = "WorkflowRepairExhaustedError";
    this.lastFailure = lastFailure;
  }
}

export async function ensureWorkflowWithRepair<Payload>(
  workflow: WorkflowBindingLike<Payload>,
  baseId: string,
  params: Payload,
  maximumRepairs = 3
): Promise<string> {
  if (!Number.isSafeInteger(maximumRepairs) || maximumRepairs < 0 || maximumRepairs > 10) {
    throw new TypeError("The workflow repair limit is invalid.");
  }
  let lastFailure: unknown;
  for (let repair = 0; repair <= maximumRepairs; repair += 1) {
    const id = repair === 0 ? baseId : `${baseId}-repair-${repair}`;
    try {
      await workflow.create({ id, params });
      return id;
    } catch (error) {
      lastFailure = error;
      let status: WorkflowStatusLike;
      try {
        const instance = await workflow.get(id);
        status = await instance.status();
      } catch {
        throw new WorkflowControlPlaneStatusError();
      }
      if (!TERMINAL_FAILURES.has(status.status)) {
        if (REUSABLE_STATUSES.has(status.status)) {
          return id;
        }
        throw new WorkflowControlPlaneStatusError();
      }
    }
  }
  throw new WorkflowRepairExhaustedError(lastFailure);
}
