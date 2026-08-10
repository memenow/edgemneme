const MAX_MEMORY_CHUNK_ESTIMATED_TOKENS = 4_000;

export function chunkMemoryContent(content: string): string[] {
  if (content.length === 0) {
    throw new TypeError("Memory content cannot be empty.");
  }
  const chunks: string[] = [];
  let chunk = "";
  let estimatedTokens = 0;
  for (const codePoint of content) {
    const tokenCost = utf8ByteLength(codePoint);
    if (
      chunk !== "" &&
      estimatedTokens + tokenCost > MAX_MEMORY_CHUNK_ESTIMATED_TOKENS
    ) {
      chunks.push(chunk);
      chunk = "";
      estimatedTokens = 0;
    }
    chunk += codePoint;
    estimatedTokens += tokenCost;
  }
  if (chunk !== "") {
    chunks.push(chunk);
  }
  return chunks;
}

export function selectAuthoritativeMemoryChunk(
  content: string,
  chunkId: string
): string {
  const match = /^chunk-(0|[1-9][0-9]*)$/u.exec(chunkId);
  const index = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(index)) {
    throw new Error(
      "The recalled chunk ID is not a canonical memory chunk identifier."
    );
  }
  const chunk = chunkMemoryContent(content)[index];
  if (chunk === undefined) {
    throw new Error(
      "The recalled chunk ID does not exist in the authoritative memory content."
    );
  }
  return chunk;
}

function utf8ByteLength(codePoint: string): number {
  const value = codePoint.codePointAt(0);
  if (value === undefined) {
    return 0;
  }
  if (value <= 0x7f) {
    return 1;
  }
  if (value <= 0x7ff) {
    return 2;
  }
  if (value <= 0xffff) {
    return 3;
  }
  return 4;
}
