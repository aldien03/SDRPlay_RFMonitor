export interface BoundedPage {
  offset: number;
  limit: number;
}

export function boundedPage(
  offset: number,
  limit: number,
  maximumLimit: number,
  defaultLimit: number,
): BoundedPage {
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : defaultLimit;
  return {
    offset: safeOffset,
    limit: Math.max(1, Math.min(maximumLimit, requestedLimit)),
  };
}
