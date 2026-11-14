// The two-phase RAG pipeline, answering side:
// question -> retrieval (dense + BM25 + graph, RRF) -> prompt (instructions + excerpts + question)
// -> LLM -> checked answer.
// V4: every request is traced (lib/trace.ts), and personal data is replaced by placeholders before
// the prompt leaves the machine and before anything is traced (lib/redact.ts). Retrieval runs on
// the original question: it is local (local embeddings, local BM25 and graph), nothing leaves.
import "server-only";
import { checkDocId } from "./docs";
import { embeddingModelName } from "./embeddings";
import { AppError } from "./errors";
import { generateAnswer, llmModel, usageOfError, type Usage } from "./llm";
import { logQuery } from "./log";
import { buildUserPrompt, PROMPT_VERSION } from "./prompt";
import { newRedactor, Redactor } from "./redact";
import { retrieve, type Source } from "./retrieve";
import { AskResponseSchema, type AskResponse } from "./schema";
import { getSettings } from "./settings";
import type { Hit } from "./store";
import { startTrace, type Tracer } from "./trace";

export const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS) || 500;

export type GroundedAnswer = {
  found: boolean;
  answer: string;
  citations: Hit[];
  warnings: string[];
  usage: Usage | null;
  generation_ms: number;
};

/**
 * Generation step on already retrieved chunks: redact -> prompt -> LLM -> Zod -> citations checked
 * -> placeholders restored. With a tracer, each step is a span.
 */
export async function answerFromHits(
  question: string,
  retrieved: (Hit & { sources?: Source[] })[],
  opts: { tracer?: Tracer; redactor?: Redactor; traceRedactor?: Redactor } = {},
): Promise<GroundedAnswer> {
  const t0 = Date.now();
  const r = opts.redactor ?? new Redactor([], false);
  const step = <T>(name: string, fn: (s: { set: (a: Record<string, unknown>) => void; llm: (m: string, u: Usage | null, n?: number) => void }) => Promise<T> | T) =>
    opts.tracer ? opts.tracer.span(name, fn) : Promise.resolve(fn({ set: () => {}, llm: () => {} }));

  const prompt = await step("redact.prompt", (s) => {
    const before = r.total;
    const q = r.redact(question);
    const excerpts = retrieved.map((h) => ({ id: h.id, text: r.redact(h.text) }));
    s.set({ enabled: r.enabled, replaced: r.total - before, kinds: r.summary() });
    return buildUserPrompt(q, excerpts);
  });
  const { data, usage } = await step("llm.generate", async (s) => {
    s.set({ prompt_chars: prompt.length, chunks: retrieved.map((h) => h.id), prompt_version: PROMPT_VERSION });
    try {
      const res = await generateAnswer(prompt);
      s.llm(llmModel(), res.usage, res.calls);
      s.set({ found: res.data.found, cited: res.data.citations });
      return res;
    } catch (error) {
      const u = usageOfError(error);
      s.llm(llmModel(), u.usage, u.calls);
      throw error;
    }
  });
  const out = await step("answer.check", (s) => {
    // CHECK the citations: only chunks that were actually retrieved can be cited.
    const byId = new Map(retrieved.map((h) => [h.id, h]));
    const warnings: string[] = [];
    const unknown = data.citations.filter((id) => !byId.has(id));
    if (unknown.length) warnings.push(`The model cited ${unknown.length} reference(s) that were not retrieved; they were removed.`);
    // V1 known failure fixed: no reference when the answer says "not found"
    const citations = data.found ? [...new Set(data.citations)].filter((id) => byId.has(id)).map((id) => byId.get(id)!) : [];
    if (data.found && citations.length === 0) warnings.push("The answer cites no retrieved passage: it is not grounded, verify it.");
    const cos = retrieved.flatMap((h) => (h.sources ? h.sources.filter((x) => x.retriever === "dense").map((x) => x.score) : [h.score]));
    if (cos.length && Math.max(...cos) < 0.3) warnings.push(`Weak retrieval: the best passage only has a dense similarity of ${Math.max(...cos).toFixed(2)}.`);
    s.set({ unknown_citations: unknown.length, citations: citations.map((c) => c.id), warnings: warnings.length });
    return { citations, warnings };
  });
  const answer = await step("redact.restore", (s) => {
    const a = r.restore(data.answer);
    s.set({ restored: a !== data.answer });
    return a;
  });
  opts.tracer?.setOutput({ found: data.found, answer: opts.traceRedactor ? opts.traceRedactor.redact(answer) : data.answer, cited: out.citations.map((c) => c.id), warnings: out.warnings });
  return { found: data.found, answer, citations: out.citations, warnings: out.warnings, usage, generation_ms: Date.now() - t0 };
}

