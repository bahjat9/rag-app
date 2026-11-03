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
 * One LLM call that must return JSON matching `schema`: ASK for the format (provider-enforced JSON
 * schema, or described in the prompt), then CHECK it with Zod. Invalid output is retried once.
 */
export async function llmJson<T extends z.ZodTypeAny>(
  system: string,
  user: string,
  schema: T,
  name: string,
): Promise<{ data: z.infer<T>; usage: Usage | null }> {
  const c = getClient();
  const mode = process.env.LLM_STRUCTURED_OUTPUT === "prompt" ? "prompt" : "json_schema";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
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
      throw toAppError(error);
    }
    const choice = completion.choices[0];
    const u = completion.usage;
    const usage = u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.total_tokens } : null;
    try {
      if (choice?.finish_reason === "length") throw new Error("cut off");
      const parsed = schema.safeParse(JSON.parse(stripFence(choice?.message?.content ?? "")));
      if (!parsed.success) throw new Error("schema mismatch: " + parsed.error.message);
      return { data: parsed.data, usage };
    } catch (error) {
      lastError = error;
      console.warn(`[llm] invalid output (attempt ${attempt + 1}):`, (error as Error).message);
    }
  }
  throw new AppError("invalid_model_output", undefined, String(lastError));
}

/** Grounded generation: the RAG answer, checked against LlmAnswerSchema. */
export async function generateAnswer(userPrompt: string): Promise<{ data: LlmAnswer; usage: Usage | null }> {
  return llmJson(SYSTEM_PROMPT, userPrompt, LlmAnswerSchema, "rag_answer");
}
