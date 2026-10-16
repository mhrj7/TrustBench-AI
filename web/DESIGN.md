# TrustBench review site — design system

Source of truth for the website (`web/`) and the Figma reference file ("TrustBench — Design system"). Change values here
first, then in `web/src/styles/tokens.css` and Figma.

## Direction

**Instrument.** TrustBench measures whether defenses stop prompt injection in autonomous agents, and every number it
reports is backed by a hashed evidence record. The site reads like a measuring instrument: a dark graphite field, warm
off-white ink, and a single amber signal that only marks what matters (the primary action, an attack that got through, a
defense denial). No chart junk, no decoration: the data is the picture.

**The idea.** On this site, the evidence hash of every run becomes the door: each number, cell and bar opens into the runs
it counts, down to the raw record (report file, SHA-256, JSON pointer). The hero replays a real trace from the store, so
the first thing a visitor sees is an agent being steered and the gateway answering.

Guidance applied: Taste house rules (no gradients, glass, glows, eyebrow pills, tiny uppercase labels, index numbering,
accent words in headlines; one ground, one ink, one accent; two type families with mono only for real identifiers), the
Vercel web interface guidelines (focus-visible, semantic controls, tabular numbers, URL reflects state, reduced motion),
Emil Kowalski's easing and duration rules, and the LottieFiles motion tables (Premium archetype for marketing reveals,
Corporate for interface feedback).

## Colour

| Token | Value | Role |
| --- | --- | --- |
| `--ground` | `#0D0E10` | page field |
| `--tone-1` | `#15171A` | raised surface (one tone step) |
| `--tone-2` | `#1E2125` | second step: hover, table stripe, empty heatmap cell |
| `--tone-3` | `#2A2E33` | third step: selected, chart track |
| `--ink` | `#EDEBE6` | text and primary data marks |
| `--ink-2` | `#A6A59F` | secondary text (notes only) |
| `--ink-3` | `#6E6F6B` | tertiary: axes, disabled |
| `--signal` | `#FFB21F` | the one accent: primary action, attacker success, defense denial |
| `--signal-ink` | `#0D0E10` | text on signal |
| `--signal-dim` | `#6B4B0E` | signal at low intensity (heatmap floor) |

Data encoding: rates use one sequential ramp from `--tone-2` (0%) to `--ink` (100%) for good outcomes and from
`--tone-2` to `--signal` for attacker success. Never two hues fighting in one chart. Separate surfaces by tone steps,
never by lines or shadows. `color-scheme: dark`.

## Type

Families: **Instrument Sans** (variable, 400–700) for everything; **JetBrains Mono** only for run IDs, hashes, JSON and
code. Tabular figures (`font-variant-numeric: tabular-nums`) wherever numbers align.

| Style | Size (desktop / phone) | Weight | Leading | Tracking |
| --- | --- | --- | --- | --- |
| Display | 112 / 52 px (`clamp(52px, 8.4vw, 112px)`) | 600 | 0.92 | -0.03em |
| Headline | 56 / 34 px (`clamp(34px, 4.4vw, 56px)`) | 600 | 1.0 | -0.025em |
| Statement | 28 / 22 px | 500 | 1.25 | -0.015em |
| Body | 18 / 17 px | 400 | 1.55 | 0 |
| Small | 14 px | 500 | 1.45 | 0 |
| Figure | 64 / 44 px | 600 | 1.0 | -0.03em, tabular |
| Mono | 13 px | 450 | 1.5 | 0 |

Five sizes at most on a page; headlines two lines or fewer at every width (`text-wrap: balance`). Sentence case.

## Space and layout

Spacing scale (px): 4, 8, 12, 16, 24, 32, 48, 64, 96, 144, 200. Margins 32 desktop, 24 tablet, 16 phone. Twelve-column
grid, max content width 1360. Section gaps 160 desktop, 96 phone; gaps inside a section never above 64. Text blocks share
three left edges: the margin, column 4, column 7. Radius: 2px everywhere (square corners); one shape decision for all
controls.

## Components

- **Bar navigation:** wordmark, four links, one action. Plain bar, sticky, tone step on scroll, no blur.
- **Button:** flat; primary is `--signal` on `--signal-ink`, secondary is `--tone-2` with ink text. Height 44, padding 0 20.
  Hover lightens one step; press `scale(0.97)` 160ms; focus-visible 2px signal outline offset 2px.
- **Figure:** big tabular number + one-line caption; counts up once on first view.
- **Data table:** real table, tone-1 field, tone-2 row hover, no borders, tabular numbers, sticky header.
- **Evidence drawer:** slides in from the right (drawer curve), holds the run list behind an aggregate and the raw record.

## Motion

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` | entrances, UI feedback (80% of motion) |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | on-screen movement, chart morphs |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | drawer |
| `--dur-quick` | 160ms | press, hover |
| `--dur-standard` | 280ms | UI transitions |
| `--dur-slow` | 700ms | section reveals, chart draws |

Signature move: the hero trace replay, bars of a real run drawing left to right in time, the denied call landing in
signal. Entrances rise 24px with opacity, staggered 60ms (heading, text, figure), once per section. Charts draw with a
wave stagger of 30–40ms per mark, total under 500ms. Scroll: section reveals and one scroll-linked chart. Only transform
and opacity animate; `prefers-reduced-motion` keeps fades and removes travel. Content is visible without JavaScript
animation (reveals start from a visible state if scripts fail).

Figma reference: https://www.figma.com/design/ZryhjfSxX6T2vC8iYC4Mdg (variables Color/Space/Motion, text styles, Foundations specimen).
