import { api, z, anthropic } from "@superblocksteam/sdk-api";
import {
  EXTRACTION_MODEL,
  UNIVERSAL_EXTRACTION_PROMPT,
  injectClaimIds,
  sanitizeBraces,
} from "../pipeline/extraction-prompt.js";

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------
const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SUB_AGENT_MAX_TOKENS = 8000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const PageImageSchema = z.object({
  pageNumber: z.number(),
  text: z.string(),
  imageBase64: z.string(),
  mediaType: z.literal("image/jpeg"),
});

const ChunkSchema = z.object({
  label: z.string(),
  sourceFile: z.string(),
  text: z.string(),
  pageImages: z.array(PageImageSchema),
});

// Prompt imported from shared module: ../pipeline/extraction-prompt.ts

// injectClaimIds, sanitizeBraces imported from shared module

function buildMultimodalContent(
  chunk: z.infer<typeof ChunkSchema>
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const page of chunk.pageImages) {
    if (page.imageBase64) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: page.mediaType,
          data: page.imageBase64,
        },
      });
    }
  }

  if (chunk.text) {
    blocks.push({
      type: "text",
      text: `--- Extracted text from "${sanitizeBraces(chunk.label)}" ---\n\n${sanitizeBraces(chunk.text)}`,
    });
  }

  blocks.push({
    type: "text",
    text: `The above is "${sanitizeBraces(chunk.label)}" (source: ${sanitizeBraces(chunk.sourceFile)}). Perform a comprehensive extraction now using both the page images and the extracted text.`,
  });

  return blocks;
}

// ---------------------------------------------------------------------------
// Anthropic response schema
// ---------------------------------------------------------------------------
const MessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    })
  ),
  model: z.string(),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// API — Universal extraction for a single chunk
// ---------------------------------------------------------------------------
export default api({
  name: "UniversalExtract",
  description: "Performs comprehensive single-pass extraction on a document chunk for all analysis modules",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
  },

  input: z.object({
    chunkIndex: z.number(),
    totalChunks: z.number(),
    chunk: ChunkSchema,
    model: z.string().nullable().optional(),
  }),

  output: z.object({
    label: z.string(),
    extraction: z.string(),
    chunkIndex: z.number(),
    sourceFile: z.string(),
  }),

  async run(ctx, { chunkIndex, totalChunks, chunk, model }) {
    const useModel = model || EXTRACTION_MODEL;
    const content = buildMultimodalContent(chunk);
    const label = `Universal extract: ${sanitizeBraces(chunk.label)} (${chunkIndex + 1}/${totalChunks})`;

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: useModel,
          max_tokens: SUB_AGENT_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: UNIVERSAL_EXTRACTION_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content }],
        },
      },
      { response: MessageResponseSchema },
      { label }
    );

    const textBlock = result.content.find(
      (c: { type: string }) => c.type === "text"
    );
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`No text content in Anthropic response for chunk ${chunkIndex}`);
    }

    // Inject stable claim IDs (c0-0, c0-1, c1-0, …) before wrapping in markdown
    const rawText = textBlock.text.trim();
    const idTaggedText = injectClaimIds(rawText, chunkIndex);

    const extraction = `### Universal Extraction from: ${sanitizeBraces(chunk.label)}\n\n${sanitizeBraces(idTaggedText)}`;

    return {
      label: sanitizeBraces(chunk.label),
      extraction,
      chunkIndex,
      sourceFile: sanitizeBraces(chunk.sourceFile),
    };
  },
});
