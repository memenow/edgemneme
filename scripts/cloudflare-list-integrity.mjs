function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exactKeys(value, expectedKeys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(`${label} has an unsupported shape.`);
  }
}

export function validatePaginatedListPage(
  envelope,
  { requestedPage, requestedPerPage, previousTotals, label }
) {
  if (!Array.isArray(envelope?.result)) {
    throw new Error(`${label} result is invalid.`);
  }
  const resultInfo = record(envelope.result_info, `${label} result_info`);
  exactKeys(
    resultInfo,
    ["page", "per_page", "count", "total_count", "total_pages"],
    `${label} result_info`
  );
  const page = safeInteger(resultInfo.page, 1, `${label} page`);
  const perPage = safeInteger(resultInfo.per_page, 1, `${label} per_page`);
  const count = safeInteger(resultInfo.count, 0, `${label} count`);
  const totalCount = safeInteger(resultInfo.total_count, 0, `${label} total_count`);
  const totalPages = safeInteger(resultInfo.total_pages, 0, `${label} total_pages`);
  if (page !== requestedPage || perPage !== requestedPerPage) {
    throw new Error(`${label} pagination does not match the requested page.`);
  }
  if (count !== envelope.result.length || count > perPage || totalCount < count) {
    throw new Error(`${label} page count is inconsistent.`);
  }
  const computedTotalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / perPage);
  if (totalPages !== computedTotalPages) {
    throw new Error(`${label} total page metadata is inconsistent.`);
  }
  if (
    previousTotals !== undefined &&
    (previousTotals.totalCount !== totalCount || previousTotals.totalPages !== totalPages)
  ) {
    throw new Error(`${label} totals changed between pages.`);
  }
  if (totalPages === 0) {
    if (page !== 1 || count !== 0) {
      throw new Error(`${label} empty pagination is inconsistent.`);
    }
  } else {
    if (page > totalPages) {
      throw new Error(`${label} returned a page beyond the declared total.`);
    }
    const expectedCount = page < totalPages
      ? perPage
      : totalCount - perPage * (totalPages - 1);
    if (count !== expectedCount) {
      throw new Error(`${label} page size is inconsistent with the declared total.`);
    }
  }
  return {
    items: envelope.result,
    totals: { totalCount, totalPages }
  };
}

export function validateSinglePageList(
  envelope,
  label,
  { allowZeroPerPageWithUnfilteredTotals = false } = {}
) {
  if (!Array.isArray(envelope?.result)) {
    throw new Error(`${label} result is invalid.`);
  }
  if (envelope.result_info === undefined) {
    return envelope.result;
  }
  const resultInfo = record(envelope.result_info, `${label} result_info`);
  const allowedKeys = new Set([
    "page",
    "per_page",
    "count",
    "total_count",
    "total_pages"
  ]);
  if (Object.keys(resultInfo).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} result_info has an unsupported shape.`);
  }
  const page = resultInfo.page === undefined
    ? undefined
    : safeInteger(resultInfo.page, 1, `${label} page`);
  const perPage = resultInfo.per_page === undefined
    ? undefined
    : safeInteger(resultInfo.per_page, 0, `${label} per_page`);
  const count = resultInfo.count === undefined
    ? undefined
    : safeInteger(resultInfo.count, 0, `${label} count`);
  const totalCount = resultInfo.total_count === undefined
    ? undefined
    : safeInteger(resultInfo.total_count, 0, `${label} total_count`);
  const totalPages = resultInfo.total_pages === undefined
    ? undefined
    : safeInteger(resultInfo.total_pages, 0, `${label} total_pages`);
  if (
    (page !== undefined && page !== 1) ||
    (count !== undefined && count !== envelope.result.length) ||
    (perPage !== undefined && envelope.result.length > perPage) ||
    (totalCount !== undefined && totalCount < envelope.result.length) ||
    (
      perPage === 0 &&
      !allowZeroPerPageWithUnfilteredTotals &&
      (
        (totalCount !== undefined && totalCount !== 0) ||
        (totalPages !== undefined && totalPages !== 0)
      )
    ) ||
    (
      totalPages !== undefined &&
      totalCount !== undefined &&
      perPage !== undefined &&
      perPage > 0 &&
      totalPages !== (totalCount === 0 ? 0 : Math.ceil(totalCount / perPage))
    )
  ) {
    throw new Error(`${label} single-page metadata is inconsistent.`);
  }
  return envelope.result;
}

export function addUniqueIdentity(identities, identity, label) {
  if (identities.has(identity)) {
    throw new Error(`${label} is duplicated.`);
  }
  identities.add(identity);
}
