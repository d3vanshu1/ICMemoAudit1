/**
 * Shared helper: extract an ISO date (YYYY-MM-DD) from a filename prefix.
 *
 * Accepts:
 *   - YYYY-MM-DD followed by separator (space, _, -, .)
 *   - YYYYMMDD followed by separator (space, _, -, .)
 *   - YYYY_MM_DD or YYYY.MM.DD followed by separator
 *
 * Validates month 01–12 and day 01–31 to reject 8-digit non-dates.
 * Returns null for filenames without a valid date prefix.
 */

// Matches YYYY[-_.]?MM[-_.]?DD followed by a word-boundary separator
const DATE_PREFIX_RE = /^(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[\s_.\-]/;

export function parseDateFromFileName(fileName: string): string | null {
  const match = fileName.match(DATE_PREFIX_RE);
  if (!match) return null;

  const y = match[1];
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);

  // Validate ranges — reject non-dates like "20260000" or "99991345"
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;

  // Return ISO format
  return `${y}-${match[2]}-${match[3]}`;
}
