# TrustBench review site — design system

Source of truth for the website (`web/`). Change values here first, then in `web/src/styles/tokens.css`.

## Direction

**A product page that tells a story, backed by an instrument.** TrustBench measures whether a guard stops AI helpers
from being tricked by hidden instructions in what they read. The overview explains this so a ten-year-old can follow it:
a hero with a live 3D scene (the helper, the documents it reads, one trap, and the guard's shield stopping each hidden
instruction), a four-chapter story, a switch that replays a real recorded pair of runs with and without the guard, and a
bento grid of results. Every number and every scene comes from the evidence files (`web/public/data/*.json`); nothing on
the page is invented for the illustration. The evidence pages (Compare, Runs, Policy, Outcomes, Attribution, Evidence
index) keep the instrument rule: each number, cell and bar opens into the runs it counts, down to the raw record.

Guidance applied: the Apple design skill (springs with no bounce, interruptible motion, press feedback, translucent
materials for chrome, size-specific tracking, reduced motion / reduced transparency / increased contrast), the UI/UX Pro
Max data (Bento Box Grid style, scroll-triggered storytelling landing pattern, three.js performance rules), the Vercel web
interface guidelines (focus-visible, semantic controls, tabular numbers, URL reflects state) and Emil Kowalski's easing
and duration rules.

## Colour

| Token | Value | Role |
| --- | --- | --- |
| `--ground` | `#06070B` | page field |
| `--tone-1` / `--tone-2` / `--tone-3` | `#0C0E14` / `#131622` / `#1D2130` | raised surfaces, hover, chart tracks |
| `--ink` / `--ink-2` / `--ink-3` | `#F5F5F7` / `#A4A8B8` / `#6B7084` | text, secondary text, axes |
| `--accent` / `--accent-2` | `#7C83FF` / `#C084FC` | brand, primary action, focus, the guard |
| `--gradient` | indigo → violet → pink | primary buttons, wordmark, one accent word per hero |
| `--safe` | `#34D399` | the guard stopped something; task done |
| `--danger` (= `--signal`) | `#FB7185` | attacker success: the trick worked |
| `--data-1` / `--data-2` | `#7C83FF` / `#4A4F86` | neutral data series (two strengths) |
| `--glass` / `--glass-strong` | translucent tone-1 + `blur(22px) saturate(160%)` | nav, cards, drawer |

Data encoding: danger is reserved for attacker success and the trick getting through; safe for a stopped call; every
other series uses `--data-1` / `--data-2`. Heatmap rates ramp from `--tone-2` to `--danger` (bad outcomes) or to
`--accent` (good ones). `prefers-reduced-transparency` replaces glass with solid tone-1; `prefers-contrast: more` raises
line and secondary-ink contrast. `color-scheme: dark`.

## Type

Families: **Instrument Sans** (variable) for everything; **JetBrains Mono** only for run IDs, hashes, JSON, tool names
and the hidden instruction text. Tabular figures wherever numbers align. Tracking tightens as size grows (display
-0.035em, headline -0.03em, body 0).

| Style | Size | Weight |
| --- | --- | --- |
| Display | `clamp(48px, 7.2vw, 104px)` | 600 |
| Headline | `clamp(32px, 4.2vw, 56px)` | 600 |
| Statement | `clamp(21px, 2vw, 27px)` | 500 |
| Body | `clamp(17px, 1.2vw, 18px)` | 400 |
| Small | 14px | 500 |
| Figure | `clamp(44px, 4.8vw, 72px)` | 600, tabular |
| Mono | 13px | 450 |

Headlines stay at two lines or fewer at every width (`text-wrap: balance`). Sentence case.

## Space and layout

Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96, 144, 200. Margins 32 / 24 / 16 (desktop / tablet / phone); max
content width 1280; section gaps 144 / 112 / 88. Radius 14px for controls and small cards, 24px for bento cards and
panels, pill for chips and switches. Bento grid: 12 columns on desktop, cards span 4 / 6 / 8 / 12; one column on phones.

## Components

- **Hero 3D** (`components/Hero3D.tsx`, react-three-fiber): the helper (a glowing face that blinks and looks toward the
  pointer), seven orbiting documents, one red trap, hidden-instruction particles that stop at the shield, which flashes
  safe-green on each hit. No external assets. DPR capped at 2; the loop pauses off screen or when the tab is hidden, and
  renders a still frame under reduced motion. Lazy-loaded so the text paints first.
- **Story** (`components/Story.tsx`): four chapters; on wide screens a sticky stage swaps scenes (blur cross-fade) with
  the chapter in view; on phones each chapter carries its own scene. All scenes use the recorded example.
- **Guard switch** (Overview `Simulator`): segmented switch with a shared-layout thumb; replays the real tool calls of
  the chosen run and lands on a verdict.
- **Bento card** (`components/Bento.tsx`): glass, pointer-following glow, spring tilt on hover, press scale, enters on
  view. Holds dot grids, the interval bar, the split bar and the comparison race.
- **Bar navigation:** glass when scrolled, wordmark, links, Evidence index, gradient primary action.
- **Data table, evidence drawer:** glass panel, tabular numbers, drawer from the right with the drawer curve.

## Motion

Springs first (`{ type: 'spring', bounce: 0, duration: 0.5 }`), so every animation can be interrupted mid-flight. CSS
easings are only for colour and opacity:

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | colour, opacity, UI feedback |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | chart morphs |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | drawer |
| `--dur-quick` / `--dur-standard` / `--dur-slow` | 160 / 280 / 700ms | press, transitions, reveals |

Motion runs continuously where it explains something (the 3D scene, the story scenes, the replay), not only on scroll.
Only transform, opacity and filter animate. `prefers-reduced-motion` keeps fades, removes travel and stops the 3D loop.
Content is readable without JavaScript animation.

The Figma reference file made for the earlier "instrument" direction (amber on graphite) no longer matches this system.
