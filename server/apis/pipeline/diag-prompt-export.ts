/**
 * Diagnostic API — Verbatim Prompt Export
 *
 * Returns the exact text of key prompt components for audit:
 *   - DENSE_SUFFIX (output rules appended to every sub-agent)
 *   - ABSENCE_VERIFICATION_PROTOCOL (self-check block)
 *   - LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY (omission_audit scope limiter)
 *   - SUB_AGENT_PROMPTS (per-module system prompts)
 *
 * No DB access. Pure code-reading: imports from analyze-chunk.ts and returns verbatim.
 */
import { api, z } from "@superblocksteam/sdk-api";
import {
  SUB_AGENT_PROMPTS,
  ABSENCE_VERIFICATION_PROTOCOL,
  LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY,
  DENSE_SUFFIX,
} from "../modules/analyze-chunk.js";

// DENSE_SUFFIX is now exported from analyze-chunk.ts and imported above.

const PromptEntrySchema = z.object({
  moduleId: z.string(),
  prompt: z.string(),
});

export default api({
  name: "DiagPromptExport",
  description: "Returns verbatim text of DENSE_SUFFIX, ABSENCE_VERIFICATION_PROTOCOL, and per-module prompts",

  input: z.object({
    moduleId: z.string().nullable().optional().describe("If provided, return only this module's prompt. Otherwise all."),
  }),

  output: z.object({
    denseSuffix: z.string(),
    absenceVerificationProtocol: z.string(),
    legalTaxRegulatoryBoundary: z.string(),
    modulePrompts: z.array(PromptEntrySchema),
    moduleCount: z.number(),
  }),

  async run(_ctx, { moduleId }) {
    const modulePrompts: Array<{ moduleId: string; prompt: string }> = [];

    if (moduleId) {
      const prompt = SUB_AGENT_PROMPTS[moduleId];
      if (prompt) {
        modulePrompts.push({ moduleId, prompt });
      }
    } else {
      for (const [id, prompt] of Object.entries(SUB_AGENT_PROMPTS)) {
        modulePrompts.push({ moduleId: id, prompt });
      }
    }

    return {
      denseSuffix: DENSE_SUFFIX,
      absenceVerificationProtocol: ABSENCE_VERIFICATION_PROTOCOL,
      legalTaxRegulatoryBoundary: LEGAL_TAX_REGULATORY_SCOPE_BOUNDARY,
      modulePrompts,
      moduleCount: modulePrompts.length,
    };
  },
});
