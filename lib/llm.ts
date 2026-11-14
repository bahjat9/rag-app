// The only module that talks to the LLM (OpenAI-compatible SDK; Gemini by default).
import "server-only";
import OpenAI from "openai";
import { z } from "zod";
import { AppError, toAppError } from "./errors";
import { SYSTEM_PROMPT } from "./prompt";
import { LlmAnswerSchema, type LlmAnswer } from "./schema";

let client: OpenAI | null = null;

export function llmModel(): string {
  return process.env.LLM_MODEL || "";
}

function getClient(): OpenAI {
  if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL || !process.env.LLM_MODEL) throw new AppError("not_configured");
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
      timeout: Number(process.env.LLM_TIMEOUT_MS) || 30000,
      maxRetries: 1,
    });
  }
  return client;
}

function stripFence(t: string): string {
  const m = t.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : t.trim();
}

export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };

/**
 * The JSON schema sent to the provider. Gemini's OpenAI-compatible endpoint rejects some JSON-schema
 * keywords inside nested objects (HTTP 400 with no body), so the provider gets a simpler schema
 * (no additionalProperties / string lengths / $schema); Zod still checks the FULL schema afterwards.
 */
const promptOnly = new Set<string>(); // schemas the provider refused once

function providerSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(providerSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (["$schema", "additionalProperties", "minLength", "maxLength", "minItems"].includes(k)) continue;
    out[k] = providerSchema(v);
  }
  return out;
}

/**
 * One LLM call that must return JSON matching `schema`: ASK for the format (provider-enforced JSON
 * schema, or described in the prompt), then CHECK it with Zod. Invalid output is retried once.
 */
export async function llmJson<T extends z.ZodTypeAny>(
  system: string,
  user: string,
  schema: T,
  name: string,
): Promise<{ data: z.infer<T>; usage: Usage | null; calls: number }> {
  const c = getClient();
  // V4: tokens of every attempt are added up, so traces show the real cost of a retry
  let total: Usage | null = null;
  let calls = 0;
  let mode = process.env.LLM_STRUCTURED_OUTPUT === "prompt" || promptOnly.has(name) ? "prompt" : "json_schema";
  const jsonSchema = providerSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    let completion;
    try {
      completion = await c.chat.completions.create({
        model: llmModel(),
        messages: [
          { role: "system", content: mode === "prompt" ? `${system}\n\nReturn ONLY a JSON object, no code fence, matching this JSON schema:\n${JSON.stringify(jsonSchema)}` : system },
          { role: "user", content: user },
        ],
        ...(mode === "json_schema" ? { response_format: { type: "json_schema" as const, json_schema: { name, strict: true, schema: jsonSchema } } } : {}),
      });
    } catch (error) {
      // The provider refused the schema itself (400): ask for the format in the prompt instead
      // (same Zod check after). Happens once per call, does not use a retry.
      if (mode === "json_schema" && (error as { status?: number })?.status === 400) {
        console.warn(`[llm] provider rejected the JSON schema of "${name}" (400): falling back to the format in the prompt`);
        mode = "prompt";
        promptOnly.add(name); // remember it for the next calls with this schema
        attempt--;
        continue;
      }
      throw toAppError(error);
    }
    calls++;
    const choice = completion.choices[0];
    const u = completion.usage;
    if (u) {
      total = total ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      total.input_tokens += u.prompt_tokens;
      total.output_tokens += u.completion_tokens;
      total.total_tokens += u.total_tokens;
    }
    try {
      if (choice?.finish_reason === "length") throw new Error("cut off");
      const parsed = schema.safeParse(JSON.parse(stripFence(choice?.message?.content ?? "")));
      if (!parsed.success) throw new Error("schema mismatch: " + parsed.error.message);
      return { data: parsed.data, usage: total, calls };
    } catch (error) {
      lastError = error;
      console.warn(`[llm] invalid output (attempt ${attempt + 1}):`, (error as Error).message);
    }
  }
  throw Object.assign(new AppError("invalid_model_output", undefined, String(lastError)), { usage: total, calls });
}

/** Tokens and calls spent by a failed llmJson (attached to its error), for the traces. */
export function usageOfError(error: unknown): { usage: Usage | null; calls: number } {
  const e = error as { usage?: Usage | null; calls?: number };
  return { usage: e?.usage ?? null, calls: e?.calls ?? 0 };
}

/** Grounded generation: the RAG answer, checked against LlmAnswerSchema. */
export async function generateAnswer(userPrompt: string): Promise<{ data: LlmAnswer; usage: Usage | null; calls: number }> {
  return llmJson(SYSTEM_PROMPT, userPrompt, LlmAnswerSchema, "rag_answer");
}
