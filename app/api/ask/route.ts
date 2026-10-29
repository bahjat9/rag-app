import { AppError, errorResponse } from "@/lib/errors";
import { ask } from "@/lib/rag";
import { AskRequestSchema } from "@/lib/schema";

export const dynamic = "force-dynamic";

// POST { question, docs } -> grounded answer with references.
export async function POST(request: Request) {
  try {
    const parsed = AskRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", "Send { question: string, docs: string[] }.");
    return Response.json(await ask(parsed.data.question, parsed.data.docs));
  } catch (error) {
    return errorResponse(error);
  }
}
