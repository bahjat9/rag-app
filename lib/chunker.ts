// Naive fixed-size chunking with overlap, the same algorithm as
// norag-rag/ask_rag_google.py (V1 is naive on purpose):
//  1. split on blank lines, drop paragraphs shorter than minParagraphLength
//  2. join the remaining paragraphs back into one long text
//  3. slide a window of chunkSize characters, moving (chunkSize - overlap) each time
// Chunks can start or end in the middle of a word or a sentence.
import type { Settings } from "./settings";

export type RawChunk = { index: number; text: string; start: number; end: number };

export function chunkText(text: string, s: Pick<Settings, "chunkSize" | "overlapPercent" | "minParagraphLength">): {
  normalized: string;
  chunks: RawChunk[];
} {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p.length >= s.minParagraphLength);
  const normalized = paragraphs.join("\n\n");
  const overlap = Math.floor((s.chunkSize * s.overlapPercent) / 100);
  const step = Math.max(1, s.chunkSize - overlap);
  const chunks: RawChunk[] = [];
  for (let start = 0, i = 0; start < normalized.length; start += step, i++) {
    const end = Math.min(normalized.length, start + s.chunkSize);
    chunks.push({ index: i, text: normalized.slice(start, end), start, end });
    if (end === normalized.length) break;
  }
  return { normalized, chunks };
}
