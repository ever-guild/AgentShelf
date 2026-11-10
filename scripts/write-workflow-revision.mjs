import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;

/** Write a build artifact from the checked-out source revision, never from a caller-supplied SHA. */
export function writeWorkflowRevisionArtifact({ cwd = process.cwd(), readHead } = {}) {
  let revision;
  try {
  revision = (readHead ?? (() => execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })))().trim().toLowerCase();
  } catch {
    throw new Error("Cannot stamp workflow build: Git HEAD is unavailable.");
  }
  if (!FULL_COMMIT.test(revision)) {
    throw new Error("Cannot stamp workflow build: Git HEAD is not a full commit SHA.");
  }

  const path = join(cwd, ".generated", "workflow-revision.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ revision })}\n`, { encoding: "utf8" });
  return revision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const revision = writeWorkflowRevisionArtifact();
  console.log(`Stamped workflow build revision ${revision}.`);
}
