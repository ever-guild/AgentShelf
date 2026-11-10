import { readFileSync } from "node:fs";
import { task, type TaskDefinition } from "@renderinc/sdk/workflows";

const FULL_COMMIT = /^[0-9a-f]{40}$/i;
const REVISION_PATH = new URL("../.generated/workflow-revision.json", import.meta.url);

export function readWorkflowRevision(
  path: string | URL = REVISION_PATH,
): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Workflow build revision artifact is invalid JSON.");
  }
  const revision = (value as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "string" || !FULL_COMMIT.test(revision)) {
    throw new Error("Workflow build revision artifact has an invalid revision.");
  }
  return revision;
}

export function registerWorkflowRevisionTask(
  revision: string | undefined,
  required = false,
): TaskDefinition<[], string> | undefined {
  if (revision === undefined) {
    if (required) {
      throw new Error("Workflow build revision artifact is required on Render.");
    }
    return undefined;
  }
  if (!FULL_COMMIT.test(revision)) {
    throw new Error("Cannot register a workflow revision task without a full commit SHA.");
  }
  return task({ name: `revision_${revision}` }, () => revision);
}
