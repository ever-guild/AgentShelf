import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeWorkflowRevisionArtifact } from "./write-workflow-revision.mjs";

const tempDirs = [];

function tempDir() {
  const cwd = mkdtempSync(join(tmpdir(), "agentshelf-workflow-revision-"));
  tempDirs.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const cwd of tempDirs.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("workflow build revision stamp", () => {
  it("writes the full SHA returned by its Git HEAD reader into the build artifact", () => {
    const cwd = tempDir();
    const head = "a".repeat(40);

    expect(writeWorkflowRevisionArtifact({ cwd, readHead: () => `${head}\n` })).toBe(head);
    expect(JSON.parse(readFileSync(join(cwd, ".generated/workflow-revision.json"), "utf8"))).toEqual({ revision: head });
  });

  it("fails clearly when the checkout has no committed HEAD and writes no artifact", () => {
    const cwd = tempDir();
    expect(() => writeWorkflowRevisionArtifact({ cwd, readHead: () => { throw new Error("not a Git checkout"); } })).toThrow("Git HEAD is unavailable");
    expect(existsSync(join(cwd, ".generated/workflow-revision.json"))).toBe(false);
  });

  it("rejects a value that is not a full SHA even if the Git lookup returns it", () => {
    const cwd = tempDir();
    expect(() => writeWorkflowRevisionArtifact({ cwd, readHead: () => "deadbeef\n" })).toThrow("not a full commit SHA");
    expect(existsSync(join(cwd, ".generated/workflow-revision.json"))).toBe(false);
  });
});
