import { signedUrl } from "./signing";

/** Messages never contain URLs, devid or signatures. */
export class PtvError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "PtvError";
  }
}

type QueryValue = string | number | Array<string | number> | undefined;

export interface PtvClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

export interface PtvClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Resolves false when the upstream call cap is hit. */
  guard?: () => Promise<boolean>;
}

function toQuery(query: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    }
  }
  return parts.join("&");
}

export function createPtvClient(
  creds: { devId: string; apiKey: string },
  opts: PtvClientOptions = {},
): PtvClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return {
    async get<T>(path: string, query: Record<string, QueryValue> = {}): Promise<T> {
      if (opts.guard && !(await opts.guard())) throw new PtvError("PTV call cap reached");
      const qs = toQuery(query);
      const url = await signedUrl(qs ? `${path}?${qs}` : path, creds.devId, creds.apiKey);
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new PtvError("PTV request failed");
      }
      if (!res.ok) throw new PtvError(`PTV returned HTTP ${res.status}`, res.status);
      try {
        return (await res.json()) as T;
      } catch {
        throw new PtvError("PTV returned an unreadable response");
      }
    },
  };
}
