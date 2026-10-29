// Contracts, defined once with Zod: what the LLM must return, and what the API returns.
import { z } from "zod";

/** The LLM answer. Validated before it reaches the UI. */
export const LlmAnswerSchema = z
  .object({
    found: z.boolean(), // false when the excerpts do not contain the answer
    answer: z.string().min(1).max(3000),
    citations: z.array(z.string().max(200)).max(20), // chunk ids, e.g. "manual.txt#0012"
  })
  .strict();
export type LlmAnswer = z.infer<typeof LlmAnswerSchema>;

export const AskRequestSchema = z
  .object({
    question: z.string(),
    docs: z.array(z.string().max(130)).max(50),
  })
  .strict();

export const HitSchema = z.object({
  id: z.string(),
  doc: z.string(),
  index: z.number(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  score: z.number(),
  rank: z.number(),
});

export const AskResponseSchema = z.object({
  found: z.boolean(),
  answer: z.string(),
  citations: z.array(HitSchema), // the retrieved chunks the answer actually cites
  retrieved: z.array(HitSchema), // everything that was sent to the LLM (top-k)
  warnings: z.array(z.string()),
  model: z.string(),
  embeddingModel: z.string(),
  settings: z.object({ chunkSize: z.number(), overlapPercent: z.number(), topK: z.number(), minParagraphLength: z.number() }),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() }).nullable(),
  latency: z.object({ retrieval_ms: z.number(), generation_ms: z.number(), total_ms: z.number() }),
  promptVersion: z.string(),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;
