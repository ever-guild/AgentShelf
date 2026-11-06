"use client";

import { useRouter } from "next/navigation";
import { useState, type DragEvent } from "react";

// The model reads up to this many pixels on the long edge, so sending more only costs upload time.
const MAX_EDGE = 2576;
const SMALL_PNG_BYTES = 4_000_000;

// A phone photo is often over 10 MB, and carries the place it was taken. Drawing it onto a canvas
// shrinks it and leaves that metadata behind. A small PNG, usually a screenshot, stays as it is,
// because JPEG would only blur its text. A browser that cannot decode a file sends it unchanged, and
// the server explains what to do with it.
async function prepareFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    return file;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === "image/png" && file.size < SMALL_PNG_BYTES) {
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    return blob
      ? new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" })
      : file;
  } catch {
    return file;
  }
}

export function UploadForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function upload(file: File | undefined) {
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", await prepareFile(file));
      const response = await fetch("/api/seller/imports", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        error?: { code?: string; message?: string };
      } | null;
      if (response.ok && body?.id) {
        router.push(`/seller/imports/${body.id}`);
        return;
      }
      if (body?.error?.code === "UNAUTHORIZED") {
        router.replace("/seller/sign-in");
        return;
      }
      setError(body?.error?.message ?? "The upload did not work. Try again.");
    } catch {
      setError("The server did not answer. Check your connection and try again.");
    }
    setBusy(false);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    void upload(event.dataTransfer.files[0]);
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={`flex cursor-pointer flex-col items-start gap-1 rounded-md border-2 border-dashed px-5 py-8 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink ${
          dragging ? "border-ink" : "border-zinc-300 dark:border-zinc-700"
        } ${busy ? "cursor-progress opacity-60" : ""}`}
      >
        <span className="text-lg font-medium text-ink">
          {busy ? "Uploading your file" : "Choose a photo or a CSV file"}
        </span>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          Or drop it here. Photos as JPEG, PNG or WebP. CSV needs name and price columns.
        </span>
        <input
          type="file"
          name="file"
          disabled={busy}
          accept="image/jpeg,image/png,image/webp,.csv,.tsv,.txt,text/csv"
          className="sr-only"
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-blocked">
          {error}
        </p>
      ) : null}
    </div>
  );
}
