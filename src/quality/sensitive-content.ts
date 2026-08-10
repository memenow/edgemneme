export type CandidateInspection =
  | { accepted: true }
  | {
      accepted: false;
      disposition: "tombstone";
      reason: "SENSITIVE_CONTENT" | "CONTENT_TOO_LARGE";
      detector?: string;
    };

export const MEMORY_MODEL_INPUT_MAX_BYTES = 16 * 1024;

const DETECTORS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "private-key", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/u },
  { name: "github-token", pattern: /\b(?:gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { name: "provider-token", pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/u },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  {
    name: "assigned-secret",
    pattern:
      /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*["']?[^\s,;}"']{4,}/iu
  },
  {
    name: "credentialed-connection-string",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mariadb|redis|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/iu
  },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/iu },
  { name: "email-address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { name: "us-ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/u }
];

const STRUCTURED_PII_DETECTORS: ReadonlyArray<{
  name: string;
  matches: (content: string) => boolean;
}> = [
  { name: "payment-card", matches: containsPaymentCardNumber },
  { name: "phone-number", matches: containsPhoneNumber },
  { name: "cn-resident-id", matches: containsChineseResidentId }
];

const FORMATTED_LOCAL_PHONE_PATTERNS: readonly RegExp[] = [
  /(?:^|[^0-9A-Za-z])1[3-9][0-9][ .-][0-9]{4}[ .-][0-9]{4}(?=$|[^0-9A-Za-z])/u,
  /(?:^|[^0-9A-Za-z])(?:02[0-9][ .-][0-9]{4}[ .-][0-9]{4}|01[0-9]{2}[ .-][0-9]{3}[ .-][0-9]{4}|01[0-9]{3}[ .-][0-9]{6}|07[0-9]{3}[ .-][0-9]{6})(?=$|[^0-9A-Za-z])/u
];

const CONTIGUOUS_PHONE_CANDIDATE_PATTERN =
  /(?:^|[^0-9A-Za-z])([0-9]{10,11})(?=$|[^0-9A-Za-z])/gu;

const TECHNICAL_NUMERIC_CONTEXT_PATTERN =
  /(?:^|[^a-z0-9])(?:build(?:[_ -]?(?:id|number))?|checksum|commit(?:[_ -]?(?:id|sha))?|count|counter|digest|epoch(?:[_ -]?(?:seconds|milliseconds|nanoseconds|timestamp))?|event[_ -]?id|hash|issue[_ -]?(?:id|number)|job[_ -]?id|project[_ -]?id|record[_ -]?id|repository[_ -]?id|request[_ -]?id|revision[_ -]?id|run[_ -]?(?:id|number)|sequence(?:[_ -]?number)?|span[_ -]?id|timestamp|trace[_ -]?id|version(?:[_ -]?(?:id|number))?)["']?\s*(?:(?:is|was)\s*)?(?:[:=#]\s*)?$/u;

export function inspectCandidateContent(
  content: string,
  options: { maxBytes: number }
): CandidateInspection {
  const originalInspection = inspectCandidateContentRepresentation(content, options);
  if (!originalInspection.accepted) {
    return originalInspection;
  }
  const normalized = content.normalize("NFKC");
  return normalized === content
    ? originalInspection
    : inspectCandidateContentRepresentation(normalized, options);
}

function inspectCandidateContentRepresentation(
  content: string,
  options: { maxBytes: number }
): CandidateInspection {
  if (new TextEncoder().encode(content).byteLength > options.maxBytes) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "CONTENT_TOO_LARGE"
    };
  }
  if (containsSensitiveAssignment(content)) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "SENSITIVE_CONTENT",
      detector: "assigned-secret"
    };
  }
  for (const detector of DETECTORS) {
    if (detector.pattern.test(content)) {
      return {
        accepted: false,
        disposition: "tombstone",
        reason: "SENSITIVE_CONTENT",
        detector: detector.name
      };
    }
  }
  for (const detector of STRUCTURED_PII_DETECTORS) {
    if (detector.matches(content)) {
      return {
        accepted: false,
        disposition: "tombstone",
        reason: "SENSITIVE_CONTENT",
        detector: detector.name
      };
    }
  }
  if (hasHighEntropyToken(content)) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "SENSITIVE_CONTENT",
      detector: "high-entropy-token"
    };
  }
  return { accepted: true };
}

/**
 * Inspects transient text before it can be sent to a model. In addition to the
 * shared credential and PII detectors, this rejects transcript-shaped prompts
 * and multi-line raw log dumps that should never become model input.
 */
