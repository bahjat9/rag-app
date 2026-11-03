import { z } from "zod";
import { checkDocId } from "@/lib/docs";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { questionWords, vocabularyList, wordChunks } from "@/lib/words";

export const dynamic = "force-dynamic";

function docsParam(url: URL): string[] {
  const docs = (url.searchParams.get("docs") ?? "").split(",").filter(Boolean);
  if (!docs.length) throw new AppError("no_documents");
  docs.forEach(checkDocId);
  return docs;
}

// Corpus mode.
// GET ?docs=a,b[&filter=..&stop=hide&sort=count|chunks|alpha&limit=300] -> vocabulary
// GET ?docs=a,b&word=x                                                   -> chunks containing the word
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const docs = docsParam(url);
    const settings = await getSettings();
    const word = url.searchParams.get("word");
    if (word !== null) {
      if (!word.trim() || word.length > 100) throw new AppError("invalid_request", "Give a word (max 100 characters).");
      return Response.json(await wordChunks(docs, settings, word));
    }
    const sort = url.searchParams.get("sort");
    return Response.json(
      await vocabularyList(docs, settings, {
        filter: url.searchParams.get("filter") ?? undefined,
        hideStopwords: url.searchParams.get("stop") === "hide",
        sort: sort === "alpha" || sort === "chunks" ? sort : "count",
        limit: Math.min(2000, Number(url.searchParams.get("limit")) || 300),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// Question mode. POST { docs, question, evidence? } -> each word of the question: in the corpus? where?
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ docs: z.array(z.string()).min(1).max(50), question: z.string().min(1).max(500), evidence: z.array(z.string()).max(10).default([]) })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { docs: [...], question, evidence? }.");
    parsed.data.docs.forEach(checkDocId);
    return Response.json(await questionWords(parsed.data.docs, await getSettings(), parsed.data.question, parsed.data.evidence));
  } catch (error) {
    return errorResponse(error);
  }
}
