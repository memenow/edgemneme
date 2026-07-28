export const MEMORY_KINDS = [
  "decision",
  "fact",
  "convention",
  "procedure",
  "learning",
  "incident",
  "reference",
  "feedback"
] as const;

export const MEMORY_CLASSES = ["semantic", "procedural", "episodic"] as const;
export const MEMORY_SCOPES = ["project", "repository", "ref", "worktree", "session"] as const;
export const MEMORY_STATUSES = [
  "active",
  "contested",
  "superseded",
  "invalidated",
  "archived"
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryClass = (typeof MEMORY_CLASSES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
