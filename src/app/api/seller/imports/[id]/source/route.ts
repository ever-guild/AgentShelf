import { currentSeller } from "@/server/auth/current-seller";
import { getDb } from "@/server/db";
import { errorResponse } from "@/server/http";
import { readImportSource } from "@/server/services/imports";

// The seller's own photo, for comparing with the table. The media type was set from the file's
// bytes on upload, and these headers stop a browser from treating it as anything else.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const shop = await currentSeller();
    const { id } = await params;
    const { bytes, mediaType } = await readImportSource(getDb(), shop, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": mediaType,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
