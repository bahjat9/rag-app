// V4 · Part A: one trace per request (a question, an indexing run, a graph build, a quiz).
//
// A trace is one JSON line in data/traces/<YYYY-MM-DD>.jsonl (local files, never committed, see
// .gitignore). It holds the steps of the request as spans: name, start offset, duration, status,
// a few attributes, and for LLM calls the model, tokens, cost and attempts.
//
// What a trace never holds: API keys, whole documents (chunk ids only, never chunk text), and
// personal data: the question and the answer are stored AFTER redaction (placeholders such as
// [EMAIL_1]), the mapping placeholder -> real value is never written (see lib/redact.ts).
// Retention: files older than TRACE_RETENTION_DAYS (default 30) are deleted when a new trace is
// written. Traces stay on this machine; only the app (localhost) can read them.
import "server-only";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Usage } from "./llm";

export const TRACE_DIR = path.join(process.cwd(), "data", "traces");
const RETENTION_DAYS = Number(process.env.TRACE_RETENTION_DAYS) || 30;
// Price used to turn tokens into a cost. The Gemini free tier costs 0; these defaults are the paid
// list price of gemini-3.1-flash-lite (USD per million tokens), change them in .env.local.
const PRICE_IN = Number(process.env.LLM_PRICE_INPUT_PER_M ?? 0.25);
const PRICE_OUT = Number(process.env.LLM_PRICE_OUTPUT_PER_M ?? 1.5);

export type TraceKind = "ask" | "index" | "graph_build" | "study";
export type Outcome = "answered" | "abstained" | "invalid" | "error" | "ok";

export type LlmCall = { model: string; input_tokens: number; output_tokens: number; cost_usd: number; attempts: number };
export type Span = {
  name: string;
  start_ms: number; // offset from the start of the trace
  duration_ms: number;
  status: "ok" | "error";
  attrs: Record<string, unknown>;
  llm?: LlmCall;
  error?: string;
};
export type Trace = {
  id: string;
  kind: TraceKind;
  started_at: string;
  duration_ms: number;
  outcome: Outcome;
  error?: { code: string; message: string };
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  spans: Span[];
  totals: { llm_calls: number; input_tokens: number; output_tokens: number; cost_usd: number };
};

export function costOf(usage: Pick<Usage, "input_tokens" | "output_tokens"> | null | undefined): number {
  if (!usage) return 0;
  return Math.round(((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) / 1e6) * 1e6) / 1e6;
}

export type SpanHandle = {
  set: (attrs: Record<string, unknown>) => void;
  llm: (model: string, usage: Usage | null, attempts?: number) => void;
};

export class Tracer {
  readonly id = randomUUID();
  private t0 = Date.now();
  private trace: Trace;
  private ended = false;

  constructor(kind: TraceKind, input: Record<string, unknown>) {
    this.trace = {
      id: this.id,
      kind,
      started_at: new Date(this.t0).toISOString(),
      duration_ms: 0,
      outcome: "ok",
      input,
      output: {},
      spans: [],
      totals: { llm_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    };
  }

  /** Run one step and record it as a span (also when it throws). */
  async span<T>(name: string, fn: (s: SpanHandle) => Promise<T> | T, attrs: Record<string, unknown> = {}): Promise<T> {
    const span: Span = { name, start_ms: Date.now() - this.t0, duration_ms: 0, status: "ok", attrs: { ...attrs } };
    const handle: SpanHandle = {
      set: (a) => Object.assign(span.attrs, a),
      llm: (model, usage, attempts = 1) => {
        span.llm = {
          model,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          cost_usd: costOf(usage),
          attempts,
        };
      },
    };
    const started = Date.now();
    try {
      return await fn(handle);
    } catch (error) {
      span.status = "error";
      span.error = errorText(error);
      throw error;
    } finally {
      span.duration_ms = Date.now() - started;
      this.trace.spans.push(span);
    }
  }

  /** Record a step measured elsewhere (e.g. one retriever inside the fusion). */
  addSpan(name: string, start_ms: number, duration_ms: number, attrs: Record<string, unknown> = {}) {
    this.trace.spans.push({ name, start_ms, duration_ms, status: "ok", attrs });
  }

  elapsed() {
    return Date.now() - this.t0;
  }

  setInput(a: Record<string, unknown>) {
    Object.assign(this.trace.input, a);
  }
  setOutput(a: Record<string, unknown>) {
    Object.assign(this.trace.output, a);
  }

  async end(outcome: Outcome, error?: unknown, output?: Record<string, unknown>): Promise<Trace> {
    if (this.ended) return this.trace;
    this.ended = true;
    if (output) Object.assign(this.trace.output, output);
    this.trace.outcome = outcome;
    if (error) {
      const e = error as { code?: string; publicMessage?: string };
      this.trace.error = { code: e.code ?? "internal_error", message: e.publicMessage ?? errorText(error) };
    }
    this.trace.duration_ms = Date.now() - this.t0;
    for (const s of this.trace.spans) {
      if (!s.llm) continue;
      this.trace.totals.llm_calls += s.llm.attempts;
      this.trace.totals.input_tokens += s.llm.input_tokens;
      this.trace.totals.output_tokens += s.llm.output_tokens;
      this.trace.totals.cost_usd = Math.round((this.trace.totals.cost_usd + s.llm.cost_usd) * 1e6) / 1e6;
    }
    this.trace.spans.sort((a, b) => a.start_ms - b.start_ms);
    await writeTrace(this.trace);
    return this.trace;
  }
}

export function startTrace(kind: TraceKind, input: Record<string, unknown> = {}) {
  return new Tracer(kind, input);
}

function errorText(error: unknown): string {
  const e = error as { code?: string; publicMessage?: string; message?: string };
  return String(e?.code ? `${e.code}: ${e.publicMessage ?? ""}` : e?.message ?? error).slice(0, 300);
}

const day = (iso: string) => iso.slice(0, 10);
let prunedOn = "";

async function writeTrace(t: Trace) {
  try {
    await fs.mkdir(TRACE_DIR, { recursive: true });
    await fs.appendFile(path.join(TRACE_DIR, `${day(t.started_at)}.jsonl`), JSON.stringify(t) + "\n", "utf8");
    const today = day(new Date().toISOString());
    if (prunedOn !== today) {
      prunedOn = today;
      const limit = Date.now() - RETENTION_DAYS * 86400_000;
      for (const f of await fs.readdir(TRACE_DIR)) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && Date.parse(m[1]) < limit) await fs.unlink(path.join(TRACE_DIR, f));
      }
    }
  } catch (error) {
    console.error("trace write failed", error); // a trace must never break the request
  }
}

