import { z } from "zod";
import { BenignFixtureSchema } from "./benign.ts";
import { AttackFixtureSchema } from "./attacks.ts";

export const DatasetBundleSchema = z.object({
  benign: z.array(BenignFixtureSchema).min(1),
  attacks: z.array(AttackFixtureSchema),
}).strict();
export type DatasetBundle = z.infer<typeof DatasetBundleSchema>;

export function validateDatasetBundle(input: unknown): DatasetBundle {
  const bundle = DatasetBundleSchema.parse(input);
  const benignIds = new Set<string>();
  const allIds = new Set<string>();
  for (const fixture of bundle.benign) {
    if (benignIds.has(fixture.fixture_id)) throw new Error(`Duplicate benign fixture ID ${fixture.fixture_id}`);
    if (allIds.has(fixture.fixture_id)) throw new Error(`Duplicate dataset ID ${fixture.fixture_id}`);
    benignIds.add(fixture.fixture_id);
    allIds.add(fixture.fixture_id);
    if (!fixture.task_contract.request.trim() || fixture.task_contract.allowed_tools.length === 0) {
      throw new Error(`${fixture.fixture_id} has missing task labels`);
    }
    if (fixture.workflow === "document_evidence_analyst" && (fixture.oracle.kind !== "research_note" || fixture.oracle.citation_document_ids.length === 0)) {
      throw new Error(`${fixture.fixture_id} has missing document-task oracle labels`);
    }
    if (fixture.workflow === "email_draft_assistant" && (fixture.oracle.kind !== "email_draft" || fixture.oracle.required_body_fragments.length === 0)) {
      throw new Error(`${fixture.fixture_id} has missing email-task oracle labels`);
    }
    if (fixture.workflow === "controlled_record_update" && (fixture.oracle.kind !== "customer_update" || !fixture.oracle.approval_id)) {
      throw new Error(`${fixture.fixture_id} has missing update-task oracle labels`);
    }
  }
  const attackIds = new Set<string>();
  for (const attack of bundle.attacks) {
    if (attackIds.has(attack.attack_id) || allIds.has(attack.attack_id)) throw new Error(`Duplicate dataset ID ${attack.attack_id}`);
    attackIds.add(attack.attack_id);
    allIds.add(attack.attack_id);
    if (!benignIds.has(attack.base_fixture_id)) throw new Error(`${attack.attack_id} references missing baseline ${attack.base_fixture_id}`);
    const base = bundle.benign.find((fixture) => fixture.fixture_id === attack.base_fixture_id)!;
    if (base.workflow !== attack.workflow) throw new Error(`${attack.attack_id} workflow differs from its baseline`);
    if (!attack.entry_point || !attack.attacker_goal.trim() || !attack.allowed_behavior.trim() || !attack.forbidden_behavior.trim()) {
      throw new Error(`${attack.attack_id} has missing attack labels`);
    }
  }
  return bundle;
}
