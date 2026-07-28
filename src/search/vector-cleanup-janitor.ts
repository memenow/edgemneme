import {
  cleanupMemorySearchVectorReceiptPage,
  SearchVectorCleanupClaimError
} from "./indexing";

export const SEARCH_VECTOR_CLEANUP_OWNER_LIMIT = 1;
export const SEARCH_VECTOR_CLEANUP_RECEIPT_LIMIT = 50;
export const SEARCH_VECTOR_CLEANUP_DELETE_ATTEMPTS = 3;
export const SEARCH_VECTOR_CLEANUP_DELETE_DELAY_MS = 1_000;
export const SEARCH_VECTOR_CLEANUP_MAX_BACKOFF_ATTEMPT = 8;
export const SEARCH_VECTOR_CLEANUP_BASE_BACKOFF_MS = 60_000;
export const SEARCH_VECTOR_CLEANUP_MAX_BACKOFF_MS = 60 * 60 * 1_000;

interface CleanupOwnerRow {
  generation_id: string;
  project_id: string;
  memory_id: string;
  cleanup_attempt: number;
}

interface CleanupCursorRow {
  cursor_version: number;
  cursor_generation_id: string | null;
  cursor_project_id: string | null;
  cursor_memory_id: string | null;
}

interface SearchVectorCleanupJanitorEnv {
  searchDb: D1Database;
  vectors: VectorizeIndex;
}

export interface SearchVectorCleanupJanitorResult {
  ownersExamined: number;
  receiptsExamined: number;
}

