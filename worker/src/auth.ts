const sha256 = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

/**
 * Accepts the shared secret as either an `x-api-key` header or a `?token=` query parameter.
 * Both are compared in constant time (and both are always compared, so a wrong one doesn't
 * change the timing of the other). Fails closed when MCP_TOKEN is unset.
 */
export async function tokenValid(url: URL, expected: string, headers?: Headers): Promise<boolean> {
  if (!expected) return false;
  const supplied = [headers?.get("x-api-key"), url.searchParams.get("token")].filter((v): v is string => !!v);
  if (supplied.length === 0) return false;
  const want = await sha256(expected);
  const results = await Promise.all(
    supplied.map(async (v) => crypto.subtle.timingSafeEqual(await sha256(v), want)),
  );
  return results.some(Boolean);
}

/** The only form of a request URL that may be logged. */
export function redactedPath(url: URL): string {
  return url.pathname;
}
