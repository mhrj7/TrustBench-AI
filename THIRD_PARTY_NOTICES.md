# Third-party notices

TrustBench-AI is MIT licensed (`LICENSE`). Its fixtures, workflows and tasks are synthetic and written for this project.
Third-party material, and what is and is not redistributed:

| Material | Where it appears | License | Redistributed here |
| --- | --- | --- | --- |
| AgentDojo attack templates (`important_instructions`, `injecagent`, `direct`, `ignore_previous`, `system_message`) and defense descriptions re-implemented from its source | `data/attack-renderings.json` (short template strings, with the source file and commit), `src/agent/defenses.ts` | MIT, Copyright (c) 2024 Edoardo Debenedetti, Jie Zhang, Mislav Balunovic, Luca Beurer-Kellner, Marc Fischer, and Florian Tramer; notice in [`third_party/licenses/AgentDojo-MIT.txt`](third_party/licenses/AgentDojo-MIT.txt) | the template strings only; the AgentDojo checkout itself is not included (`sh bin/trustbench fetch-data` clones the pinned commit from its official repository) |
| The `injecagent` wording | the same template, as AgentDojo ships it (it cites the InjecAgent paper, arXiv:2403.02691) | covered by AgentDojo's MIT notice | the one template string |
| npm and Python dependencies | `package-lock.json`, `web/package-lock.json`, `src/tools/requirements.lock`, `requirements/analysis.lock` | each package's own license | no: only the hash-pinned lockfiles; `npm ci` and `npm run setup` download them from their registries |
| "Animated Astronaut in Space Suit Loop" by LasquetiSpice (Sketchfab) | `web/src/assets/astronaut-wave.glb`, the astronaut of the home page's journey and the one that lands and waves at its end | CC BY 4.0 (credited on the page) | yes: a web copy, changed by us: textures resized to 1024 px and re-encoded as WebP, geometry and animation compressed (glTF Transform `optimize`, meshopt) |
| "iPad Pro Space Gray with M2 Chipset" by CitrixStorm2222 (Sketchfab) | `web/src/assets/ipad.glb`, the tablet the journey starts in | CC BY 4.0 (credited on the page) | yes: a web copy, changed by us: textures re-encoded as WebP, geometry meshopt-compressed (glTF Transform `optimize`) |
| "iMac 2021" by DatSketch (Sketchfab) | `web/src/assets/imac.glb`, the desktop screen the astronaut breaks out of | CC BY 4.0 (credited on the page) | yes: a web copy, changed by us: textures re-encoded as WebP, geometry meshopt-compressed (glTF Transform `optimize`); recoloured at runtime |
| "Earth" by airstudios3d (Sketchfab) | `web/src/assets/earth.glb`, the planet under the astronaut at the start of the journey | CC BY 4.0 (credited on the page) | yes: a web copy, changed by us: geometry simplified to a fifth, the 4096 px textures resized to 2048 px and re-encoded as WebP, meshopt-compressed (glTF Transform `optimize`); recoloured at runtime |
| Base container images (Node, uv) | `Dockerfile.*`, `repro/run-in-container.sh` | their own licenses | no: referenced by digest, pulled by Docker |

Published papers and systems compared in `research/related-work.csv` are cited, not redistributed.
