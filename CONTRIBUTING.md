# Contributing

Thanks for considering a contribution. This is a small, focused project — most
contributions fall into one of three buckets below.

## Reporting a wrong or stale pump

If a specific outlet is closed, relocated, or shows a wrong price/address, please
[open an issue](https://github.com/ForceGT/india-fuel-pumps/issues/new) with:

- the outlet's `stationId` or `sourceUrl` (both are in the raw record — see
  [docs/DATA-DICTIONARY.md](./docs/DATA-DICTIONARY.md)), and
- what's wrong and, if you know it, what it should say instead.

Note that this repo doesn't hand-edit data — every record is overwritten by the next
scheduled scrape (daily). If the *source* is wrong, the fix has to happen upstream at
the OMC's own locator; if *this repo's parsing* of a correct source is wrong, that's a
bug we can actually fix — please say which case it looks like.

## Adding a new brand

Other fuel marketers (e.g. a state-run brand not yet covered) are welcome as new
`Provider` implementations. Before writing code:

1. Read [src/provider.ts](./src/provider.ts) — the interface every brand implements
   (`init`, `discover`, `process`).
2. Read [docs/shell-api.md](./docs/shell-api.md) or
   [docs/nayara-api.md](./docs/nayara-api.md) for a full worked example of
   documenting a locator's backend API, from first request to final record shape.
3. Read [docs/METHODOLOGY.md](./docs/METHODOLOGY.md) — a new provider must respect the
   same grade-agnostic, no-reconciliation, live-source-wins rules as every existing
   one. A PR that adds classification logic, city/state normalization, or synthesizes
   fields the source didn't actually report will be asked to remove them.
4. Model your provider on `src/providers/shell-provider.ts` or
   `src/providers/nayara-provider.ts` — the two most recently added, and the most
   representative of the current conventions (worklog-based resumability,
   rate-limiting via `src/http.ts`, parser tested against captured fixtures with zero
   live network calls).

For the concrete mechanical checklist — which files to create, where to register
the new brand's slug, which CI job/`needs:` arrays to extend — see
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md#adding-a-new-brand). See
[docs/RUNBOOK.md](./docs/RUNBOOK.md) for how to actually run a census locally
once your provider is written, including environment variables and concurrency
limits per brand.

## Code changes

- `npm run typecheck` and `npm run test` should both pass before opening a PR.
- Parsers must be tested against real, captured HTML/JSON fixtures — no live network
  calls in tests (see any existing file in `src/parsers/` for the pattern).
- Keep the [grade-agnostic boundary](./docs/METHODOLOGY.md#why-the-dataset-has-no-grade-classification)
  in mind for anything touching `RawOutletRecord` — it's enforced at the type level on
  purpose.

## What's not being accepted right now

- A crowdsourced "was this pump available?" feedback mechanism is planned but not yet
  designed — if you want to build it, open an issue to discuss the design first
  rather than sending a PR cold.
- Grade/ethanol classification of any kind belongs in a downstream consumer (e.g.
  [E0 Finder](https://e0fuel.in)), not this repo — see
  [docs/METHODOLOGY.md](./docs/METHODOLOGY.md) for why.