/** Every trace of the last `days` days, newest first. */
export async function readTraces(days = RETENTION_DAYS): Promise<Trace[]> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(TRACE_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse().slice(0, days);
  } catch {
    return [];
  }
  const out: Trace[] = [];
  for (const f of files) {
    const lines = (await fs.readFile(path.join(TRACE_DIR, f), "utf8")).split("\n").filter(Boolean);
    for (const l of lines.reverse()) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* a broken line is skipped */
      }
    }
  }
  return out;
}

export async function getTrace(id: string): Promise<Trace | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  return (await readTraces()).find((t) => t.id === id) ?? null;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

/** Optional metrics page: every number is computed from the traces. */
export function metricsOf(traces: Trace[]) {
  const asks = traces.filter((t) => t.kind === "ask");
  const outcomes: Record<string, number> = { answered: 0, abstained: 0, invalid: 0, error: 0 };
  for (const t of asks) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
  const steps: Record<string, number[]> = {};
  for (const t of asks) for (const s of t.spans) (steps[s.name] ??= []).push(s.duration_ms);
  const latency = {
    request: { p50: pct(asks.map((t) => t.duration_ms), 50), p95: pct(asks.map((t) => t.duration_ms), 95), n: asks.length },
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { p50: pct(v, 50), p95: pct(v, 95), n: v.length }])),
  };
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const tokensPerQuestion = avg(asks.filter((t) => t.totals.llm_calls).map((t) => t.totals.input_tokens + t.totals.output_tokens));
  const costPerQuestion = asks.length ? asks.reduce((a, t) => a + t.totals.cost_usd, 0) / asks.length : 0;
  // per indexed document: indexing is local (0 LLM tokens); the graph build is where documents cost tokens
  const perDoc: Record<string, { index_runs: number; index_ms: number; graph_tokens: number; graph_cost_usd: number }> = {};
  for (const t of traces) {
    if (t.kind === "index") {
      for (const s of t.spans) {
        const doc = s.attrs.doc as string | undefined;
        if (!doc) continue;
        const d = (perDoc[doc] ??= { index_runs: 0, index_ms: 0, graph_tokens: 0, graph_cost_usd: 0 });
        if (s.name === "index.document") {
          d.index_runs++;
          d.index_ms += s.duration_ms;
        }
      }
    }
    if (t.kind === "graph_build") {
      for (const s of t.spans) {
        const doc = s.attrs.doc as string | undefined;
        if (!doc || !s.llm) continue;
        const d = (perDoc[doc] ??= { index_runs: 0, index_ms: 0, graph_tokens: 0, graph_cost_usd: 0 });
        d.graph_tokens += s.llm.input_tokens + s.llm.output_tokens;
        d.graph_cost_usd = Math.round((d.graph_cost_usd + s.llm.cost_usd) * 1e6) / 1e6;
      }
    }
  }
  const perDay: Record<string, { requests: number; llm_calls: number; tokens: number; cost_usd: number }> = {};
  for (const t of traces) {
    const d = (perDay[day(t.started_at)] ??= { requests: 0, llm_calls: 0, tokens: 0, cost_usd: 0 });
    d.requests++;
    d.llm_calls += t.totals.llm_calls;
    d.tokens += t.totals.input_tokens + t.totals.output_tokens;
    d.cost_usd = Math.round((d.cost_usd + t.totals.cost_usd) * 1e6) / 1e6;
  }
  return {
    traces: traces.length,
    questions: asks.length,
    outcomes,
    latency,
    tokens_per_question: tokensPerQuestion,
    cost_per_question_usd: Math.round(costPerQuestion * 1e6) / 1e6,
    per_document: perDoc,
    per_day: perDay,
    prices: { input_per_m: PRICE_IN, output_per_m: PRICE_OUT },
    retention_days: RETENTION_DAYS,
  };
}