export function inspectModelInput(
  content: string,
  options: { maxBytes: number }
): CandidateInspection {
  const contentInspection = inspectCandidateContent(content, options);
  if (!contentInspection.accepted) {
    return contentInspection;
  }
  const normalized = content.normalize("NFKC");
  if (looksLikePromptTranscript(content) || looksLikePromptTranscript(normalized)) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "SENSITIVE_CONTENT",
      detector: "prompt-transcript"
    };
  }
  if (looksLikeRawLog(content) || looksLikeRawLog(normalized)) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "SENSITIVE_CONTENT",
      detector: "raw-log"
    };
  }
  return { accepted: true };
}

export function inspectMemoryModelInput(content: string): CandidateInspection {
  return inspectModelInput(content, { maxBytes: MEMORY_MODEL_INPUT_MAX_BYTES });
}

export function inspectMemoryModelValue(
  value: unknown,
  options: { maxBytes: number }
): CandidateInspection {
  const persistedInspection = inspectPersistedValue(value, options);
  if (!persistedInspection.accepted) {
    return persistedInspection;
  }
  const stringValues: string[] = [];
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      stringValues.push(current);
    } else if (typeof current === "object" && current !== null) {
      pending.push(...Object.values(current));
    }
  }
  return inspectMemoryModelInput(stringValues.join("\n"));
}

export function inspectPersistedValue(
  value: unknown,
  options: { maxBytes: number }
): CandidateInspection {
  let serialized: string | undefined;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "CONTENT_TOO_LARGE"
    };
  }
  if (typeof serialized !== "string") {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "CONTENT_TOO_LARGE"
    };
  }
  const serializedInspection = inspectCandidateContent(serialized, options);
  if (!serializedInspection.accepted) {
    return serializedInspection;
  }
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      const inspection = inspectCandidateContent(current, options);
      if (!inspection.accepted) {
        return inspection;
      }
    } else if (typeof current === "object" && current !== null) {
      if (seen.has(current)) {
        return {
          accepted: false,
          disposition: "tombstone",
          reason: "CONTENT_TOO_LARGE"
        };
      }
      seen.add(current);
      for (const [key, nestedValue] of Object.entries(current)) {
        if (hasSensitiveSemanticKey(key)) {
          return {
            accepted: false,
            disposition: "tombstone",
            reason: "SENSITIVE_CONTENT",
            detector: "sensitive-field-name"
          };
        }
        pending.push(nestedValue);
      }
    }
  }
  return { accepted: true };
}

export function inspectSensitivePath(path: string): CandidateInspection {
  if (hasSensitiveSemanticKey(path)) {
    return {
      accepted: false,
      disposition: "tombstone",
      reason: "SENSITIVE_CONTENT",
      detector: "sensitive-path"
    };
  }
  return inspectCandidateContent(path, { maxBytes: 4 * 1024 });
}

function containsSensitiveAssignment(content: string): boolean {
  const assignments = content.matchAll(
    /([A-Za-z][A-Za-z0-9_.-]{1,128})["']?\s*[:=]\s*["']?[^\s,;}"']{4,}/gu
  );
  for (const assignment of assignments) {
    if (hasSensitiveSemanticKey(assignment[1] ?? "")) {
      return true;
    }
  }
  return false;
}

function hasSensitiveSemanticKey(value: string): boolean {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
  if (
    tokens.some(
      (token) =>
        token === "password" ||
        token === "secret" ||
        token === "token" ||
        token.endsWith("password") ||
        token.endsWith("secret") ||
        token.endsWith("token") ||
        token.endsWith("apikey") ||
        token.endsWith("accesstoken")
    )
  ) {
    return true;
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const pair = `${tokens[index]}_${tokens[index + 1]}`;
    if (pair === "api_key" || pair === "access_token") {
      return true;
    }
  }
  return false;
}

function hasHighEntropyToken(content: string): boolean {
  const candidates = content.match(/[A-Za-z0-9+/=_-]{32,128}/gu) ?? [];
  return candidates.some((candidate) => {
    if (/^[A-Fa-f0-9]+$/u.test(candidate) || /^\d+$/u.test(candidate)) {
      return false;
    }
    const counts = new Map<string, number>();
    for (const character of candidate) {
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of counts.values()) {
      const probability = count / candidate.length;
      entropy -= probability * Math.log2(probability);
    }
    return entropy >= 4.5;
  });
}

function containsPaymentCardNumber(content: string): boolean {
  const candidates = content.match(/\b[0-9](?:[ -]?[0-9]){12,18}\b/gu) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[^0-9]/gu, "");
    return new Set(digits).size > 1 && passesLuhnChecksum(digits);
  });
}

