# Design System — /onboarding (Rounds prototype)

Scope: applies to the `/onboarding` route. Extracted from the current
implementation (`app/onboarding/page.tsx`). The existing `/` page uses the
project's older plain-CSS system and is intentionally left untouched.

## Direction
- **Personality:** clean, modern SaaS. Calm neutral canvas, confident indigo accent.
- **Audience:** student or early-career candidate, on desktop or phone.
- **Foundation:** slate neutrals on a near-white canvas, single indigo accent for action + emphasis.
- **Depth strategy:** borders-first. Hairline slate borders define structure; shadows reserved for genuinely floating UI (menus, modals) only.

## Tokens

### Spacing
Base: 4px
Scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64
- `20` (gap-5) is an allowed half-step for two-column card grids and card header rhythm.
- Avoid `6px` (`*-1.5`) for layout gaps; reserve it only for tight label→field offsets.

### Color (Tailwind slate + indigo)
```
--canvas      slate-50    #F8FAFC   /* page background */
--surface     white       #FFFFFF   /* cards, dropzone, file row */
--surface-mut slate-50    #F8FAFC   /* muted button fill, inset wells */

--ink         slate-900   #0F172A   /* primary text, ink buttons */
--ink-2       slate-800   #1E293B   /* strong body */
--ink-3       slate-500   #64748B   /* secondary text, metadata */
--ink-4       slate-400   #94A3B8   /* placeholder, tertiary, disabled */

--border      slate-200   #E2E8F0   /* standard hairline border + dividers */
--border-2    slate-300   #CBD5E1   /* dropzone dashed border (idle) */

--accent      indigo-600  #4F46E5   /* primary action text, links, "add" */
--accent-500  indigo-500  #6366F1   /* hover border, icon glyphs */
--accent-soft indigo-50   #EEF2FF   /* accent icon backing, hover wash */

--success     emerald-500 #10B981   /* parse-complete check only */
```

Rules:
- Indigo is the **only** brand color. Everything else is slate or semantic.
- `--success` (emerald) is permitted **only** for the resume-parsed confirmation check. Do not introduce other greens/reds/yellows without extending this file.
- Use indigo for interactive affordances (links, primary action accents, focus); never for large fills.

### Typography
- Family: **Inter** (`--font-sans`, loaded in `app/layout.tsx`).
- Scale (px): display `44`, page-title `40`, lead `15–16`, body `14–15`, meta `12–13`, eyebrow/label `10–11`.
- Weight: headings `font-bold`; field values `font-semibold`; body `normal`; eyebrows `font-bold`.
- Line-height: headings `1.05`; body/lead `1.6` for readability.

### Letter-spacing (readability config)
- **Headings (≥32px):** `tracking-tight` (≈ -0.025em). Large type reads tighter.
- **Body / lead / values:** default (`0`). Never track body text.
- **Uppercase eyebrows (11px):** `tracking-[0.22em]`. Uppercase needs open tracking to stay legible.
- **Uppercase micro-labels (10px) & metadata:** `tracking-[0.18em]`. Slightly tighter than eyebrows because they're shorter strings.
- Rule of thumb: the smaller and more uppercase, the more tracking — and never track running prose.

### Radius (consistent ladder)
- Card / dropzone (large container): `rounded-2xl` (16px)
- File row / pitch card (medium container): `rounded-xl` (12px)
- Button / text input field: `rounded-lg` (8px)
- Chip / skill pill / logo mark: `rounded-md` (6px)
- Status dot / icon circle: `rounded-full`

### Borders (config)
- Standard: `1px solid --border` (slate-200) for cards, file rows, dividers, inputs.
- Dropzone idle: `2px dashed --border-2` (slate-300); on hover → `--accent-500` + `--accent-soft` wash.
- Focus: input border transitions to `--accent-500` (indigo-500) on `:focus`. No glow rings.
- Dividers between list rows: `divide-y --border`.
- Always use the slate hairline tokens — no raw hex borders, no `border-3`+ widths.

## Patterns

### Step indicator
Mono-spirited uppercase eyebrow in the header: `Step 01 / Onboarding` → `Step 02 / Profile review`. 11px, `tracking-[0.22em]`, `--ink-3`.

### Section card
- `border: 1px solid --border`, `radius: 16px (rounded-2xl)`, `background: --surface`, `padding: 24px (p-6)`.
- Header row: title (11px uppercase eyebrow, `--ink-3`) + optional right-aligned hint (11px uppercase, `--ink-4`), separated from body by a `border-b --border` with `pb-3`.

### Field / underline input
- `border-bottom: 1px solid --border`, transparent background, `pb-1.5`.
- Focus → border becomes `--accent-500`.
- `big` variant for scores: 20px bold; default: 15px semibold.
- Label above: 10px uppercase, `tracking-[0.22em]`, `--ink-3`, `mb-1.5`.

### Skill chip
- Light pill: `--surface-mut`/slate-100 background, `--ink-2` text, 12px medium, `rounded-md`, `px-2.5 py-1`.
- Inline X (`--ink-3`, hover `--ink`) to remove.
- Add control: bordered text input (`h-10`, `rounded-lg`, `--border`) + "Add" button (muted fill).

### Primary CTA
- Ink button: `--ink` (slate-900) background, white text, `rounded-lg` (8px), `font-semibold`.
- Heights: page-primary `h-12` (48px); in-flow primary `h-11` (44px); secondary/utility `h-10` (40px). Pick one and stay consistent within a view.
- Trailing icon (e.g. `ArrowRight`) inherits white; the accent lives in links, not the ink button.

### Link / tertiary action
- Indigo text (`--accent`), `font-semibold`, underline on hover. Used for "Enter details manually →", "Add entry", inline "browse".

### Dropzone (upload)
- `2px dashed --border-2`, `rounded-2xl`, white fill, generous vertical padding.
- Hover: border → `--accent-500`, background → `--accent-soft`.
- Centered indigo icon disc (`--accent-soft` bg, `--accent-500` glyph) + headline + hint + ink "Select file" button.

### Parse status row
- File row card with `FileText` glyph, filename, and a mono-styled uppercase status line (`reading…` / `extracted · {n}s` / error).
- Spinner (`Loader2`) while parsing; `--success` check disc when done.

## Avoid
- Second accent colors (indigo is the only brand hue; emerald is success-only).
- Shadows on cards/inputs/buttons (depth = borders). Shadows allowed only for true overlays (menus/modals).
- Raw hex borders or widths above 2px.
- Tracking on body/lead/running text.
- Off-ladder radii (mixing, e.g., `rounded-3xl` or arbitrary `rounded-[14px]`).
- Native `<select>` / native `<input type="date">`.
