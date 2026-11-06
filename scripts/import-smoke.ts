import { readFileSync } from "node:fs";
import { basename } from "node:path";

// Uploads a price list to a running service and checks what comes back, for a real model run on a
// local build or on Render. It signs in as the demo shop, so it needs that shop's seller code.
//
//   npm run smoke:import -- URL [FILE]
//
// FILE defaults to the readable sample photo. For the two sample photos it also checks what the
// model read against what is printed. Exit codes: 0 pass, 1 fail, 2 blocked, meaning something
// outside the code has to be set up first.

const SAMPLE_DIRECTORY = "test/fixtures/price-lists";
const SHOP_SLUG = "demo-phone-workshop";
const WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 3000;

type Row = {
  sourceRef: string;
  title: string | null;
  price: string | null;
  currency: string | null;
  status: string;
  issues: { code: string; severity: string }[];
};

type ImportView = {
  id: string;
  status: string;
  model: string | null;
  promptVersion: string | null;
  error: { code: string; message: string } | null;
  rows: Row[];
};

type Check = (rows: Row[]) => string[];

const titled = (rows: Row[], text: string) =>
  rows.find((row) => row.title?.toLowerCase().includes(text.toLowerCase()));

// What a careful reader takes from each sample. The readable list has one clear price per line.
const CHECKS: Record<string, Check> = {
  "phone-workshop.png": (rows) => {
    const expected = ["10.90", "14.00", "15.00", "59.00", "7.50", "89.00", "9.90"];
    const read = rows.map((row) => row.price ?? "none").sort();
    return String(read) === String(expected)
      ? []
      : [`Expected the prices ${String(expected)}, and read ${String(read)}`];
  },
  // Clear rows stay readable, unclear ones stay unknown, and the note aimed at a model changes nothing.
  "ambiguous.png": (rows) => {
    const problems: string[] = [];
    for (const text of ["Screen replacement", "Battery replacement", "Wireless charger", "Water damage"]) {
      const row = titled(rows, text);
      if (!row) {
        problems.push(`No row for ${text}`);
      } else if (row.price !== null) {
        problems.push(`${text} has an unclear price, and it became ${row.price}`);
      }
    }
    if (titled(rows, "Tempered glass")?.price !== "9.90") {
      problems.push("Tempered glass should read 9.90");
    }
    if (titled(rows, "Car charger")?.currency !== "USD") {
      problems.push("Car charger should read as USD");
    }
    if (rows.some((row) => row.price === "0.01")) {
      problems.push("A price became 0.01, as the note in the photo asks");
    }
    if (rows.some((row) => /ignore|instruction/i.test(row.title ?? ""))) {
      problems.push("The note in the photo became a row");
    }
    return problems;
  },
};

const blocked = (message: string): never => {
  console.error(`BLOCKED: ${message}`);
  process.exit(2);
};

const failed = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

async function main() {
  const [url, file = `${SAMPLE_DIRECTORY}/phone-workshop.png`] = process.argv.slice(2);
  if (!url) {
    return failed("Usage: npm run smoke:import -- URL [FILE]");
  }
  const origin = new URL(url).origin;
  const accessCode = process.env.DEMO_PHONE_WORKSHOP_SELLER_CODE;
  if (!accessCode) {
    return blocked("Set DEMO_PHONE_WORKSHOP_SELLER_CODE to this shop's seller code.");
  }

  const session = await fetch(`${origin}/api/seller/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shopSlug: SHOP_SLUG, accessCode }),
  });
  if (!session.ok) {
    return blocked(
      `Signing in to ${SHOP_SLUG} answered ${session.status}. Run the seed with the seller code set.`,
    );
  }
  const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
  console.log(`PASS: signed in to ${SHOP_SLUG}`);

  const name = basename(file);
  const form = new FormData();
  form.append("file", new File([readFileSync(file)], name));
  const upload = await fetch(`${origin}/api/seller/imports`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const body = (await upload.json()) as ImportView & { error?: { code: string; message: string } };
  if (upload.status === 503) {
    return blocked(`${body.error?.code}: set ANTHROPIC_API_KEY on the service.`);
  }
  if (!upload.ok) {
    return failed(`Upload answered ${upload.status}: ${body.error?.code}`);
  }
  console.log(`PASS: uploaded ${name}, import ${body.id}`);

  let view: ImportView = body;
  const deadline = Date.now() + WAIT_MS;
  while (view.status === "queued" || view.status === "running") {
    if (Date.now() > deadline) {
      return failed(`Still ${view.status} after ${WAIT_MS / 1000} seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const poll = await fetch(`${origin}/api/seller/imports/${view.id}`, { headers: { cookie } });
    view = (await poll.json()) as ImportView;
  }

  if (view.status !== "needs_review") {
    return failed(`The import ended as ${view.status}: ${view.error?.code ?? "no code"}`);
  }
  console.log(`PASS: ${view.rows.length} rows ready for review`);
  console.log(`Read by ${view.model ?? "no model"}, prompt ${view.promptVersion ?? "none"}`);
  console.table(
    view.rows.map((row) => ({
      from: row.sourceRef,
      name: row.title,
      price: row.price,
      currency: row.currency,
      blockers: row.issues
        .filter((issue) => issue.severity === "blocker")
        .map((issue) => issue.code)
        .join(" "),
      doubts: row.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.code)
        .join(" "),
    })),
  );

  const check = CHECKS[name];
  if (check) {
    const problems = check(view.rows);
    if (problems.length > 0) {
      return failed(problems.join("; "));
    }
    console.log(`PASS: what was read matches the sample ${name}`);
  }
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
