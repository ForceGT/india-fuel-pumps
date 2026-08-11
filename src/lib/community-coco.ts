/**
 * Shared lookup for `src/data/community-coco-station-ids.json` — the
 * coordinate-joined crowdsourced COCO list (see
 * `../build-community-coco-list.ts`'s module doc comment for full
 * provenance). Used by the four brands with no native ownership signal of
 * their own: HPCL, JioBP, Nayara, Shell. NOT used by BPCL (live API filter)
 * or IOCL (name-substring + Swagat) — they already have their own signal.
 */
import communityCocoStationIds from "../data/community-coco-station-ids.json" with { type: "json" };

const COMMUNITY_COCO_STATION_ID_SET = new Set<string>(communityCocoStationIds.stationIds);

export function isCommunityCoco(stationId: string): boolean {
  return COMMUNITY_COCO_STATION_ID_SET.has(stationId);
}
