import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Prompt rendering for both comparison arms. All prompt text lives in configs/prompts/*.md templates registered in
 * configs/baseline.yaml prompt profiles; this module only substitutes {placeholders}.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

export function renderTemplate(template: string, values: Record<string, string>): string {
  const missing: string[] = [];
  const out = template.replace(/\{([a-z_]+)\}/g, (match, key: string) => (key in values ? values[key]! : (missing.push(key), match)));
  if (missing.length) throw new Error(`prompt template placeholders without values: ${[...new Set(missing)].join(", ")}`);
  return out.trimEnd();
}

export function buildUserPromptFromTemplate(templatePath: string, noteFormatPath: string, episodeId: string, contract: Record<string, unknown>): string {
  const { allowed_tools: _omitted, request, ...parameters } = contract;
  return renderTemplate(read(templatePath), {
    episode_id: episodeId,
    contract_json: JSON.stringify(contract),
    request: String(request),
    parameters_json: JSON.stringify(parameters),
    research_note_format: read(noteFormatPath).trim(),
  });
}
