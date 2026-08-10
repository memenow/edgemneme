export const GITHUB_BLOB_TRANSPORT_LIMIT_BYTES = 64 * 1024;

export type GitHubBlobDisposition =
  | "text"
  | "binary_excluded"
  | "generated_excluded"
  | "partial";

export type GitHubBlobClassificationReason =
  | "strict_utf8_text"
  | "known_binary_extension"
  | "known_binary_format"
  | "nul_byte"
  | "excessive_control_bytes"
  | "generated_path"
  | "minified_path"
  | "large_lockfile"
  | "transport_limit_exceeded"
  | "declared_size_mismatch"
  | "invalid_declared_size"
  | "invalid_utf8"
  | "ambiguous_control_bytes";

export type GitHubBlobTextClassification = {
  disposition: "text";
  reason: "strict_utf8_text";
  byteLength: number;
  text: string;
};

export type GitHubBlobBinaryClassification = {
  disposition: "binary_excluded";
  reason:
    | "known_binary_extension"
    | "known_binary_format"
    | "nul_byte"
    | "excessive_control_bytes";
  byteLength?: number;
};

export type GitHubBlobGeneratedClassification = {
  disposition: "generated_excluded";
  reason: "generated_path" | "minified_path" | "large_lockfile";
  byteLength?: number;
};

export type GitHubBlobPartialClassification = {
  disposition: "partial";
  reason:
    | "transport_limit_exceeded"
    | "declared_size_mismatch"
    | "invalid_declared_size"
    | "invalid_utf8"
    | "ambiguous_control_bytes";
  byteLength?: number;
};

export type GitHubBlobExcludedClassification =
  | GitHubBlobBinaryClassification
  | GitHubBlobGeneratedClassification;

export type GitHubBlobClassification =
  | GitHubBlobTextClassification
  | GitHubBlobExcludedClassification
  | GitHubBlobPartialClassification;

export type GitHubBlobPathDecision =
  | {
      action: "inspect";
      reason: "content_inspection_required";
    }
  | {
      action: "exclude";
      result: GitHubBlobExcludedClassification;
    }
  | {
      action: "partial";
      result: GitHubBlobPartialClassification;
    };

export interface ClassifyGitHubBlobPathInput {
  path: string;
  byteLength?: number;
}

export interface ClassifyGitHubBlobBytesInput {
  path: string;
  bytes: Uint8Array;
  declaredByteLength?: number;
}

const MAX_CONTROL_BYTE_RATIO = 0.05;

const GENERATED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".gradle",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".terraform",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "pods",
  "target",
  "vendor",
  "vendored"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".apk",
  ".avro",
  ".avi",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".deb",
  ".dll",
  ".dmg",
  ".doc",
  ".docx",
  ".eot",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".npy",
  ".npz",
  ".o",
  ".obj",
  ".otf",
  ".pdf",
  ".pkl",
  ".pb",
  ".png",
  ".ppt",
  ".pptx",
  ".pyc",
  ".rar",
  ".rpm",
  ".so",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tif",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xz",
  ".zip",
  ".wasm"
]);

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock"
]);

const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  [0x25, 0x50, 0x44, 0x46, 0x2d],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x1f, 0x8b],
  [0x7f, 0x45, 0x4c, 0x46],
  [0x00, 0x61, 0x73, 0x6d],
  [0x4d, 0x5a],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00]
];

export function classifyGitHubBlobPath(
  input: ClassifyGitHubBlobPathInput
): GitHubBlobPathDecision {
  const normalizedPath = normalizePath(input.path);
  const pathExclusion = classifyExcludedPath(normalizedPath, input.byteLength);
  if (pathExclusion !== undefined) {
    return {
      action: "exclude",
      result: pathExclusion
    };
  }

  if (input.byteLength !== undefined) {
    if (!isValidByteLength(input.byteLength)) {
      return {
        action: "partial",
        result: {
          disposition: "partial",
          reason: "invalid_declared_size"
        }
      };
    }
    if (input.byteLength > GITHUB_BLOB_TRANSPORT_LIMIT_BYTES) {
      return {
        action: "partial",
        result: {
          disposition: "partial",
          reason: "transport_limit_exceeded"
        }
      };
    }
  }

  return {
    action: "inspect",
    reason: "content_inspection_required"
  };
}

