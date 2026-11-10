import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TaskContext } from "@renderinc/sdk/workflows";

import { readWorkflowRevision, registerWorkflowRevisionTask } from "../../../workflows/revision";

const tempDirs: string[] = [];
const REVISION = "a".repeat(40);

function tempFile(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentshelf-workflow-marker-"));
  tempDirs.push(dir);
  const path = join(dir, "workflow-revision.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workflow revision marker", () => {
  it("reads and validates the source-stamped artifact", () => {
    const path = tempFile(JSON.stringify({ revision: REVISION }));
    expect(readWorkflowRevision(path)).toBe(REVISION);
  });

  it("allows an unstamped local task server without adding a marker", () => {
    expect(registerWorkflowRevisionTask(undefined)).toBeUndefined();
  });

  it("fails clearly on Render if the build stamp is missing", () => {
    expect(() => registerWorkflowRevisionTask(undefined, true)).toThrow("required on Render");
  });

  it("registers a zero-argument task whose name and result identify the exact build", async () => {
    const marker = registerWorkflowRevisionTask(REVISION);
    expect(marker?.name).toBe(`revision_${REVISION}`);
    expect(marker?.func({ metadata: {} } as TaskContext)).toBe(REVISION);
  });

  it("refuses malformed artifact data", () => {
    expect(() => readWorkflowRevision(tempFile("{}"))).toThrow("invalid revision");
    expect(() => readWorkflowRevision(tempFile("not json"))).toThrow("invalid JSON");
    expect(() => registerWorkflowRevisionTask("deadbeef")).toThrow("full commit SHA");
  });
});
