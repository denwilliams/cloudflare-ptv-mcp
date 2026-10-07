const sha256 = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

/** Constant-time check of the `token` query parameter against the MCP_TOKEN secret. */
export async function tokenValid(url: URL, expected: string): Promise<boolean> {
  const supplied = url.searchParams.get("token");
  if (!supplied || !expected) return false;
  const [a, b] = await Promise.all([sha256(supplied), sha256(expected)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The only form of a request URL that may be logged. */
export function redactedPath(url: URL): string {
  return url.pathname;
}
