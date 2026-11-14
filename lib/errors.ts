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
  index_missing: "Some selected documents are not prepared yet. Click \"Prepare\" in the documents panel first.",
  unsupported_file: "Only .md and .txt files are supported.",
  file_too_large: "The file is too large.",
  not_found: "Not found.",
  invalid_model_output: "The AI model returned an answer the app could not check, so it is not shown. Please try again.",
  rate_limited: "The AI provider is limiting requests right now (free tier). Wait a minute and try again.",
  llm_unavailable: "The AI provider cannot be reached right now (no internet, or the service is down). Try again in a moment.",
  llm_timeout: "The AI model took too long to answer. Please try again.",
  embedding_failed: "The local language model could not be loaded. The first run needs internet to download it (~25 MB); check the terminal where the app runs.",
  internal_error: "Something went wrong. Try again; if it keeps failing, open \"What happened?\" or look at the terminal where the app runs.",
  not_configured: "The AI model is not configured: put your API key in .env.local (LLM_API_KEY), see the README, then restart the app.",
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
  // V4: the OpenAI SDK names its timeout error APIConnectionTimeoutError: check it before "connection"
  if (name.includes("Timeout") || error?.constructor?.name?.includes("Timeout") || name === "AbortError" || e?.code === "ETIMEDOUT" || /timed out/i.test(String((error as { message?: string })?.message ?? ""))) {
    return new AppError("llm_timeout", undefined, String(error));
  }
  const msg = String((error as { message?: string })?.message ?? "");
  if (name.includes("APIConnectionError") || error?.constructor?.name?.includes("Connection") || /Connection error|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
    return new AppError("llm_unavailable", undefined, String(error));
  }
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 429) return new AppError("rate_limited", undefined, String(error));
  if (status !== undefined && status >= 500) return new AppError("llm_unavailable", undefined, String(error));
  return new AppError("internal_error", undefined, String(error));
}

export function errorResponse(error: unknown): Response {
  const e = toAppError(error);
  if (e.status >= 500) console.error(`[${e.code}]`, e.message);
  const traceId = (error as { traceId?: string })?.traceId;
  return Response.json({ error: e.publicMessage, code: e.code, ...(traceId ? { traceId } : {}) }, { status: e.status });
}
