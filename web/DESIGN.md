# TrustBench review site — design system

Source of truth for the website (`web/`). Change values here first, then in `web/src/styles/tokens.css`.

## Direction

**An interactive studio site that tells one story: a helper, a hidden trick, and a guard.** The interaction model follows
lusion.co (a physics stage you push around, a ribbon that trails the cursor, letter-roll labels, a pinned card that grows
as you scroll, an evidence grid, and an endless scroll that rolls into the next page). The motion vocabulary follows the
prompt-motion.com product-UI prompts (one continuous move, springs with no bounce, content swapping with a short blur).
Every number, chip and scene comes from the evidence files (`web/public/data/*.json`); nothing on a page is invented for
the illustration.

The overview, top to bottom:

1. **Physics stage** (`components/PhysicsHero.tsx`): glossy blue, black and white pieces pulled into a pile (Rapier
   physics in react-three-fiber). Red pieces are hidden tricks. The pointer is the guard: a kinematic ball that shoves the
   pile, and every trick it touches turns blue and is counted ("3 of 6 tricks stopped"). New tricks arrive once all are
   stopped. A child can play it without reading anything.
2. **Statement** with the cursor ribbon (`Ribbon` in `components/Interactive.tsx`): "Tricks hide. Guards check."
3. **Story**: four chapters beside a sticky dark stage that swaps scenes, built from the recorded example.
4. **Growing card** (`GrowCard`): "FLIP ▶ GUARD"; tilted rows of the run's real tool calls drift across it while it grows
   from an inset to full width.
5. **Flip the guard**: the recorded pair of runs replayed with the guard off and on.
6. **Results bento**, **evidence grid** (two-column cards with live mini visuals and rolling titles), the development
   evidence (paired morph, utility cost), and the call to action.
7. **Sticker sky** (`components/StickerSpace.tsx`, art in `components/stickers.ts`): the call to action floats on a dark
   sky of die-cut stickers (shield, lock, check, bug, trick, key, stars, bolt, document, helper, eye) that drift in zero
   gravity and flick away from the pointer; the white footer follows.
8. **Journey** (`components/Journey.tsx`, `components/Shaders.tsx`): after the reference site's device sequence. An
   iPad with a liquid-metal frame (Paper Shaders `LiquidMetal`, Apache-2.0) shows the astronaut above a glowing planet;
   scrolling tips it flat and grows it to the full screen over a ShaderGradient nebula (MIT); "step inside the test"
   splits apart; the camera flies through a chrome lattice whose rings turn in opposite directions, with captions from the
   evidence; a white flash opens into a blue corridor cut with the site's shapes; the device shrinks back to its slot.
   The astronaut is "Astronaut" by Poly (Google), CC BY 2.0 (`lib/models.ts`, credited on the page).
9. **Endless scroll** (`NextPage`): after every page's footer, keep scrolling and the next page in the tour arrives.
   Only a person's own wheel, touch or key scrolling finishes the hand-off, so scripted scrolling never navigates.

**How it works** (`pages/How.tsx`, `components/SystemModel.tsx`): a 3D model of what really happens when you press Run on
the Live page, pinned while you scroll. Eleven modules on a dark grid, in the order a run reaches them: the browser (a
laptop showing the Live page), the live service (server tower, mode drawers, key vault), the job queue (lanes and
workers), the runner (a process group), the fixtures (pages, one carrying the trick), the agent (core, three provider
towers, a dashed socket for the planned external agents), the two arms, the guard (one ring per layer, a refused packet
in red), the tool service (ten named tools around the case database), the scorer (three verdict lamps) and the report,
whose result arcs back to the browser. The camera starts on the whole system and flies to each module; the one in focus
opens up. Captions and counts come from `pipeline.json` (configs/site-pipeline.json and configs/live-service.yaml).

Across the site: **water ripples** under the cursor (`components/Water.tsx`): each ripple refracts the real page through an
SVG displacement filter used as `backdrop-filter` (Chromium); other browsers show the highlight ring only. **Barrel scroll**
(`useBarrel` in `components/Interactive.tsx`): cards tilt as they travel up the screen, like panels on the inside of a drum.
**Menu**: the sheet unfolds with a clip-path spring and its numbered links rise in one after another.

## Colour

| Token | Value | Role |
| --- | --- | --- |
| `--ground` / `--floor-edge` | `#F0F1FA` / `#E7E8F4` | page floor (lavender white) |
| `--tone-1` / `--tone-2` / `--tone-3` | `#FFFFFF` / `#E4E6EF` / `#D5D8E6` | cards, light pills, tracks |
| `--ink` / `--ink-2` / `--ink-3` | `#0D0E13` / `#4B4E5F` / `#8A8DA0` | text; `--ink-3` is the quieter half of a headline |
| `--stage` | `#14161D` | dark 3D stages and cards |
| `--accent-2` | `#2B2E3A` | the dark pill (primary action) |
| `--accent` = `--safe` | `#2433FF` | the guard: a stopped call, a safe outcome, focus |
| `--danger` = `--signal` | `#EF3B24` | the trick: attacker success |
| `--data-1` / `--data-2` | `#0D0E13` / `#B9BCCB` | neutral data series |

Blue and red keep one meaning each across every page. Heatmap rates ramp from `--tone-2` to red (bad outcomes) or blue
(good ones). `prefers-reduced-transparency` replaces glass with solid white; `prefers-contrast: more` darkens lines and
secondary ink.

## Type

**Geist** (variable) for everything, **JetBrains Mono** for tool names, run IDs, hashes and the hidden instruction. Large
sizes run light (450) and tight (-0.045em). Buttons, tags and labels are 12–13px uppercase with 0.04–0.06em tracking.

| Style | Size | Weight |
| --- | --- | --- |
| Display | `clamp(48px, 7.4vw, 120px)` | 450 |
| Headline | `clamp(38px, 5.6vw, 92px)` | 450 |
| Statement | `clamp(21px, 2vw, 27px)` | 500 |
| Body | `clamp(17px, 1.2vw, 18px)` | 400 |
| Small | 14px | 500 |
| Mono | 13px | 450 |

Headings stay within two lines at every width (the Playwright suite checks it).

## Space and layout

Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96, 144, 200. Margins 32 / 24 / 16; max content width 1400; section gaps
144 / 112 / 88. Radius 14px controls, 28px cards and stages, pill for buttons. "+" crosshair rules frame the stage and the
growing card.

## Motion

Springs first (`{ type: 'spring', bounce: 0 }`), interruptible. Lenis smooth scrolling (lerp 0.085, its own frame loop,
smooth in-page anchors, nested scrollers left native). Letter roll: each letter lifts to its copy, 14ms apart. The 3D loop
pauses off screen and in hidden tabs. `prefers-reduced-motion`: native scrolling, physics stands still, no ribbon, no
roll, the growing card and the hand-off render as plain blocks.
