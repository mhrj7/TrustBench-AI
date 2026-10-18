# Third-party notices

TrustBench-AI is MIT licensed (`LICENSE`). Its fixtures, workflows and tasks are synthetic and written for this project.
Third-party material, and what is and is not redistributed:

| Material | Where it appears | License | Redistributed here |
| --- | --- | --- | --- |
| AgentDojo attack templates (`important_instructions`, `injecagent`, `direct`, `ignore_previous`, `system_message`) and defense descriptions re-implemented from its source | `data/attack-renderings.json` (short template strings, with the source file and commit), `src/agent/defenses.ts` | MIT, Copyright (c) 2024 Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramer; notice in [`third_party/licenses/AgentDojo-MIT.txt`](third_party/licenses/AgentDojo-MIT.txt) | the template strings only; the AgentDojo checkout itself is not included (`sh bin/trustbench fetch-data` clones the pinned commit from its official repository) |
| The `injecagent` wording | the same template, as AgentDojo ships it (it cites the InjecAgent paper, arXiv:2403.02691) | covered by AgentDojo's MIT notice | the one template string |
| npm and Python dependencies | `package-lock.json`, `web/package-lock.json`, `src/tools/requirements.lock`, `requirements/analysis.lock` | each package's own license | no: only the hash-pinned lockfiles; `npm ci` and `npm run setup` download them from their registries |
| "Astronaut" 3D model by Poly (Google), as shipped in google/model-viewer `packages/shared-assets` | `web/src/assets/astronaut.glb`, shown in the website's journey and ending scenes | CC BY 2.0 (attribution in model-viewer's `ATTRIBUTIONS.md`; credited on the page) | yes: the unmodified GLB file |
| Base container images (Node, uv) | `Dockerfile.*`, `repro/run-in-container.sh` | their own licenses | no: referenced by digest, pulled by Docker |

Published papers and systems compared in `research/related-work.csv` are cited, not redistributed.
