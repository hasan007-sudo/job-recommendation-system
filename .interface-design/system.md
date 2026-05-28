# Design System — /onboarding (Rounds prototype)

Scope: applies to the `/onboarding` route only. The existing `/` page uses the
project's older plain-CSS system and is intentionally left untouched.

## Direction
- **Personality:** editorial / diaristic. A candidate's notebook, not a SaaS dashboard.
- **Audience:** student or early-career candidate on a phone.
- **Foundation:** warm cream paper, warm ink, single vermillion accent (sparing).
- **Depth strategy:** borders-only (hairline rgba), no shadows.

## Tokens
### Spacing
Base: 4px
Scale: 4, 8, 12, 16, 24, 32, 48

### Color (named for the world, not numeric scales)
```
--paper      #F5F1E8   /* cream A4 background */
--paper-2    #FFFCF4   /* page-on-paper (one elevation up) */
--ink        #14110D   /* primary text */
--ink-2      #4A4438   /* secondary text */
--ink-3      #8C857A   /* tertiary / metadata */
--ink-4      #B5AFA1   /* placeholder / disabled */
--rule       rgba(20,17,13,0.10)  /* standard hairline */
--rule-soft  rgba(20,17,13,0.05)  /* softer separation */
--rule-strong rgba(20,17,13,0.20) /* emphasis / focus ring */
--accent     #C2451D   /* vermillion — parsing dot, CTA arrow, banner rule */
--accent-soft rgba(194,69,29,0.10)
```

### Typography
- Display: **Instrument Serif** — italic for accent words ("résumé", "yourself")
- Body: **Newsreader** (variable, with optical sizing)
- Labels / data: **JetBrains Mono** — uppercase, tracked, for eyebrows and step counter
- Loaded via `next/font/google` scoped to `app/onboarding/layout.tsx`; not applied to the rest of the app.

### Radius
- Card: 10px
- Button (lg): 8px
- Pill / chip: full
- Input: 0 (bottom-border only)

## Patterns
### Step indicator
Mono `01 / 03` + a progressive ruler of segments (current segment longer + ink, previous segments faded ink, future segments rule).

### Section card
- `border: 1px solid var(--rule)`, `radius: 10px`, `background: var(--paper-2)`, `padding: 20px`.
- Label inside: mono 10px, uppercase, letter-spacing 0.22em, color `--ink-3`, hairline rule underneath.
- Manual-mode variant: dashed border using `--rule-strong`, placeholder copy in `--ink-4`.

### Input
- Underline only (`border-bottom: 1px solid var(--rule)`), grows to `--ink` on focus.
- No rectangle borders inside cards — feels like writing on ruled paper.

### Skill chip
- Solid ink pill, white text, 11px mono. Inline X to remove. New chip input is a dashed underline with `+ add` mono hint.

### Primary CTA
- Full-width ink bar, 56px tall, 8px radius. Text in Newsreader 15px. Arrow in vermillion (`--accent`).

### Editorial banner (parsed mode)
- Pull-quote style: 3px solid vermillion left rule, paper-2 background, mono eyebrow "EXTRACTED · {n}s", serif italic message underneath.

## Avoid
- Native `<select>`, native `<input type="date">`.
- Shadows of any kind (depth = borders-only).
- More than one accent (vermillion is the only color besides ink/paper/rule).
- 1px solid hex borders (always rgba hairlines from `--rule*`).
- Decorative gradients.
