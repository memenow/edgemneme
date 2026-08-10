const MAX_LINK_HEADER_CHARACTERS = 32 * 1024;

interface ParsedLink {
  target: string;
  relations: Set<string>;
}

export function parseNextPageLink(
  link: string | null,
  currentUrl: URL
): URL | undefined {
  if (link === null || link.trim() === "") {
    return undefined;
  }
  if (link.length > MAX_LINK_HEADER_CHARACTERS) {
    throw invalidPagination();
  }
  const links = parseLinkHeader(link);
  let nextUrl: URL | undefined;
  for (const parsed of links) {
    if (!parsed.relations.has("next")) {
      continue;
    }
    if (nextUrl !== undefined) {
      throw invalidPagination();
    }
    let candidate: URL;
    try {
      candidate = new URL(parsed.target, currentUrl);
    } catch {
      throw invalidPagination();
    }
    const currentPage = parsePositiveSafeInteger(
      currentUrl.searchParams.get("page") ?? "1"
    );
    const candidatePage = parsePositiveSafeInteger(
      candidate.searchParams.get("page") ?? "1"
    );
    if (
      currentPage === null ||
      candidatePage === null ||
      candidatePage !== currentPage + 1
    ) {
      throw invalidPagination();
    }
    nextUrl = candidate;
  }
  return nextUrl;
}

export function parsePositiveSafeInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseLinkHeader(value: string): ParsedLink[] {
  const parsed: ParsedLink[] = [];
  let offset = 0;
  while (offset < value.length) {
    offset = skipOptionalWhitespace(value, offset);
    if (value[offset] !== "<") {
      throw invalidPagination();
    }
    const targetEnd = value.indexOf(">", offset + 1);
    if (targetEnd < 0) {
      throw invalidPagination();
    }
    const target = value.slice(offset + 1, targetEnd);
    if (!isUriReference(target)) {
      throw invalidPagination();
    }
    offset = targetEnd + 1;
    let relations: Set<string> | null = null;
    for (;;) {
      offset = skipOptionalWhitespace(value, offset);
      if (value[offset] !== ";") {
        break;
      }
      offset = skipOptionalWhitespace(value, offset + 1);
      const nameStart = offset;
      while (offset < value.length && isHttpTokenCharacter(value[offset] ?? "")) {
        offset += 1;
      }
      if (offset === nameStart) {
        throw invalidPagination();
      }
      const name = value.slice(nameStart, offset).toLowerCase();
      offset = skipOptionalWhitespace(value, offset);
      let parameterValue: string | undefined;
      if (value[offset] === "=") {
        offset = skipOptionalWhitespace(value, offset + 1);
        if (value[offset] === '"') {
          const quoted = readQuotedString(value, offset);
          parameterValue = quoted.value;
          offset = quoted.nextOffset;
        } else {
          const valueStart = offset;
          while (
            offset < value.length &&
            isHttpTokenCharacter(value[offset] ?? "")
          ) {
            offset += 1;
          }
          if (offset === valueStart) {
            throw invalidPagination();
          }
          parameterValue = value.slice(valueStart, offset);
        }
      }
      if (name === "rel") {
        if (relations !== null || parameterValue === undefined) {
          throw invalidPagination();
        }
        relations = parseRelationTypes(parameterValue);
      }
    }
    parsed.push({ target, relations: relations ?? new Set<string>() });
    offset = skipOptionalWhitespace(value, offset);
    if (offset === value.length) {
      return parsed;
    }
    if (value[offset] !== ",") {
      throw invalidPagination();
    }
    offset += 1;
    if (skipOptionalWhitespace(value, offset) === value.length) {
      throw invalidPagination();
    }
  }
  throw invalidPagination();
}

function readQuotedString(
  value: string,
  openingQuoteOffset: number
): { value: string; nextOffset: number } {
  let offset = openingQuoteOffset + 1;
  let result = "";
  while (offset < value.length) {
    const character = value[offset] ?? "";
    if (character === '"') {
      return { value: result, nextOffset: offset + 1 };
    }
    if (character === "\\") {
      offset += 1;
      const escaped = value[offset];
      if (escaped === undefined || !isQuotedTextCharacter(escaped, true)) {
        throw invalidPagination();
      }
      result += escaped;
      offset += 1;
      continue;
    }
    if (!isQuotedTextCharacter(character, false)) {
      throw invalidPagination();
    }
    result += character;
    offset += 1;
  }
  throw invalidPagination();
}

function isQuotedTextCharacter(character: string, escaped: boolean): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  if (escaped) {
    return (
      codePoint === 9 ||
      (codePoint >= 32 && codePoint <= 126) ||
      (codePoint >= 128 && codePoint <= 255)
    );
  }
  return (
    codePoint === 9 ||
    codePoint === 32 ||
    codePoint === 33 ||
    (codePoint >= 35 && codePoint <= 91) ||
    (codePoint >= 93 && codePoint <= 126) ||
    (codePoint >= 128 && codePoint <= 255)
  );
}

function parseRelationTypes(value: string): Set<string> {
  if (value === "" || value.trim() !== value || value.includes("\t")) {
    throw invalidPagination();
  }
  const relations = new Set<string>();
  for (const relation of value.split(/ +/u)) {
    const registered = /^[a-z][a-z0-9.-]*$/u.test(relation);
    if (!registered && !isAbsoluteRelationUri(relation)) {
      throw invalidPagination();
    }
    if (relations.has(relation)) {
      throw invalidPagination();
    }
    relations.add(relation);
  }
  return relations;
}

function isAbsoluteRelationUri(value: string): boolean {
  if (!isUriReference(value)) {
    return false;
  }
  try {
    return new URL(value).protocol !== "";
  } catch {
    return false;
  }
}

function isUriReference(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (
    !/^[A-Za-z0-9\-._~!$&'()*+,;=:%@/?#\[\]]+$/u.test(value)
  ) {
    return false;
  }
  for (let offset = value.indexOf("%"); offset >= 0; offset = value.indexOf("%", offset + 1)) {
    if (!/^[A-Fa-f0-9]{2}$/u.test(value.slice(offset + 1, offset + 3))) {
      return false;
    }
  }
  return true;
}

function skipOptionalWhitespace(value: string, offset: number): number {
  while (value[offset] === " " || value[offset] === "\t") {
    offset += 1;
  }
  return offset;
}

function isHttpTokenCharacter(character: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/u.test(character);
}

function invalidPagination(): TypeError {
  return new TypeError("The GitHub pagination Link header is invalid.");
}
