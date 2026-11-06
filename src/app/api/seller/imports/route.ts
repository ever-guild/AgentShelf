import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { errorResponse, readBodyWithin } from "@/server/http";
import { defaultImportDeps } from "@/server/services/import-start";
import { MAX_UPLOAD_BODY_BYTES, createImport } from "@/server/services/imports";

// The session is checked before the body is read, so nobody can make the server buffer a file
// without signing in. The body is bounded before it is parsed, because `formData()` reads it all.
export async function POST(request: Request) {
  try {
    const shop = await currentSeller();
    const body = await readBodyWithin(request, MAX_UPLOAD_BODY_BYTES);
    if (!body) {
      throw new ServiceError("IMPORT_FILE_TOO_LARGE", "This file is too large. Try a smaller one.");
    }
    const form = await new Response(new Uint8Array(body), {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    })
      .formData()
      .catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      throw new ServiceError("IMPORT_FILE_INVALID", "Choose a file to upload.");
    }
    const view = await createImport(
      getDb(),
      shop,
      { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
      defaultImportDeps(),
    );
    return Response.json(view, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
