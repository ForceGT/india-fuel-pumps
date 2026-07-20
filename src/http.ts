/**
 * Politeness helpers shared by every source scraper. Kept dependency-free
 * and source-agnostic.
 */

/**
 * Identifies this crawler to site operators (and lets them reach us if our
 * crawling is a problem). Update the contact if the project's public contact
 * changes.
 */
export const USER_AGENT =
  "IndiaFuelPumpsBot/0.1 (+https://github.com/ForceGT/india-fuel-pumps; contact: thakkargaurav409@gmail.com)";

/** Politeness floor between consecutive requests to the same host — every scraper in this repo uses this same delay. */
export const REQUEST_DELAY_MS = 1200;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchWithBackoffOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra headers merged into the request (User-Agent is always set). */
  headers?: Record<string, string>;
  /** Max retry attempts on 429/5xx before giving up and returning the last response. */
  maxRetries?: number;
  /** Initial backoff delay; doubles each retry. */
  initialDelayMs?: number;
  /** HTTP method; defaults to GET (fetch's own default) if omitted. */
  method?: string;
  /** Request body, e.g. a form-urlencoded string for a token POST (bpcl-provider.ts). */
  body?: string;
}

/**
 * Fetch with a descriptive User-Agent and exponential backoff on 429/5xx.
 * Never retries 4xx (other than 429) — those are our bug, not the server's.
 * Resolves to the last Response received (even if non-OK) rather than
 * throwing, so callers decide how to handle a persistent failure.
 *
 * Also retries a CONNECTION-level failure (the `fetch()` call itself
 * throwing — DNS, TCP reset, TLS handshake, timeout — no response was ever
 * received to inspect a status on) with the exact same backoff schedule as
 * a 5xx. Once `maxRetries` is exhausted, the last exception is re-thrown so
 * callers' existing catch-and-log-as-"errored" behavior is unchanged, just
 * now reached only after genuinely exhausting retries instead of on the
 * first blip.
 */
export async function fetchWithBackoff(
  url: string,
  opts: FetchWithBackoffOptions = {},
): Promise<Response> {
  const {
    fetchImpl = fetch,
    headers = {},
    maxRetries = 3,
    initialDelayMs = 2000,
    method,
    body,
  } = opts;

  let attempt = 0;
  let delay = initialDelayMs;

  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        body,
        headers: { "User-Agent": USER_AGENT, ...headers },
      });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      attempt++;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (response.ok || !retryable || attempt >= maxRetries) {
      return response;
    }
    attempt++;
    await sleep(delay);
    delay *= 2;
  }
}
