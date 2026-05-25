# Interview Rounds Prototype

Standalone Next.js prototype for resolving interview round counts from company, role, skills, and experience.

## Databases

### `SOURCE_DATABASE_URL`

Existing job-postings database. It is read-only for this prototype.

Stored data:

- scraped job postings
- company names from jobs
- raw job titles and raw role labels
- required skills extracted from job descriptions
- experience ranges from job descriptions

Use:

- bootstrap companies, role profiles, and skill vocabulary
- never stores admin-verified interview plans
- never decides the final number of interview rounds

### `ROUND_DB_URL`

New product database for this web app.

Stored data:

- companies users can choose
- normalized role profiles such as `frontend_engineer + entry`
- skills used for role detection
- role-to-skill weights for matching a user skill set to a role profile
- admin-owned interview plans
- ordered interview rounds for each plan
- imported source job rows used to show company-specific available roles

Use:

- source of truth for round count
- source of truth for the ordered interview process
- target DB for Prisma schema push and seed/import scripts

Do not run writes against `ROUND_DB_URL` until confirmed.

## Resolution Flow

```text
company + role + experience
  -> derive seniority
  -> find role profile
  -> company-specific plan
  -> fallback global role plan
  -> count interview rounds

skills + experience
  -> score role profiles from RoleProfileSkill
  -> derive seniority
  -> find role profile
  -> global role plan
  -> count interview rounds
```
