import type {
  ProjectionMemory,
  ProjectionWrite
} from "./markdown";

export interface ProjectionSnapshotInput {
  projectId: string;
  projectVersion: number;
  snapshotId: string;
  heads: readonly ProjectionMemory[];
  revisions: readonly ProjectionMemory[];
}

export interface ProjectionSnapshotWritePlan {
  projectId: string;
  projectVersion: number;
  snapshotId: string;
  prefix: string;
  manifestKey: string;
  manifestSha256: string;
  writes: ProjectionWrite[];
}
