// Decides what an uploaded file is from its bytes. A file's name and declared type come from the
// client, so they only ever choose between text formats.

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export type UploadedFileType =
  | { kind: "image"; mediaType: ImageMediaType }
  | { kind: "csv" }
  | { kind: "unsupported"; message: string };

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
  "avif",
]);

function startsWith(bytes: Uint8Array, ...prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

const SUPPORTED =
  "Upload a photo as JPEG, PNG or WebP, or a price list as a CSV file.";

export function detectFileType(name: string, bytes: Uint8Array): UploadedFileType {
  if (bytes.length === 0) {
    return { kind: "unsupported", message: "This file is empty." };
  }
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) {
    return { kind: "image", mediaType: "image/jpeg" };
  }
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { kind: "image", mediaType: "image/png" };
  }
  if (asciiAt(bytes, 0, 4) === "RIFF" && asciiAt(bytes, 8, 12) === "WEBP") {
    return { kind: "image", mediaType: "image/webp" };
  }
  if (asciiAt(bytes, 4, 8) === "ftyp" && HEIF_BRANDS.has(asciiAt(bytes, 8, 12))) {
    return {
      kind: "unsupported",
      message: "This photo is in HEIC format. Export it as JPEG and upload it again.",
    };
  }
  if (asciiAt(bytes, 0, 4) === "GIF8") {
    return {
      kind: "unsupported",
      message: "GIF images are not supported. Save it as JPEG or PNG.",
    };
  }
  if (asciiAt(bytes, 0, 5) === "%PDF-") {
    return {
      kind: "unsupported",
      message: "PDF files are not supported yet. Upload a photo of the page, or a CSV file.",
    };
  }
  if (
    startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) ||
    startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0)
  ) {
    return {
      kind: "unsupported",
      message: "Spreadsheet files are not supported. Save it as CSV and upload it again.",
    };
  }
  if (/\.(?:csv|tsv|txt)$/i.test(name)) {
    return { kind: "csv" };
  }
  return { kind: "unsupported", message: SUPPORTED };
}

// The file's own name, for the seller to recognise it later. Never used as a path.
export function displayFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return clean.slice(0, 120) || "Untitled";
}
