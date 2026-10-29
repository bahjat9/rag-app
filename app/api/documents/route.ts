import { addDoc, deleteDoc, listDocs } from "@/lib/docs";
import { AppError, errorResponse } from "@/lib/errors";
import { getSettings } from "@/lib/settings";
import { chunkCount, dropIndexes, indexStatus } from "@/lib/store";

export const dynamic = "force-dynamic";

// GET: list documents with their index status for the current settings.
export async function GET() {
  try {
    const settings = await getSettings();
    const docs = await listDocs();
    const withStatus = await Promise.all(
      docs.map(async (d) => ({ ...d, index: await indexStatus(d.id, settings), chunks: await chunkCount(d.id, settings) })),
    );
    return Response.json({ docs: withStatus, settings });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST multipart/form-data with one or more "file" fields (.md / .txt).
export async function POST(request: Request) {
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError("invalid_request", "Send the files as multipart/form-data.");
    }
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!files.length) throw new AppError("invalid_request", "No file received.");
    const added = [];
    for (const f of files) {
      const id = f.name.replace(/\s+/g, "-");
      added.push(await addDoc(id, await f.text()));
      await dropIndexes(id); // the content may have changed: old indexes are no longer valid
    }
    return Response.json({ added });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/documents?id=<doc>
export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    await deleteDoc(id);
    await dropIndexes(id);
    return Response.json({ deleted: id });
  } catch (error) {
    return errorResponse(error);
  }
}
