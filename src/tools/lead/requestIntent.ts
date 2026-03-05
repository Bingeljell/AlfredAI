function clampLeadCount(value: number): number {
  return Math.min(100, Math.max(10, value));
}

export function parseRequestedLeadCount(message: string): number {
  const directVerbPattern = /\b(?:find|get|generate)(?:\s+\w+){0,3}\s+(\d{1,3})\b/i;
  const directVerbMatch = message.match(directVerbPattern);
  if (directVerbMatch) {
    const value = Number(directVerbMatch[1]);
    if (Number.isFinite(value)) {
      return clampLeadCount(value);
    }
  }

  const nearLeadsPattern = /(\d{1,3})\s+(?:[a-z]+\s+){0,5}?leads?\b/i;
  const nearLeadsMatch = message.match(nearLeadsPattern);
  if (nearLeadsMatch) {
    const value = Number(nearLeadsMatch[1]);
    if (Number.isFinite(value)) {
      return clampLeadCount(value);
    }
  }

  return 50;
}
