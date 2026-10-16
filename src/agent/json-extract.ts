/**
 * Extracts the model's final JSON value from free text (A-019). Reasoning blocks some models emit inline
 * (<thought>...</thought>, <think>...</think>) are removed first, because they may contain draft JSON. Then the last
 * fenced ```json block is used, else the last balanced JSON value of the requested kind. Returns null when none parses.
 */
const REASONING_BLOCKS = /<(thought|think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;

function balancedCandidates(text: string, open: "{" | "["): string[] {
  const close = open === "{" ? "}" : "]";
  const out: string[] = [];
  // Top-level spans only: after a complete span the scan resumes after it, so nested objects are never candidates.
  let start = text.indexOf(open);
  while (start >= 0) {
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) { end = i; break; }
    }
    if (end < 0) { start = text.indexOf(open, start + 1); continue; } // a stray unclosed brace in prose: try the next one
    out.push(text.slice(start, end + 1));
    start = text.indexOf(open, end + 1);
  }
  return out;
}

export function extractJson(text: string, kind: "object" | "array" = "object"): unknown | null {
  const visible = text.replace(REASONING_BLOCKS, " ");
  const fits = (v: unknown) => (kind === "array" ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v));
  const fences = [...visible.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]!.trim());
  for (const candidate of [...fences.reverse(), ...balancedCandidates(visible, kind === "array" ? "[" : "{").reverse()]) {
    try { const v = JSON.parse(candidate); if (fits(v)) return v; } catch { /* try the next candidate */ }
  }
  return null;
}