function passesLuhnChecksum(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  const doubleParity = digits.length % 2;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === doubleParity) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function containsPhoneNumber(content: string): boolean {
  if (/\+[1-9](?:[ ().-]*[0-9]){7,14}\b/gu.test(content)) {
    return true;
  }
  if (
    /(?:\([2-9][0-9]{2}\)[ \t]*|\b[2-9][0-9]{2}[-. ])[2-9][0-9]{2}[-. ][0-9]{4}\b/gu.test(
      content
    )
  ) {
    return true;
  }
  if (FORMATTED_LOCAL_PHONE_PATTERNS.some((pattern) => pattern.test(content))) {
    return true;
  }
  const labeledCandidates = content.matchAll(
    /(?:\b(?:contact|mobile|phone|telephone|tel)\b|联系电话|手机号|手机|电话)[ \t]*[:=：]?[ \t]*(\+?[0-9][0-9 ().-]{5,23}[0-9])/giu
  );
  for (const candidate of labeledCandidates) {
    const digits = (candidate[1] ?? "").replace(/[^0-9]/gu, "");
    if (digits.length >= 7 && digits.length <= 15) {
      return true;
    }
  }
  for (const candidate of content.matchAll(CONTIGUOUS_PHONE_CANDIDATE_PATTERN)) {
    const digits = candidate[1] ?? "";
    const candidateOffset =
      (candidate.index ?? 0) + Math.max(0, candidate[0].lastIndexOf(digits));
    if (
      !hasTechnicalNumericContext(content, candidateOffset) &&
      (isChineseMobileNumber(digits) || isNorthAmericanPhoneNumber(digits))
    ) {
      return true;
    }
  }
  return false;
}

function hasTechnicalNumericContext(content: string, candidateOffset: number): boolean {
  const prefix = content
    .slice(Math.max(0, candidateOffset - 80), candidateOffset)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  return TECHNICAL_NUMERIC_CONTEXT_PATTERN.test(prefix);
}

function isChineseMobileNumber(digits: string): boolean {
  return /^1[3-9][0-9]{9}$/u.test(digits);
}

function isNorthAmericanPhoneNumber(digits: string): boolean {
  const nationalNumber =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9][0-9]{2}[2-9][0-9]{6}$/u.test(nationalNumber)) {
    return false;
  }
  return nationalNumber.slice(1, 3) !== "11" && nationalNumber.slice(4, 6) !== "11";
}

function containsChineseResidentId(content: string): boolean {
  const candidates = content.matchAll(
    /(?:^|[^0-9A-Za-z])([1-9][0-9]{16}[0-9Xx])(?=$|[^0-9A-Za-z])/gu
  );
  for (const candidate of candidates) {
    const identifier = (candidate[1] ?? "").toUpperCase();
    if (hasValidResidentIdBirthDate(identifier) && hasValidResidentIdChecksum(identifier)) {
      return true;
    }
  }
  return false;
}

function hasValidResidentIdBirthDate(identifier: string): boolean {
  const year = Number(identifier.slice(6, 10));
  const month = Number(identifier.slice(10, 12));
  const day = Number(identifier.slice(12, 14));
  if (year < 1800 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function hasValidResidentIdChecksum(identifier: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
  const checkCharacters = ["1", "0", "X", "9", "8", "7", "6", "5", "4", "3", "2"] as const;
  const sum = weights.reduce(
    (total, weight, index) => total + Number(identifier[index]) * weight,
    0
  );
  return identifier[17] === checkCharacters[sum % 11];
}

function looksLikePromptTranscript(content: string): boolean {
  const normalized = content.replace(/\r\n?/gu, "\n");
  if (
    /(?:^|\n)\s*(?:<\|(?:im_start|system|developer|user|assistant)\|>|\[INST\]|###\s+(?:System|Developer|User|Assistant)\b)/iu.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    /(?:^|\n)\s*(?:You are (?:ChatGPT|an? AI (?:assistant|agent))|Ignore (?:all |any )?(?:previous|prior) instructions)\b/iu.test(
      normalized
    )
  ) {
    return true;
  }
  if (/(?:^|\n)\s*(?:system|developer)\s*:/iu.test(normalized)) {
    return true;
  }
  const roleMarkers = normalized.match(
    /(?:^|\n)\s*(?:system|developer|user|assistant)\s*:/giu
  );
  return (roleMarkers?.length ?? 0) >= 2;
}

function looksLikeRawLog(content: string): boolean {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const timestampedLogLine =
    /^\s*(?:\d{4}-\d{2}-\d{2}[T ][-0-9:.+Z]+|\[[-0-9:.+Z]+\])\s+\[?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]?\b/iu;
  if (lines.some((line) => timestampedLogLine.test(line))) {
    return true;
  }
  const logLines = lines.filter((line) =>
    /^(?:\s*\[?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]?\b|\s+at\s+\S+\s*\([^\n]+:\d+(?::\d+)?\))/iu.test(
      line
    )
  );
  const nonemptyLineCount = lines.filter((line) => line.trim() !== "").length;
  return logLines.length >= 3 && logLines.length * 2 >= nonemptyLineCount;
}
