/**
 * Pipeline Version Stamp
 *
 * Computes a short hash of all prompt constants that affect pipeline output.
 * Written to pipeline_analysis and merge_checkpoints at INSERT time.
 * On resume, stored stamp is compared to current code's stamp — mismatch means
 * checkpoints are stale and a fresh run_id must be created instead of resuming.
 *
 * What's hashed:
 * - SUB_AGENT_PROMPTS (per-module sub-agent system prompts)
 * - MERGE_PROMPTS (per-module merge system prompts)
 * - ABSENCE_VERIFICATION_PROTOCOL (self-check block)
 * - DILIGENCE_CHECKLIST (category queries — affect coverage map)
 * - Absence verification Call A + Call B prompts
 *
 * Uses a simple deterministic hash (FNV-1a based) — no Node.js crypto dependency.
 * Produces a 12-char hex string, sufficient to detect any meaningful prompt change.
 */
import { SUB_AGENT_PROMPTS, ABSENCE_VERIFICATION_PROTOCOL } from "../modules/analyze-chunk.js";
import { MERGE_PROMPTS } from "../modules/merge-findings.js";
import { DILIGENCE_CHECKLIST } from "./diligence-checklist.js";
import {
  CALL_A_SYSTEM,
  CALL_B_SYSTEM,
  CALL_A_USER_INSTRUCTIONS,
  CALL_B_USER_INSTRUCTIONS,
} from "./absence-verification-prompts.js";

// ---------------------------------------------------------------------------
// Simple deterministic hash (no crypto dependency)
// FNV-1a 64-bit variant, output as 12-char hex (48 bits — collision-safe for prompt versioning)
// ---------------------------------------------------------------------------

function fnv1aHash(input: string): string {
  // FNV-1a 32-bit x2 (two independent hashes concatenated for 64 bits)
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  // Combine into 12 hex chars (6 from each half)
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return hex1 + hex2;
}

/**
 * Compute the current pipeline prompt version stamp.
 * Returns a 12-char hex string.
 */
export function computePipelineVersion(): string {
  const parts: string[] = [];

  // Sub-agent prompts (sorted by key for determinism)
  for (const key of Object.keys(SUB_AGENT_PROMPTS).sort()) {
    parts.push(`SUB_AGENT:${key}:${SUB_AGENT_PROMPTS[key]}`);
  }

  // Merge prompts (sorted by key)
  for (const key of Object.keys(MERGE_PROMPTS).sort()) {
    parts.push(`MERGE:${key}:${MERGE_PROMPTS[key]}`);
  }

  // Absence verification protocol (injected into sub-agent prompts)
  parts.push(`ABSENCE_PROTOCOL:${ABSENCE_VERIFICATION_PROTOCOL}`);

  // Diligence checklist (affects coverage map)
  for (const cat of DILIGENCE_CHECKLIST) {
    parts.push(`CHECKLIST:${cat.id}:${cat.queries.join("|")}`);
  }

  // Absence verification phase prompts (system + user instruction templates)
  parts.push(`VERIFY_CALL_A_SYS:${CALL_A_SYSTEM}`);
  parts.push(`VERIFY_CALL_B_SYS:${CALL_B_SYSTEM}`);
  parts.push(`VERIFY_CALL_A_USR:${CALL_A_USER_INSTRUCTIONS}`);
  parts.push(`VERIFY_CALL_B_USR:${CALL_B_USER_INSTRUCTIONS}`);

  return fnv1aHash(parts.join("\n"));
}

/** Cached version to avoid recomputing on every INSERT */
let _cachedVersion: string | null = null;

export function getPipelineVersion(): string {
  if (!_cachedVersion) {
    _cachedVersion = computePipelineVersion();
  }
  return _cachedVersion;
}
