/**
 * Category paths and prefix-containment authorization (Architecture §2.4, §6.3).
 *
 * Categories are dotted codes of 1–4 levels ("105", "105.04", "105.04.03").
 * The authorization rule is prefix containment: a grant on "105" covers
 * "105.04.03". We normalize each code to a fixed-width, delimiter-terminated
 * materialized path so containment is a simple, index-friendly string prefix
 * test instead of a recursive query.
 *
 *   "105.04.03" -> "0105.0004.0003."
 *   "105"       -> "0105."
 *
 * containment: path(case) starts with path(grant)  ⇔  case is within grant.
 * Because each segment is fixed width and the path is dot-terminated,
 * "105" does not spuriously match "1050" (paths "0105." vs "1050.").
 */

const SEGMENT_WIDTH = 4;
const MAX_LEVELS = 4;

export function normalizePath(displayCode: string): string {
  const segments = displayCode.split(".");
  if (segments.length < 1 || segments.length > MAX_LEVELS) {
    throw new Error(`Category "${displayCode}" must have 1–${MAX_LEVELS} levels`);
  }
  return (
    segments
      .map((seg) => {
        if (!/^\d+$/.test(seg)) throw new Error(`Category segment "${seg}" must be numeric`);
        if (seg.length > SEGMENT_WIDTH) {
          throw new Error(`Category segment "${seg}" exceeds ${SEGMENT_WIDTH} digits`);
        }
        return seg.padStart(SEGMENT_WIDTH, "0");
      })
      .join(".") + "."
  );
}

export function levelOf(displayCode: string): number {
  return displayCode.split(".").length;
}

/**
 * True iff `caseCode` falls within `grantCode` (equal or a descendant).
 * Pure function form, used by tests and by the SQL prefix test at query time.
 */
export function isWithin(caseCode: string, grantCode: string): boolean {
  return normalizePath(caseCode).startsWith(normalizePath(grantCode));
}
