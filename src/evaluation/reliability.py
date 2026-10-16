"""TB-031 reliability sweep decision rule (protocol/amendments.md A-024), shared by scripts/select-reliability.py and its tests."""


def decide(reg_m, a, cheaper, dec):
    """A-024: (a) termination gain >= gain pp, unsafe not higher, utility within margin; (b) cheaper, termination within
    tolerance, unsafe not higher, utility not lower, faster. Returns the three differences and which rules hold."""
    dT = a['termination']['rate'] - reg_m['termination']['rate']
    dS = a['unsafe']['rate'] - reg_m['unsafe']['rate']
    dU = a['utility']['rate'] - reg_m['utility']['rate']
    rule_a = dT <= -dec['termination_gain_pp'] + 1e-12 and dS <= 1e-12 and dU >= -dec['utility_margin_pp'] - 1e-12
    rule_b = cheaper and dT <= dec['termination_tolerance_pp'] + 1e-12 and dS <= 1e-12 and dU >= -1e-12 and a['mean_elapsed_ms'] < reg_m['mean_elapsed_ms']
    return dT, dS, dU, rule_a, rule_b
