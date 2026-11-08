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
  // V3: which retriever(s) found this chunk, and at which rank (before fusion)
  sources: z.array(z.object({ retriever: z.enum(["dense", "bm25", "graph"]), rank: z.number(), score: z.number(), matched: z.array(z.string()).optional() })).optional(),
});

export const GraphPathSchema = z.object({
  seeds: z.array(z.object({ key: z.string(), name: z.string(), type: z.string(), matched: z.string() })),
  edges: z.array(z.object({ source: z.string(), relation: z.string(), target: z.string(), hop: z.number(), chunks: z.array(z.string()) })),
});

export const AskResponseSchema = z.object({
  found: z.boolean(),
  answer: z.string(),
  citations: z.array(HitSchema), // the retrieved chunks the answer actually cites
  retrieved: z.array(HitSchema), // everything that was sent to the LLM (top-k)
  warnings: z.array(z.string()),
  model: z.string(),
  embeddingModel: z.string(),
  settings: z.object({
    chunkSize: z.number(),
    overlapPercent: z.number(),
    topK: z.number(),
    minParagraphLength: z.number(),
    retrievers: z.object({ dense: z.boolean(), bm25: z.boolean(), graph: z.boolean() }),
  }),
  // V3: the graph explanation (entities found in the question, edges followed, their chunks)
  graph: z.object({ available: z.boolean(), path: GraphPathSchema }).nullable(),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() }).nullable(),
  latency: z.object({ retrieval_ms: z.number(), generation_ms: z.number(), total_ms: z.number(), per_retriever_ms: z.record(z.string(), z.number().nullable()).optional() }),
  promptVersion: z.string(),
});
export type AskResponse = z.infer<typeof AskResponseSchema>;