export async function ask(question: string, docs: string[]): Promise<AskResponse> {
  const q = question.trim();
  if (!q) throw new AppError("invalid_request", "The question is empty.");
  if (q.length > MAX_QUESTION_CHARS) throw new AppError("question_too_long", `The question is too long (max ${MAX_QUESTION_CHARS} characters).`);
  if (!docs.length) throw new AppError("no_documents");
  docs.forEach(checkDocId);

  const settings = await getSettings();
  const redactor = await newRedactor(settings.redactPII);
  // the trace stores the question AFTER redaction (a separate redactor, same rules: the values
  // stay out of the trace, the request's own placeholders are not affected)
  const traceRedactor = await newRedactor(true);
  const tracer = startTrace("ask", {
    question: traceRedactor.redact(q),
    question_chars: q.length,
    docs,
    settings: { chunkSize: settings.chunkSize, overlapPercent: settings.overlapPercent, topK: settings.topK, retrievers: settings.retrievers, redactPII: settings.redactPII },
    llm_model: llmModel(),
    embedding_model: embeddingModelName(),
  });
  const t0 = Date.now();
  try {
    const r = await retrieve(q, docs, settings, settings.topK, tracer);
    const retrieved = r.hits;
    const warnings0: string[] = [];
    if (settings.retrievers.graph && r.graph_available === false) warnings0.push("The concept graph is not built for these documents: the graph retriever returned nothing.");
    const t1 = Date.now();
    const { found, answer, citations, warnings: w, usage } = await answerFromHits(q, retrieved, { tracer, redactor, traceRedactor });
    const warnings = [...warnings0, ...w];
    const t2 = Date.now();

    const response = AskResponseSchema.parse({
      found,
      answer,
      citations,
      retrieved,
      warnings,
      model: llmModel(),
      embeddingModel: embeddingModelName(),
      settings,
      graph: r.path ? { available: !!r.graph_available, path: r.path } : null,
      usage,
      latency: { retrieval_ms: t1 - t0, generation_ms: t2 - t1, total_ms: t2 - t0, per_retriever_ms: { dense: r.ms.dense, bm25: r.ms.bm25, graph: r.ms.graph } },
      promptVersion: PROMPT_VERSION,
      traceId: tracer.id,
      redactions: redactor.summary(),
    });
    await tracer.end(found ? "answered" : "abstained");
    await logQuery({
      status: 200,
      trace_id: tracer.id,
      question_chars: q.length,
      docs,
      llm_model: response.model,
      found,
      warnings: warnings.length,
      usage,
      latency: response.latency,
    });
    return response;
  } catch (error) {
    const e = error instanceof AppError ? error : undefined;
    await tracer.end(e?.code === "invalid_model_output" ? "invalid" : "error", error);
    await logQuery({ status: e?.status ?? 500, error_code: e?.code ?? "internal_error", trace_id: tracer.id, question_chars: q.length, docs, latency_ms: Date.now() - t0 });
    // the trace id travels with the error, so the UI can open the trace of a failed question too
    if (error instanceof AppError) throw Object.assign(error, { traceId: tracer.id });
    throw error;
  }
}
