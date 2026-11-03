// Batch LLM calls (evaluation answers, no-context test) on a free tier hit the provider's rate limit.
// withPacing waits a little before each call and, on 429 / provider unavailable, waits and retries,
// so a run of 27 questions does not end with half the rows in error.
import "server-only";
import { AppError } from "./errors";

const DELAY_MS = Number(process.env.LLM_BATCH_DELAY_MS ?? 1500); // pause before each batch call
const RETRY_WAIT_MS = Number(process.env.LLM_BATCH_RETRY_WAIT_MS ?? 20000);
const RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withPacing<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(DELAY_MS);
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof AppError && (error.code === "rate_limited" || error.code === "llm_unavailable" || error.code === "llm_timeout");
      if (!retryable || attempt >= RETRIES) throw error;
      console.warn(`[pace] ${error.code}, retry ${attempt + 1}/${RETRIES} in ${RETRY_WAIT_MS / 1000} s`);
      await sleep(RETRY_WAIT_MS);
    }
  }
}
