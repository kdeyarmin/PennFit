# CareMetric Breathe — User Manual

`CareMetric-Breathe-User-Manual.pdf` is the comprehensive, role-organised
operator manual for the platform. It is built from source in this folder
and is regenerable.

## What's in it

1. **Cover + page-numbered Table of Contents.**
2. **Introduction** — platform vs. tenant, signing in, the four roles, and
   the in-app assistants.
3. **What Sets CareMetric Breathe Apart** — the differentiators and the
   shared platform foundations.
4. **The Business Case — More Revenue, Less Labor** — revenue levers, the
   biller's job transformed (clean claims, pre-bill eligibility, AI denial
   fix/resubmit → paid faster, less audit-prone), and the labor/cost-savings
   estimate.
5. **Running the Business — the Owner's Playbook** — what to watch and when,
   how to monitor every area from one screen, the report catalog, and the
   KPI benchmarks the platform tracks to keep you ahead.
6. **Setup Guide** — what must be configured before going live, and an
   explanation of **every Control Center toggle** (default state + what it
   does when on/off).
7. **Part 1 — Feature Summary by Role** — a one-line description of every
   feature, grouped by role (Administrator, Biller, CSR, Respiratory
   Therapist).
8. **Part 2 — Comprehensive Feature Reference by Role** — the full detail on
   each feature, including deep-dives on the billing engine (Biller), the
   resupply engine + e-signature + provider portal (CSR), and the
   manufacturer integrations + alerts/compliance (RT).
9. **Part 3 — Job Aides by Role** — curated step-by-step walkthroughs for the
   highest-value tasks.
10. **Appendix** — role/permission matrix, competitive comparison, glossary.

> This is distinct from `manual.html` / `render.mjs` in this same folder,
> which build the shorter **PennPaps Customer Service Manual** PDF that staff
> invite emails attach at runtime. Leave those as-is.

## Regenerating the PDF

```bash
pip install reportlab Pillow
python3 docs/user-manual/build_user_manual.py
# → docs/user-manual/CareMetric-Breathe-User-Manual.pdf
```

All prose, the role feature lists, and the job aides live in the `ROLES` /
`SUMMARY` / `DETAIL` / `JOB_AIDES` / `PREREQS` / `GLOSSARY` structures at the
top of `build_user_manual.py`. Edit those and re-run. The Control Center
toggle tables are rendered from `feature-flags.json` (see below). The TOC is
built deterministically (pass 1 captures each heading's page; pass 2 renders
the TOC) so its page numbers are always exact.

## Refreshing the Control Center toggle list

`feature-flags.json` is the toggle catalog the Setup Guide renders. It is
extracted from the seed migrations — the source of truth is
`FEATURE_FLAG_KEYS` in
`artifacts/resupply-api/src/lib/feature-flags.ts` plus the
`(key, enabled, description, category)` rows seeded across
`lib/resupply-db/migrations/*.sql` (base seed: `0149_feature_flags.sql`).
When a flag is added, retired, or its description changes, regenerate
`feature-flags.json` from those migrations and re-run the build.

## Refreshing screenshots

Screenshots in `screenshots/` are captured from the SPA running in **demo
mode** (the client-only sandbox in `artifacts/cpap-fitter/src/demo/`), so no
backend, database, or auth is required:

```bash
pnpm exec playwright install chromium            # once, if needed
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/cpap-fitter dev &   # SPA only
node docs/user-manual/capture-manual-screens.mjs # → docs/user-manual/screenshots/*.png
```

`capture-manual-screens.mjs` forces demo mode via the
`pennfit:demo-mode:v1` localStorage flag and visits the storefront plus the
key admin pages for each role. A few admin pages don't have full demo
fixtures and render an error state — those names are intentionally omitted
from the build's screenshot calls (the manual's prose never depends on a
screenshot to be understood).