export function classifyGitHubBlobBytes(
  input: ClassifyGitHubBlobBytesInput
): GitHubBlobClassification {
  const byteLength = input.bytes.byteLength;
  const normalizedPath = normalizePath(input.path);
  const pathExclusion = classifyExcludedPath(normalizedPath, byteLength);
  if (pathExclusion !== undefined) {
    return { ...pathExclusion, byteLength };
  }

  if (byteLength > GITHUB_BLOB_TRANSPORT_LIMIT_BYTES) {
    return partial("transport_limit_exceeded", byteLength);
  }
  if (
    input.declaredByteLength !== undefined &&
    (!isValidByteLength(input.declaredByteLength) || input.declaredByteLength !== byteLength)
  ) {
    return partial(
      isValidByteLength(input.declaredByteLength)
        ? "declared_size_mismatch"
        : "invalid_declared_size",
      byteLength
    );
  }
  if (BINARY_SIGNATURES.some((signature) => startsWith(input.bytes, signature))) {
    return excluded("known_binary_format", byteLength);
  }
  if (input.bytes.includes(0)) {
    return excluded("nul_byte", byteLength);
  }

  const controlByteCount = countControlBytes(input.bytes);
  if (controlByteCount / Math.max(byteLength, 1) > MAX_CONTROL_BYTE_RATIO) {
    return excluded("excessive_control_bytes", byteLength);
  }
  if (controlByteCount > 0) {
    return partial("ambiguous_control_bytes", byteLength);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    return partial("invalid_utf8", byteLength);
  }

  return {
    disposition: "text",
    reason: "strict_utf8_text",
    byteLength,
    text
  };
}

function classifyExcludedPath(
  normalizedPath: string,
  byteLength: number | undefined
): GitHubBlobExcludedClassification | undefined {
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment))) {
    return {
      disposition: "generated_excluded",
      reason: "generated_path"
    };
  }
  if (isMinifiedOrGeneratedFile(normalizedPath)) {
    return {
      disposition: "generated_excluded",
      reason: "minified_path"
    };
  }
  if (hasBinaryExtension(normalizedPath)) {
    return {
      disposition: "binary_excluded",
      reason: "known_binary_extension"
    };
  }
  if (
    byteLength !== undefined &&
    isValidByteLength(byteLength) &&
    byteLength > GITHUB_BLOB_TRANSPORT_LIMIT_BYTES &&
    isLockfile(normalizedPath)
  ) {
    return {
      disposition: "generated_excluded",
      reason: "large_lockfile"
    };
  }
  return undefined;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

function isMinifiedOrGeneratedFile(path: string): boolean {
  const name = basename(path);
  return (
    /\.min\.(?:c?js|mjs|css)(?:\.map)?$/u.test(name) ||
    /\.(?:css|c?js|mjs)\.map$/u.test(name) ||
    /(?:^|[._-])generated(?:[._-]|$)/u.test(name) ||
    /(?:\.designer\.cs|\.g\.cs|\.pb\.go|_pb2\.py)$/u.test(name)
  );
}

function hasBinaryExtension(path: string): boolean {
  const name = basename(path);
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex >= 0 && BINARY_EXTENSIONS.has(name.slice(extensionIndex));
}

function isLockfile(path: string): boolean {
  const name = basename(path);
  return LOCKFILE_NAMES.has(name) || name.endsWith(".lock");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isValidByteLength(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.byteLength < signature.length) {
    return false;
  }
  return signature.every((value, index) => bytes[index] === value);
}

function countControlBytes(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      count += 1;
    }
  }
  return count;
}

function excluded(
  reason:
    | "known_binary_format"
    | "nul_byte"
    | "excessive_control_bytes",
  byteLength: number
): GitHubBlobClassification {
  return {
    disposition: "binary_excluded",
    reason,
    byteLength
  };
}

function partial(
  reason:
    | "transport_limit_exceeded"
    | "declared_size_mismatch"
    | "invalid_declared_size"
    | "invalid_utf8"
    | "ambiguous_control_bytes",
  byteLength: number
): GitHubBlobClassification {
  return {
    disposition: "partial",
    reason,
    byteLength
  };
}
