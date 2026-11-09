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
        className={`group flex min-h-56 cursor-pointer flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-8 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink sm:min-h-64 ${
          dragging
            ? "border-ink bg-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        } ${busy ? "cursor-progress" : ""}`}
      >
        {/* Lucide's image-up icon (ISC licence), in the secondary text color. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-10 text-zinc-500 dark:text-zinc-400"
        >
          <path d="M10.3 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10l-3.1-3.1a2 2 0 0 0-2.814.014L6 21" />
          <path d="m14 19.5 3-3 3 3" />
          <path d="M17 22v-5.5" />
          <circle cx="9" cy="9" r="2" />
        </svg>
        <span
          className={`inline-flex min-h-11 items-center rounded-lg bg-ink px-4 py-2 font-medium text-background transition-[background-color,transform] ${
            busy ? "opacity-60" : "group-hover:bg-ink/90 group-active:scale-[0.98]"
          }`}
        >
          {busy ? "Uploading your file" : dragging ? "Drop your file here" : "Choose a photo or a CSV file"}
        </span>
        {/* A phone has nothing to drag a file from, so only a mouse or trackpad is offered the drop. */}
        <span className="max-w-sm text-sm text-zinc-600 dark:text-zinc-400">
          <span className="hidden pointer-fine:inline">Or drop it here. </span>
          Photos as JPEG, PNG or WebP. CSV needs name and price columns.
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
