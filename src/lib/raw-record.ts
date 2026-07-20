/**
 * Shared metadata -> `RawOutletRecord` assembly, used by every `Provider`'s
 * `process()` (see ../provider.ts). Every brand's parser already produces
 * the same outlet-metadata shape (parsers/{hpcl,iocl,bpcl}.ts) — building
 * the final `RawOutletRecord` from that + a brand's own `products` list is
 * identical across brands, so it lives here once instead of being
 * copy-pasted into three provider files.
 */
import type { RawOutletRecord, RawProduct } from "../types.js";

/** Every RawOutletRecord field except the ones a provider attaches separately (schemaVersion is constant; products come from a brand-specific price source). */
export type OutletMetadata = Omit<RawOutletRecord, "schemaVersion" | "products">;

export function buildRawRecord(metadata: OutletMetadata, products: RawProduct[]): RawOutletRecord {
  return { schemaVersion: 1, ...metadata, products };
}

/** `Map<name, priceInr>` (HPCL/IOCL's price-fragment shape) -> `RawProduct[]`. */
export function priceMapToProducts(prices: Map<string, number | null>): RawProduct[] {
  return [...prices].map(([name, priceInr]) => ({ name, priceInr }));
}
