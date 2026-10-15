"""Deterministic outcome evaluators for TrustBench trajectories."""

from .contracts import OutcomeEvaluation, ToolRecord
from .outcomes import evaluate_outcome

__all__ = ["OutcomeEvaluation", "ToolRecord", "evaluate_outcome"]

from .outcomes_v2 import evaluate_outcome as evaluate_outcome_v2  # tb016.1.1.0 (post-pilot fixes, see protocol/amendments.md A-002)
