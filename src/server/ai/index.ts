import { createClaudeAi } from "./claude";
import type { ImportAi } from "./types";

// The one place that picks the provider. Undefined when none is configured, which leaves CSV import
// working and turns photo import and suggestions off with a clear message.
export function createImportAi(
  env: Record<string, string | undefined>,
): ImportAi | undefined {
  return createClaudeAi(env);
}
