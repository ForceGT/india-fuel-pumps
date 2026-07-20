/**
 * Phase 3 of the scraper/grade-filter decoupling plan (see
 * `~/.claude/plans/https-github-com-forcegt-india-fuel-pump-mutable-avalanche.md`
 * §2) — the `Provider` plug-in interface that de-duplicates the three
 * near-identical census orchestrators (`run-hpcl-full-census.ts`,
 * `run-iocl-full-census.ts`, `run-bpcl-full-census.ts`) behind one generic
 * runner (`run-provider.ts`).
 *
 * A `Provider` owns exactly two brand-specific concerns:
 *  - `discover(opts)`: enumerate the work (HPCL/IOCL: every outlet `/Home`
 *    URL from a sitemap walk; BPCL: every route chunk + initial grid cell).
 *  - `process(unit, ctx)`: turn ONE unit of work into zero or more
 *    grade-agnostic `RawOutletRecord`s, or report a followup (BPCL's
 *    adaptive grid subdivision on saturation).
 *
 * Everything else — the worker pool, politeness pacing, resumability
 * (done-set + staleness), the serialized JSONL writer, and the two output
 * files (`{slug}-raw.jsonl` / `{slug}-worklog.jsonl`) — is owned by the
 * generic `runProvider` in `run-provider.ts`, not by any individual
 * provider. HPCL/IOCL's `process()` never returns `followups` — they are
 * simply the degenerate fixed-list case of the same dynamic queue BPCL uses
 * for its adaptive grid.
 */
import type { RawOutletRecord, WorkLogRecord } from "./types.js";
import type { fetchWithBackoff } from "./http.js";

/** One unit of crawl work. `id` is the resumability key (HPCL/IOCL: sourceUrl; BPCL: routeChunkId/cellId) and must be stable + collision-free across a provider's entire discover() stream. */
export interface WorkUnit {
  id: string;
  payload: unknown;
}

/**
 * The outcome of processing one `WorkUnit`. `status` reuses
 * `WorkLogRecord["status"]` directly — the runner's own resumability
 * check is `status === "ok" || status === "empty"` (see
 * `run-provider.ts`'s `computeDoneWorkUnitIds`): both mean "this unit was
 * fully processed, don't retry it," regardless of whether it produced any
 * records. `httpFailed` / `parsedNull` / `errored` are always retried on a
 * resumed run, matching every existing brand's resumability behavior today.
 */
export interface ProcessResult {
  status: WorkLogRecord["status"];
  detail?: string;
  /** 0..N grade-agnostic outlet records this unit yielded. */
  records: RawOutletRecord[];
  /** New work discovered while processing this unit (BPCL: subdivided grid cells on saturation). Never set by HPCL/IOCL. */
  followups?: WorkUnit[];
  /** BPCL adaptive-grid-subdivision hint only, carried straight into the WorkLogRecord. */
  saturated?: boolean;
}

export interface ProviderContext {
  /** Same `fetchWithBackoff` every scraper in this repo already uses — injected so tests can swap in a stub without a real network call. */
  fetch: typeof fetchWithBackoff;
  /** Returns the current instant as an ISO string — injected so tests can pin time. */
  now: () => string;
}

export interface Provider {
  brand: string;
  /** Lowercase brand slug, used for output filenames (`{slug}-raw.jsonl` etc.) and env-var-free CLI logging. */
  slug: string;
  /**
   * Optional one-time setup before discovery/processing starts (BPCL: fetch
   * the initial OAuth token, so a broken auth setup fails fast before any
   * work is attempted — mirrors today's `run-bpcl-full-census.ts` main()).
   * HPCL/IOCL don't need this.
   */
  init?(ctx: ProviderContext): Promise<void>;
  /** Enumerate every unit of work. `opts` carries brand-specific string knobs (e.g. a state allow-list override) — most configuration lives in the provider's own construction-time closure instead. */
  discover(opts: Record<string, string>): AsyncIterable<WorkUnit>;
  process(unit: WorkUnit, ctx: ProviderContext): Promise<ProcessResult>;
}
