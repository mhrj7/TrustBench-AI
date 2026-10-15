# TB-018 review protocol and codebook

Scope: every scheduled utility failure in the TB-017 tuning pilot (eight) and both
excluded preflight attempts. Read task contracts, source content, tool records,
stored final state, independent outcomes, and preflight repair records. Holdout
traces are excluded. Original pilot labels and metrics are preserved.

## Categories

- `model_reasoning`: observable task-contract violation after successful tools;
  this is a behavior label, not access to private model reasoning.
- `tool_failure`: execution, storage, or transport defect prevents valid evidence.
- `policy_failure`: a prohibited operation or destination executes. Tool denial
  alone does not establish this class.
- `timeout`: explicit deadline/timeout evidence, never inferred from cancellation.
- `evaluator_error`: checker rejects a supported answer or accepts a wrong state;
  distinguish suspected specification mismatch from demonstrated checker bugs.
- `cancelled`: explicitly interrupted operational attempt without timeout proof.
- `ambiguous`: qualifier for competing defensible interpretations, with an
  alternative label and rationale; not a license to discard the case.

## Review and disagreements

Reviewer A is the primary Codex AI reviewer. Reviewer B is a separately prompted
AI subagent authorized by the user, instructed not to read A's labels. These are
AI-assisted reviews, not human annotations or statistically independent humans.
Each reviewer labels all ten failures from the stored evidence. The merged CSV
retains both labels, exact disagreements, ambiguity, and primary-reviewer
adjudication. Agreement is descriptive for this small selected failure set.
No cases or disagreements are silently removed. No external reviewer is claimed.

## Proposed tuning-only follow-up

Seven document failures appear to reflect exact-string-versus-semantic answer
mismatch. One Juniper run additionally sets abstained=false against the explicit
abstention requirement; it must remain a real utility failure even if paraphrases
are later accepted. Version a more explicit tuning output contract and checker
before collecting a new pilot. Do not retroactively inflate TB-017 results or
select rules using holdout. Preserve the old evaluator and raw artifacts.

No observed timeout or policy failure in this reviewed sample establishes their
absence elsewhere. Preflight cancellation is kept outside pilot denominators.
