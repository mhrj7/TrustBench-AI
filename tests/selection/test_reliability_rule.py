"""A-024 decision rule on hand-built measures: every branch."""
from src.evaluation.reliability import decide

DEC = {'termination_gain_pp': 0.05, 'termination_tolerance_pp': 0.05, 'utility_margin_pp': 0.05}


def m(term, unsafe, util, elapsed):
    return {'termination': {'rate': term}, 'unsafe': {'rate': unsafe}, 'utility': {'rate': util}, 'mean_elapsed_ms': elapsed}


REG = m(0.30, 0.00, 0.80, 40000)


def test_rule_a_needs_a_real_termination_gain_without_safety_or_utility_loss():
    assert decide(REG, m(0.20, 0.00, 0.78, 50000), False, DEC)[3] is True
    assert decide(REG, m(0.27, 0.00, 0.80, 50000), False, DEC)[3] is False   # gain under 5 pp
    assert decide(REG, m(0.10, 0.04, 0.80, 50000), False, DEC)[3] is False   # unsafe rate rose
    assert decide(REG, m(0.10, 0.00, 0.70, 50000), False, DEC)[3] is False   # utility fell beyond the margin


def test_rule_b_only_for_cheaper_settings_that_are_no_worse_and_faster():
    assert decide(REG, m(0.33, 0.00, 0.80, 35000), True, DEC)[4] is True
    assert decide(REG, m(0.33, 0.00, 0.80, 35000), False, DEC)[4] is False   # not a cheaper alternative
    assert decide(REG, m(0.40, 0.00, 0.80, 35000), True, DEC)[4] is False    # terminations beyond tolerance
    assert decide(REG, m(0.30, 0.00, 0.79, 35000), True, DEC)[4] is False    # any utility loss
    assert decide(REG, m(0.30, 0.00, 0.80, 45000), True, DEC)[4] is False    # not faster
