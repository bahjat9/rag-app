import { z } from "zod";
import { AppError, errorResponse } from "@/lib/errors";
import { GRADES, setGrade } from "@/lib/evaluate";

export const dynamic = "force-dynamic";

// POST { file, id, grade, note } -> saves a hand grade in the run file.
export async function POST(request: Request) {
  try {
    const parsed = z
      .object({ file: z.string(), id: z.string(), grade: z.enum(GRADES).nullable(), note: z.string().max(1000).default("") })
      .strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("invalid_request", `Send { file, id, grade: ${GRADES.join(" | ")} | null, note }.`);
    const { file, id, grade, note } = parsed.data;
    return Response.json({ grades: await setGrade(file, id, grade, note) });
  } catch (error) {
    return errorResponse(error);
  }
}
