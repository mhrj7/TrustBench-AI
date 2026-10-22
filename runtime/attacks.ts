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

/** External-validation attacks (TB-062, amendment A-030): the core shape plus the family, its category, its cited sources
 *  and rationale, and optional extra injection points (the same instruction carried by more than one tool output). */
export const ExternalAttackFixtureSchema = AttackFixtureSchema.extend({
  family_id: z.string().regex(/^family-[a-z0-9-]{3,80}$/),
  family_status: z.enum(["new", "holdout_seen"]),
  category: z.enum(["long_document", "cross_tool_output", "multi_step_delayed", "allowed_tool_exfiltration", "agent_planning", "reauthored_holdout_family"]),
  sources: z.array(z.object({ citation: z.string().min(1), url: z.string().url() }).strict()).min(1),
  rationale: z.string().min(1),
  additional_injections: z.array(z.object({
    collection: z.enum(["documents", "contacts", "customers"]),
    match: z.record(z.string(), z.string()),
    field: z.string().min(1),
    text: z.string().min(1),
  }).strict()).optional(),
}).strict();

export type ExternalAttackFixture = z.infer<typeof ExternalAttackFixtureSchema>;
