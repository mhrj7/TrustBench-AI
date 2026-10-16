# Gemma 4 comparison reports affected by the classifier-parser bug (A-019)

Copies of the reports used for the original pre-registered pooled analysis (A-014). On gemma-4-26b every directive_flow
classifier verdict was unparseable: the model writes its reasoning inline (`<thought>...</thought>`, containing a draft JSON
answer) and the greedy parser spanned both JSON copies, so the registered fail-closed rule denied every attributed write. The
original pooled result is shown in `docs/defense-comparison.md`, marked as confounded, next to the result of the rerun with
the fixed parser. `camel` is included because its parser changed too; it had no parse failures on Gemma.
