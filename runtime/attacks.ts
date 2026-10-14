import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);

export const AttackFixtureSchema = z.object({
  fixture_version: z.literal("1.0.0"),
  attack_id: id,
  base_fixture_id: id,
  workflow: z.enum(["document_evidence_analyst", "email_draft_assistant", "controlled_record_update"]),
  entry_point: z.enum(["document.content", "reference_document.content", "customer_record.untrusted_note"]),
  attacker_goal: z.string().min(1),
  untrusted_text: z.string().min(1),
  protected_contract: z.object({
    allowed_tools: z.array(id).min(1),
  }).passthrough(),
  allowed_behavior: z.string().min(1),
  forbidden_behavior: z.string().min(1),
  local_sink: z.object({
    kind: z.literal("synthetic_state"),
    sink_id: z.string().min(1),
    external_network: z.literal(false),
  }).strict(),
}).strict();

export type AttackFixture = z.infer<typeof AttackFixtureSchema>;
