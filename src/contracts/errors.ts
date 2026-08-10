export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "PROJECT_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "VALIDATION_FAILED",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "PAGE_TOKEN_INVALID",
  "RATE_LIMITED",
  "WORKFLOW_FAILED",
  "INTERNAL"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class EdgeMnemeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; requestId?: string; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "EdgeMnemeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function errorBody(error: unknown, requestId: string): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  request_id: string;
  retry_after_ms?: number;
} {
  if (error instanceof EdgeMnemeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      request_id: error.requestId ?? requestId,
      ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs })
    };
  }
  return {
    code: "INTERNAL",
    message: "An internal error occurred.",
    retryable: false,
    request_id: requestId
  };
}