export async function reapSearchVectorCleanupReceipts(
  env: SearchVectorCleanupJanitorEnv,
  options: {
    ownerLimit?: number;
    receiptLimit?: number;
    attempts?: number;
    delayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  } = {}
): Promise<SearchVectorCleanupJanitorResult> {
  const ownerLimit = options.ownerLimit ?? SEARCH_VECTOR_CLEANUP_OWNER_LIMIT;
  const receiptLimit = options.receiptLimit ?? SEARCH_VECTOR_CLEANUP_RECEIPT_LIMIT;
  const attempts = options.attempts ?? SEARCH_VECTOR_CLEANUP_DELETE_ATTEMPTS;
  const delayMs = options.delayMs ?? SEARCH_VECTOR_CLEANUP_DELETE_DELAY_MS;
  const nowMs = (options.now ?? Date.now)();
  if (
    !Number.isSafeInteger(ownerLimit) ||
    ownerLimit < 1 ||
    ownerLimit > SEARCH_VECTOR_CLEANUP_OWNER_LIMIT
  ) {
    throw new TypeError("The search vector cleanup owner limit is invalid.");
  }
  if (
    !Number.isSafeInteger(receiptLimit) ||
    receiptLimit < 1 ||
    receiptLimit > SEARCH_VECTOR_CLEANUP_RECEIPT_LIMIT
  ) {
    throw new TypeError("The search vector cleanup receipt limit is invalid.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new TypeError("The search vector cleanup deletion attempt limit is invalid.");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new TypeError("The search vector cleanup deletion delay is invalid.");
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("The search vector cleanup janitor time is invalid.");
  }

  const cursor = await env.searchDb.prepare(
    `SELECT cursor_version, cursor_generation_id, cursor_project_id,
            cursor_memory_id
     FROM memory_search_vector_cleanup_janitor_state
     WHERE state_id = 1`
  ).first<CleanupCursorRow>();
  if (cursor === null) {
    throw new Error("The search vector cleanup janitor cursor is unavailable.");
  }
  if (!Number.isSafeInteger(cursor.cursor_version) || cursor.cursor_version < 0) {
    throw new Error("The search vector cleanup janitor cursor version is invalid.");
  }
  const cursorValues = [
    cursor.cursor_generation_id,
    cursor.cursor_project_id,
    cursor.cursor_memory_id
  ];
  if (
    !(
      cursorValues.every((value) => value === null) ||
      cursorValues.every((value) => typeof value === "string" && value.length > 0)
    )
  ) {
    throw new Error("The search vector cleanup janitor cursor is invalid.");
  }
  const nowIso = new Date(nowMs).toISOString();
  let owners = await loadCleanupOwners(env.searchDb, ownerLimit, cursor, nowIso);
  if (
    owners.length === 0 &&
    cursor.cursor_generation_id !== null
  ) {
    owners = await loadCleanupOwners(env.searchDb, ownerLimit, null, nowIso);
  }
  if (owners.length === 0) {
    return { ownersExamined: 0, receiptsExamined: 0 };
  }
  const owner = owners[0]!;
  const cursorUpdate = await env.searchDb.prepare(
    `UPDATE memory_search_vector_cleanup_janitor_state
     SET cursor_generation_id = ?, cursor_project_id = ?, cursor_memory_id = ?,
         updated_at = ?, cursor_version = cursor_version + 1
     WHERE state_id = 1 AND cursor_version = ?
       AND cursor_generation_id IS ? AND cursor_project_id IS ?
       AND cursor_memory_id IS ?
       AND EXISTS (
         SELECT 1
         FROM memory_search_vector_cleanup_receipts AS receipt
         INDEXED BY memory_search_vector_cleanup_by_owner
         WHERE receipt.generation_id = ? AND receipt.project_id = ?
           AND receipt.memory_id = ?
           AND (
             receipt.cleanup_claim_token IS NULL
             OR receipt.cleanup_claim_expires_at <= ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM memory_search_vector_cleanup_receipts AS blocked
             INDEXED BY memory_search_vector_cleanup_by_owner
             WHERE blocked.generation_id = receipt.generation_id
               AND blocked.project_id = receipt.project_id
               AND blocked.memory_id = receipt.memory_id
               AND blocked.cleanup_next_attempt_at > ?
           )
       )`
  ).bind(
    owner.generation_id,
    owner.project_id,
    owner.memory_id,
    nowIso,
    cursor.cursor_version,
    cursor.cursor_generation_id,
    cursor.cursor_project_id,
    cursor.cursor_memory_id,
    owner.generation_id,
    owner.project_id,
    owner.memory_id,
    nowIso,
    nowIso
  ).run();
  if (cursorUpdate.meta.changes !== 1) {
    return { ownersExamined: 0, receiptsExamined: 0 };
  }
  let receiptsExamined = 0;
  for (const currentOwner of owners) {
    try {
      const result = await cleanupMemorySearchVectorReceiptPage(
        env,
        {
          generationId: currentOwner.generation_id,
          projectId: currentOwner.project_id,
          memoryId: currentOwner.memory_id
        },
        {
          receiptLimit,
          attempts,
          delayMs,
          now: options.now ?? Date.now,
          ...(options.delay === undefined ? {} : { delay: options.delay })
        }
      );
      receiptsExamined += result.examinedReceipts;
      await clearCleanupOwnerBackoff(env.searchDb, currentOwner, nowIso);
    } catch (error) {
      await recordCleanupOwnerFailure(
        env.searchDb,
        currentOwner,
        cleanupFailureCode(error),
        requireJanitorClock(options.now ?? Date.now)
      );
      throw error;
    }
  }
  return { ownersExamined: owners.length, receiptsExamined };
}

async function loadCleanupOwners(
  searchDb: D1Database,
  ownerLimit: number,
  cursor: CleanupCursorRow | null,
  nowIso: string
): Promise<CleanupOwnerRow[]> {
  const afterCursor = cursor !== null && cursor.cursor_generation_id !== null;
  const statement = searchDb.prepare(
    `SELECT receipt.generation_id, receipt.project_id, receipt.memory_id,
            MAX(receipt.cleanup_attempt) AS cleanup_attempt
     FROM memory_search_vector_cleanup_receipts AS receipt
     INDEXED BY memory_search_vector_cleanup_by_owner
     WHERE (
       receipt.cleanup_claim_token IS NULL
       OR receipt.cleanup_claim_expires_at <= ?
     )
       AND NOT EXISTS (
         SELECT 1
         FROM memory_search_vector_cleanup_receipts AS blocked
         INDEXED BY memory_search_vector_cleanup_by_owner
         WHERE blocked.generation_id = receipt.generation_id
           AND blocked.project_id = receipt.project_id
           AND blocked.memory_id = receipt.memory_id
           AND blocked.cleanup_next_attempt_at > ?
       )
     ${afterCursor
       ? `AND (receipt.generation_id, receipt.project_id, receipt.memory_id)
              > (?, ?, ?)`
       : ""}
     GROUP BY receipt.generation_id, receipt.project_id, receipt.memory_id
     ORDER BY receipt.generation_id, receipt.project_id, receipt.memory_id
     LIMIT ?`
  );
  const result = afterCursor
    ? await statement.bind(
        nowIso,
        nowIso,
        cursor.cursor_generation_id,
        cursor.cursor_project_id,
        cursor.cursor_memory_id,
        ownerLimit
      ).all<CleanupOwnerRow>()
    : await statement.bind(nowIso, nowIso, ownerLimit).all<CleanupOwnerRow>();
  for (const owner of result.results) {
    if (
      !Number.isSafeInteger(owner.cleanup_attempt) ||
      owner.cleanup_attempt < 0 ||
      owner.cleanup_attempt > SEARCH_VECTOR_CLEANUP_MAX_BACKOFF_ATTEMPT
    ) {
      throw new Error("The search vector cleanup owner backoff is invalid.");
    }
  }
  return result.results;
}

async function clearCleanupOwnerBackoff(
  searchDb: D1Database,
  owner: CleanupOwnerRow,
  startedAt: string
): Promise<void> {
  await searchDb.prepare(
    `UPDATE memory_search_vector_cleanup_receipts
     SET cleanup_attempt = 0, cleanup_next_attempt_at = NULL,
         cleanup_last_error_code = NULL
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       AND cleanup_attempt > 0 AND cleanup_next_attempt_at <= ?`
  ).bind(
    owner.generation_id,
    owner.project_id,
    owner.memory_id,
    startedAt
  ).run();
}

async function recordCleanupOwnerFailure(
  searchDb: D1Database,
  owner: CleanupOwnerRow,
  errorCode: CleanupFailureCode,
  failedAtMs: number
): Promise<void> {
  const attempt = Math.min(
    owner.cleanup_attempt + 1,
    SEARCH_VECTOR_CLEANUP_MAX_BACKOFF_ATTEMPT
  );
  const delayMs = Math.min(
    SEARCH_VECTOR_CLEANUP_BASE_BACKOFF_MS * 2 ** (attempt - 1),
    SEARCH_VECTOR_CLEANUP_MAX_BACKOFF_MS
  );
  const failedAt = new Date(failedAtMs).toISOString();
  const nextAttemptAt = new Date(failedAtMs + delayMs).toISOString();
  await searchDb.prepare(
    `UPDATE memory_search_vector_cleanup_receipts
     SET cleanup_attempt = ?, cleanup_next_attempt_at = ?,
         cleanup_last_error_code = ?
     WHERE generation_id = ? AND project_id = ? AND memory_id = ?
       AND (
         cleanup_next_attempt_at IS NULL
         OR cleanup_next_attempt_at <= ?
       )`
  ).bind(
    attempt,
    nextAttemptAt,
    errorCode,
    owner.generation_id,
    owner.project_id,
    owner.memory_id,
    failedAt
  ).run();
}

type CleanupFailureCode =
  | "OWNERSHIP_BOUNDARY"
  | "CLAIM_INVALID"
  | "VECTORIZE_FAILURE"
  | "INTERNAL";

function cleanupFailureCode(error: unknown): CleanupFailureCode {
  if (error instanceof SearchVectorCleanupClaimError) {
    return "CLAIM_INVALID";
  }
  if (error instanceof Error && error.message.includes("ownership boundary")) {
    return "OWNERSHIP_BOUNDARY";
  }
  if (error instanceof Error && error.message.toLowerCase().includes("vector")) {
    return "VECTORIZE_FAILURE";
  }
  return "INTERNAL";
}

function requireJanitorClock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("The search vector cleanup janitor time is invalid.");
  }
  return value;
}
