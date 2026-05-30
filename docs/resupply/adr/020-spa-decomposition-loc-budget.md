# ADR 020 — SPA file LOC budget + decomposition convention

## Context

The customer-storefront + admin SPA (`artifacts/cpap-fitter`) is
a Vite + React + Wouter app. Two files in it grew past the point
where they could be read end-to-end in one sitting:

| File                             | Pre-decomp LOC |
| -------------------------------- | -------------: |
| `pages/admin/patient-detail.tsx` |          4,556 |
| `pages/account.tsx`              |          2,148 |

In the period leading up to the
[5/13 app review](../../app-review-2026-05-13.md), `patient-detail.tsx`
grew by +574 LOC and `account.tsx` by +151 LOC while the cleanup
backlog (P2.1 / P2.2) saw zero progress. Every new feature wave
added a sibling tab or a new sub-section inline rather than
extracting a component. The feature wave was outpacing the
cleanup, and the cleanup was getting harder with every PR.

The May polish wave (PRs #254, #266, #267, #270, #271, #272, #274,
#275, #276, #277) is projected to extract ten sibling components —
six tabs from `patient-detail.tsx` and four sections from
`account.tsx` — once those PRs land. Projected once that wave lands:

| File                             | Post-decomp LOC | Reduction |
| -------------------------------- | --------------: | --------: |
| `pages/admin/patient-detail.tsx` |          ~2,500 |       45% |
| `pages/account.tsx`              |            ~800 |       63% |

This ADR codifies the budget that this work is intended to bring us
into and the convention every future extract should follow, so the
next feature wave doesn't unwind it.

## Decision

### LOC budgets

| File                             | Soft budget | Hard ceiling |
| -------------------------------- | ----------: | -----------: |
| `pages/admin/patient-detail.tsx` |   3,000 LOC |    4,000 LOC |
| `pages/account.tsx`              |   1,500 LOC |    1,800 LOC |
| Any new SPA page                 |   1,500 LOC |    2,500 LOC |

The **soft budget** is the target — a PR that pushes the file past
this gets a reviewer nudge ("consider extracting before adding").
The **hard ceiling** is the line where the PR doesn't land — the
reviewer requires either an extraction commit or a justification
that the current PR is fully self-contained refactor work.

The hard ceilings are intentionally above today's post-decomp LOC
so there's headroom for normal feature work without a treadmill.
The soft budgets bite first, and the hard ceiling is the
last-resort backstop.

### Decomposition convention

When extracting a tab / section / modal:

1. **New file under `components/<area>/<Name>.tsx`.** Pages that
   already host extracted siblings (`patient-detail.tsx` ↔
   `components/admin/`, `account.tsx` ↔ `components/account/`)
   continue with that pattern.
2. **One named export per file**, matching the function name. No
   default exports.
3. **Private helpers stay file-local**, not exported. The pattern
   of helpers like `portalStatusBadge`, `Field`,
   `PrescriptionAttachmentCell`, `GenerateSwoButton` is the goal —
   helpers move with the section they support and aren't
   re-exported.
4. **Imports follow the section.** A symbol used only inside the
   extracted block moves with it. Imports left orphaned in the
   parent must be dropped from the import list (the lint catches
   them).
5. **Comments + JSDoc move verbatim.** The "why this section
   exists" intro comments are part of the section; they don't stay
   in the parent.
6. **`role="alert"` on transient error displays** as you encounter
   them during the move — the moved file is the right place to
   apply the storefront a11y convention (PR #260, #273).
7. **Otherwise, zero behavior change in the same PR as the
   extract.** Aside from the a11y-only `role="alert"` markup above,
   if you want to refactor logic or add a feature, do it in a
   follow-up PR after the extract lands — the extract diff stays
   clean and reviewable as "this is purely a move."

### Naming

The pattern across the existing extracts:

- Tab inside a page → `<TabName>Tab.tsx` (e.g. `DocumentsTab`,
  `PortalTab`, `PrescriptionsTab`, `EquipmentTab`).
- Section of a page → `<SectionName>Section.tsx` (e.g.
  `DocumentsSection`, `ProfileSection`, `OrdersSection`,
  `SubscriptionsSection`).
- Page-action surfaces → no suffix (e.g. `PatientActionBar`,
  `AddPrescriptionModal`, `SettingsCard`).

Keep the suffix consistent so the file you're looking for is
predictable from the in-page label.

## What this means in practice

- **New feature wave touching `patient-detail.tsx` or
  `account.tsx`:** any contribution that pushes the file past the
  soft budget should extract one existing or new section before
  merging. Reviewers should ask "what could come out as part of
  this PR?" when the diff lands the file above target.
- **Extraction PRs are first-class.** A PR titled
  `refactor(admin): extract <X>Tab from patient-detail.tsx` is
  productive work, not a stylistic favor. The polish-plan series
  in May 2026 demonstrated the cadence: each extract is one PR,
  pure-refactor, zero behavior change, easy to review.
- **The hard ceilings are not advisory.** Crossing 4,000 LOC in
  `patient-detail.tsx` or 1,800 in `account.tsx` is a regression
  on a budget the team voted into existence. Surface it in
  review.

## What we deliberately did NOT do

- **No co-location of subcomponents inside the page file.** "Just
  add it inline, it's only used once" is the road back to 4,500
  LOC. The sibling file convention costs ~30 seconds of file-
  switching per session and saves the parent.
- **No lint rule enforcing the budget today.** A CI ratchet that
  fails the build on every regression was considered but rejected
  for two reasons: (a) one-off churn during merge conflicts could
  trip it; (b) the cost of fixing a CI failure on a budget breach
  often pushes contributors to add `// eslint-disable-next-line`
  rather than to actually decompose. A reviewer call-out + this
  ADR is the lighter-weight control that's been working since the
  May polish wave.
- **No fancy split tooling.** Extracts happen by hand with the
  Edit / Read / sed flow. Nothing in this convention requires an
  AST-based refactor codemod; the file structure stays legible to
  any reader.

## Related

- [`docs/polish-plan-2026-05-20.md`](../../polish-plan-2026-05-20.md) Phase 4 PRs 4.1 + 4.2 — the original plan that drove the May 2026 decomposition.
- [`docs/app-review-2026-05-13.md`](../../app-review-2026-05-13.md) P2.1 + P2.2 — the regression call-out that surfaced the LOC growth.
- Decomposition PRs: #254 (DocumentsTab), #266 (PortalTab), #267 (PatientActionBar), #270 (AddPrescriptionModal), #271 (SettingsCard), #272 (PrescriptionsTab), #274 (DocumentsSection), #275 (ProfileSection), #276 (OrdersSection), #277 (SubscriptionsSection).
- This ADR is the canonical reference for the LOC budget and extraction convention for AI assistants and human reviewers until any shorter restatement is added elsewhere.
