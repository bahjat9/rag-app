// Every failure maps to one HTTP status and one safe message. No stack trace,
// no provider detail and no key ever reaches the browser.

export type ErrorCode =
  | "invalid_request"
  | "question_too_long"
  | "no_documents"
  | "index_missing"
  | "unsupported_file"
  | "file_too_large"
  | "not_found"
  | "invalid_model_output"
  | "rate_limited"
  | "llm_unavailable"
  | "llm_timeout"
  | "embedding_failed"
  | "internal_error"
  | "not_configured";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  question_too_long: 400,
  no_documents: 400,
  index_missing: 409,
  unsupported_file: 415,
  file_too_large: 413,
  not_found: 404,
  invalid_model_output: 502,
  rate_limited: 429,
  llm_unavailable: 502,
  llm_timeout: 504,
  embedding_failed: 500,
  internal_error: 500,
  not_configured: 500,
};

const MESSAGE: Record<ErrorCode, string> = {
  invalid_request: "The request is invalid.",
  question_too_long: "The question is too long.",
  no_documents: "Select at least one document to ask your question against.",
  index_missing: "Some selected documents are not indexed with the current settings. Click \"Index selected documents\" first.",
  unsupported_file: "Only .md and .txt files are supported.",
  file_too_large: "The file is too large.",
  not_found: "Not found.",
  invalid_model_output: "The model returned an answer we could not validate. Please try again.",
  rate_limited: "Too many requests to the model provider. Please wait a moment and retry.",
  llm_unavailable: "The model provider is unavailable right now. Please try again later.",
  llm_timeout: "The model took too long to answer. Please try again.",
  embedding_failed: "The embedding model could not be loaded or failed. Check the server log.",
  internal_error: "Something went wrong on our side. Please contact the administrator.",
  not_configured: "The LLM is not configured on the server (LLM_API_KEY / LLM_MODEL).",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  constructor(code: ErrorCode, publicMessage?: string, internalDetail?: string) {
    super(internalDetail ?? publicMessage ?? MESSAGE[code]);
    this.code = code;
    this.status = STATUS[code];
    this.publicMessage = publicMessage ?? MESSAGE[code];
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const e = error as { status?: number; name?: string; code?: string };
  const name = e?.name ?? "";
  if (name.includes("Timeout") || name === "AbortError" || e?.code === "ETIMEDOUT") {
    return new AppError("llm_timeout", undefined, String(error));
  }
  if (name.includes("APIConnectionError")) return new AppError("llm_unavailable", undefined, String(error));
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 429) return new AppError("rate_limited", undefined, String(error));
  if (status !== undefined && status >= 500) return new AppError("llm_unavailable", undefined, String(error));
  return new AppError("internal_error", undefined, String(error));
}

export function errorResponse(error: unknown): Response {
  const e = toAppError(error);
  if (e.status >= 500) console.error(`[${e.code}]`, e.message);
  return Response.json({ error: e.publicMessage, code: e.code }, { status: e.status });
}
