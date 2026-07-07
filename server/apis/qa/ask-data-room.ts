import { api, z, anthropic, postgres } from "@superblocksteam/sdk-api";

const ANTHROPIC_ID = "8ccd43c8-5340-4ae2-8eee-7cbb3896df53";
const IC_DILIGENCE_DB = "ba09e2b9-2715-4460-8131-896f50b0c414";
const QA_MODEL = "claude-sonnet-4-6";
const QA_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const ChunkInputSchema = z.object({
  file_name: z.string(),
  chunk_index: z.number(),
  content: z.string(),
  rank: z.number(),
});

const AnthropicResponseSchema = z.object({
  id: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export default api({
  name: "AskDataRoom",
  description: "Answers questions about deal documents using RAG with reranking",

  integrations: {
    ai: anthropic(ANTHROPIC_ID),
    db: postgres(IC_DILIGENCE_DB),
  },

  input: z.object({
    dealId: z.string(),
    dealName: z.string(),
    dealSector: z.string().nullable().optional(),
    question: z.string(),
    conversationHistory: z.array(MessageSchema),
    candidateChunks: z.array(ChunkInputSchema),
  }),

  output: z.object({
    answer: z.string(),
    sourceDocs: z.array(z.string()),
    tokensUsed: z.object({
      input: z.number(),
      output: z.number(),
    }),
  }),

  async run(ctx, { dealId, dealName, dealSector, question, conversationHistory, candidateChunks }) {
    // -----------------------------------------------------------------------
    // Step 1: Rerank candidate chunks if we have more than 8
    // -----------------------------------------------------------------------
    let relevantChunks = candidateChunks;

    if (candidateChunks.length > 8) {
      const chunkSummaries = candidateChunks.map((c, i) =>
        `[${i}] (${c.file_name}, chunk ${c.chunk_index}): ${c.content.slice(0, 300)}...`
      ).join("\n\n");

      const rerankResult = await ctx.integrations.ai.apiRequest(
        {
          method: "POST",
          path: "/v1/messages",
          body: {
            model: QA_MODEL,
            max_tokens: 512,
            system: [
              {
                type: "text",
                text: "You are a document relevance ranker. Given a question and a list of document chunks, return ONLY a JSON array of the indices (0-based) of the 6-8 most relevant chunks for answering the question. Return just the array, nothing else. Example: [0, 3, 7, 12]",
                cache_control: { type: "ephemeral" },
              },
            ],
            messages: [
              {
                role: "user",
                content: `Question: ${question}\n\nChunks:\n${chunkSummaries}`,
              },
            ],
          },
        },
        { response: AnthropicResponseSchema },
        { label: "Rerank document chunks" }
      );

      const rerankText = rerankResult.content.find(c => c.type === "text")?.text ?? "[]";
      try {
        const match = rerankText.match(/\[[\d,\s]+\]/);
        if (match) {
          const indices: number[] = JSON.parse(match[0]);
          relevantChunks = indices
            .filter(i => i >= 0 && i < candidateChunks.length)
            .map(i => candidateChunks[i]);
        }
      } catch {
        // If parsing fails, use top 8 by rank
        relevantChunks = candidateChunks.slice(0, 8);
      }
    }

    // -----------------------------------------------------------------------
    // Step 2: Build context and generate answer
    // -----------------------------------------------------------------------
    const documentContext = relevantChunks
      .map(c => `<document name="${c.file_name}" chunk="${c.chunk_index}">\n${c.content}\n</document>`)
      .join("\n\n");

    const systemPrompt = [
      `You are a diligence analyst assistant for the deal "${dealName}"${dealSector ? ` in the ${dealSector} sector` : ""}.`,
      "You have access to excerpts from the deal's data room documents.",
      "",
      "INSTRUCTIONS:",
      "- Answer the user's question based on the document excerpts provided below.",
      "- Be specific and precise. Cite which document(s) support your answer by name.",
      "- If the excerpts don't contain enough information, say so clearly and suggest what additional documents or data would help.",
      "- Use markdown formatting for clarity (headers, bullet points, bold for key figures).",
      "- When quoting numbers, include the exact figure and the document source.",
      "- Be direct and professional — this is for an investment committee audience.",
      "",
      "DOCUMENT EXCERPTS:",
      documentContext,
    ].join("\n");

    // Build messages: conversation history + current question
    const messages = [
      ...conversationHistory.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: question },
    ];

    const result = await ctx.integrations.ai.apiRequest(
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          model: QA_MODEL,
          max_tokens: QA_MAX_TOKENS,
          system: [
            {
              type: "text",
              text: systemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages,
        },
      },
      { response: AnthropicResponseSchema },
      { label: "Generate Q&A answer" }
    );

    const answer = result.content
      .filter(c => c.type === "text" && c.text)
      .map(c => c.text!)
      .join("");

    // Extract unique source document names
    const sourceDocs = [...new Set(relevantChunks.map(c => c.file_name))];

    return {
      answer,
      sourceDocs,
      tokensUsed: {
        input: result.usage.input_tokens,
        output: result.usage.output_tokens,
      },
    };
  },
});
