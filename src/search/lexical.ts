export interface NormalizedLexicalQuery {
  normalizedText: string;
  tokens: string[];
  ftsQuery: string | null;
}

const MAX_TOKENS = 20;
const MAX_TOKEN_LENGTH = 128;

export function normalizeLexicalQuery(query: string): NormalizedLexicalQuery {
  const normalizedText = query.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of normalizedText.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0]?.slice(0, MAX_TOKEN_LENGTH);
    if (token === undefined || seen.has(token)) {
      continue;
    }
    tokens.push(token);
    seen.add(token);
    if (tokens.length === MAX_TOKENS) {
      break;
    }
  }
  return {
    normalizedText,
    tokens,
    ftsQuery: tokens.length === 0 ? null : tokens.map(quoteFtsToken).join(" AND ")
  };
}

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}
