# Rounds Prototype — Project Instructions

## UI / Design System (mandatory)

Whenever you create, edit, or restyle any UI — components, pages, layouts, CSS —
you **must** read and follow `.interface-design/system.md` first. It is the
source of truth for color, typography, spacing, borders, radius, and component
patterns.

Rules:
- **Scope:** the design system applies to the `/onboarding` route and any new UI
  built in its style. The legacy `/` page uses an older plain-CSS system and is
  left untouched unless explicitly asked.
- **Tokens over guesses:** use the colors, spacing scale, radius ladder, and
  letter-spacing values defined in `system.md`. Do not introduce off-palette
  colors, off-scale spacing, off-ladder radii, or new accent hues.
- **Accent discipline:** indigo is the only brand color; emerald is reserved for
  the parse-success check only.
- **Depth:** borders-first. No shadows on cards/inputs/buttons — shadows only for
  true overlays (menus, modals).
- **Readability:** never track body/running text; only track uppercase
  eyebrows/labels per the letter-spacing config.

After any UI change, sanity-check it against `system.md` (the
`/interface-design:audit` skill can do this). If a design need genuinely isn't
covered by the system, extend `system.md` first, then build — don't drift
silently.

## Stack
- Next.js (App Router) + TypeScript + Tailwind CSS v4 + Prisma.
- Icons: `lucide-react`.
