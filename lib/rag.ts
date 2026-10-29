// The two-phase RAG pipeline, answering side:
// question -> embedding -> top-k chunks -> prompt (instructions + excerpts + question) -> LLM -> checked answer.
import "server-only";
import { checkDocId } from "./docs";
import { embeddingModelName } from "./embeddings";
import { AppError } from "./errors";
import { generateAnswer, llmModel } from "./llm";
import { logQuery } from "./log";
import { buildUserPrompt, PROMPT_VERSION } from "./prompt";
import { AskResponseSchema, type AskResponse } from "./schema";
import { getSettings } from "./settings";
import { search } from "./store";

export const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS) || 500;

export async function ask(question: string, docs: string[]): Promise<AskResponse> {
  const q = question.trim();
  if (!q) throw new AppError("invalid_request", "The question is empty.");
  if (q.length > MAX_QUESTION_CHARS) throw new AppError("question_too_long", `The question is too long (max ${MAX_QUESTION_CHARS} characters).`);
  if (!docs.length) throw new AppError("no_documents");
  docs.forEach(checkDocId);

  const settings = await getSettings();
  const t0 = Date.now();
  let status = 200;
  let errorCode: string | undefined;
  try {
    const retrieved = await search(q, docs, settings);
    const t1 = Date.now();
    const { data, usage } = await generateAnswer(buildUserPrompt(q, retrieved));
    const t2 = Date.now();

    // CHECK the citations: only chunks that were actually retrieved can be cited.
    const byId = new Map(retrieved.map((h) => [h.id, h]));
    const warnings: string[] = [];
    const unknown = data.citations.filter((id) => !byId.has(id));
    if (unknown.length) warnings.push(`The model cited ${unknown.length} reference(s) that were not retrieved; they were removed.`);
    const citations = [...new Set(data.citations)].filter((id) => byId.has(id)).map((id) => byId.get(id)!);
    if (data.found && citations.length === 0) warnings.push("The answer cites no retrieved passage: it is not grounded, verify it.");
    if (retrieved.length && retrieved[0].score < 0.3) warnings.push(`Weak retrieval: the best passage only has a similarity of ${retrieved[0].score.toFixed(2)}.`);

    const response = AskResponseSchema.parse({
      found: data.found,
      answer: data.answer,
      citations,
      retrieved,
      warnings,
      model: llmModel(),
      embeddingModel: embeddingModelName(),
      settings,
      usage,
      latency: { retrieval_ms: t1 - t0, generation_ms: t2 - t1, total_ms: t2 - t0 },
      promptVersion: PROMPT_VERSION,
    });
    await logQuery({
      status,
      question_chars: q.length,
      docs,
      settings,
      embedding_model: response.embeddingModel,
      llm_model: response.model,
      prompt_version: PROMPT_VERSION,
      retrieved: retrieved.map((h) => ({ id: h.id, score: Number(h.score.toFixed(4)) })),
      cited: citations.map((c) => c.id),
      found: data.found,
      warnings: warnings.length,
      usage,
      latency: response.latency,
    });
    return response;
  } catch (error) {
    const e = error instanceof AppError ? error : undefined;
    status = e?.status ?? 500;
    errorCode = e?.code ?? "internal_error";
    await logQuery({ status, error_code: errorCode, question_chars: q.length, docs, settings, latency_ms: Date.now() - t0 });
    throw error;
  }
}
