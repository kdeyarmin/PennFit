# Payer prior-authorization pathways (DME / PAP)

Per-payer research backing the `payer_profiles` prior-auth fields and the
auto-generated PA request form. Captures, for each catalog payer: whether
**CPAP/PAP (E0601 + accessories) needs a prior auth**, the **submission
system**, the **specific payer form** (where one exists), a key contact,
and the source. Grouped by parent org / shared portal because most PA
intake is portal-based and shared across a family's plans.

**Last researched:** 2026-06 · **Scope:** the ~40 PA-requiring payers in
the catalog (Medicare and most workers'-comp rows do not take a standard
DME PA — noted below).

## The one thing to know about a "CPAP PA form"

There is **no single, federally-standard CPAP prior-authorization form.**

- **Medicare does not require PA for PAP.** E0601/E0470/E0471 are **not** on
  the CMS _Required Prior Authorization List_ (that list is power mobility,
  certain orthoses, etc.). Medicare PAP is **documentation-driven** under
  LCD **L33718** / Policy Article **A52467**: a face-to-face evaluation
  before the sleep test, a qualifying sleep study (AHI/RDI ≥ 15, or 5–14
  with comorbidity), and a 31–91 day adherence re-evaluation. So the
  "form" for Medicare is the _clinical record_, not a PA request.
- **Commercial / Medicare-Advantage / Medicaid-MCO payers DO require PA**
  for capped-rental DME including CPAP — but each takes it through its own
  **provider portal** (Availity, NaviNet, UPMC Provider OnLine, the UHC
  portal, EviCore/HealthSpring, Cohere), not a downloadable PDF. A handful
  publish a **specific PDF intake form** (PA Medicaid's **MA 97**, PA Health
  & Wellness's **PA-PAF-1138**, Aetna's **Sleep Apnea Appliance** precert
  form, Keystone First's PA Request Form).

That is exactly why this repo generates **one universal PA request form**
(`lib/billing/pa-request-pdf.ts`) carrying the clinical data set every payer
adjudicates on: for a fax/portal-attach payer it _is_ the submission, and
for a payer that mandates its own PDF it's the clinical attachment that
backs that PDF. The per-payer "how" is the table below.

## Summary

| slug                                                                                                            | CPAP needs PA?                                                                                                  | Submission system                                        | Specific payer form                                                                 | Key contact                        |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| highmark_bcbs_pa / highmark_bs_pa                                                                               | Yes (capped rental)                                                                                             | **Availity**                                             | Highmark Medical Authorization Forms                                                | PA 1-866-488-7443                  |
| highmark_medicare_advantage                                                                                     | Yes                                                                                                             | **Availity**                                             | Highmark Medical Authorization Forms                                                | 1-866-488-7443                     |
| highmark_wholecare                                                                                              | Yes                                                                                                             | **NaviNet → GuidingCare**                                | — (portal)                                                                          | 1-800-392-1147                     |
| ibx                                                                                                             | Yes (DME monthly rental)                                                                                        | **NaviNet / ProviderAccess** Pre-Service Review          | — (portal)                                                                          | 1-800-ASK-BLUE                     |
| keystone_65 / personal_choice_65                                                                                | Yes                                                                                                             | **NaviNet / ProviderAccess**                             | — (portal)                                                                          | 1-800-275-2583                     |
| keystone_first                                                                                                  | Yes (rental any cost; purchase >$750)                                                                           | **NaviNet** (Medical Authorizations)                     | **Keystone First PA Request Form (PDF)**                                            | down-portal 1-800-521-6622         |
| amerihealth_caritas_pa                                                                                          | Yes (rental any cost; purchase >$750)                                                                           | **NaviNet**                                              | ACLA PA Request Form (PDF)                                                          | DME PA 1-855-540-7083              |
| health_partners_pa_medicaid                                                                                     | Yes                                                                                                             | **NaviNet / HPPlans portal**                             | — (portal)                                                                          | 1-888-991-9023                     |
| upmc_health_plan / upmc_for_you / upmc_for_life                                                                 | Yes                                                                                                             | **UPMC Provider OnLine** (attach CMN)                    | — (portal; CMN required)                                                            | Med Mgmt 1-800-425-7800            |
| geisinger_health_plan / geisinger_gold / geisinger_health_plan_family                                           | Yes (allowed > $500)                                                                                            | **NaviNet / Cohere**                                     | — (portal)                                                                          | care connector 1-888-839-7972      |
| capital_bc / capital_blue_senior                                                                                | Yes                                                                                                             | **NaviNet** (Capital BC portal)                          | — (portal)                                                                          | 1-800-471-2242                     |
| aetna_commercial / aetna_medicare_pa                                                                            | Yes                                                                                                             | **Availity**                                             | **Aetna Sleep Apnea Appliance Precert form** (oral appl.); CPAP via precert list    | non-MA 1-800-624-0756              |
| aetna_better_health_kids_pa                                                                                     | Yes                                                                                                             | **Availity** (Aetna Better Health)                       | — (portal)                                                                          | 1-855-346-9828                     |
| meritain_health                                                                                                 | Yes (per group)                                                                                                 | **Availity**                                             | — (portal)                                                                          | 1-800-925-2272                     |
| psers_hop                                                                                                       | Yes                                                                                                             | **Availity** (admin by Aetna)                            | — (portal)                                                                          | 1-800-773-7725                     |
| cigna_commercial                                                                                                | PAP = **registration** (not precert) via **EviCore**; DME PA → **HealthSpring** (eff 2026-03-01)                | **EviCore / CignaforHCP**                                | EviCore sleep mgmt forms                                                            | EviCore 1-800-298-4806             |
| cigna_medicare_pa                                                                                               | Yes                                                                                                             | **EviCore / CignaforHCP**                                | — (portal)                                                                          | 1-800-668-3813                     |
| uhc_commercial / uhc_community_plan_pa / uhc_dual_complete_pa                                                   | Yes                                                                                                             | **UHC Provider Portal** (Prior Auth & Notification tool) | — (portal)                                                                          | 1-877-842-3210, fax 1-855-352-1206 |
| umr                                                                                                             | Yes (per group)                                                                                                 | **umr.com** provider PA                                  | — (portal)                                                                          | per member card                    |
| aarp_uhc_medsup                                                                                                 | **No** (Medigap secondary/crossover)                                                                            | —                                                        | —                                                                                   | —                                  |
| humana_commercial / humana_gold_plus_pa                                                                         | Yes                                                                                                             | **Availity** (Humana PA search tool)                     | — (portal); decisions ≤ 72h                                                         | provider.humana.com                |
| wellcare_pa                                                                                                     | Yes                                                                                                             | **Wellcare provider portal**                             | — (portal)                                                                          | 1-855-538-0454                     |
| devoted_health_pa                                                                                               | Yes                                                                                                             | **Devoted provider portal**                              | — (portal)                                                                          | 1-877-762-3515                     |
| clover_health_pa                                                                                                | Yes                                                                                                             | **Clover provider portal**                               | — (portal)                                                                          | 1-888-778-1478                     |
| pa_health_and_wellness                                                                                          | Yes (CPAP supplies 1/5yr)                                                                                       | **Secure Provider Web Portal**                           | **PA-PAF-1138 Outpatient Medicaid PA Form**                                         | 1-844-626-6813                     |
| pa_medicaid_ffs                                                                                                 | Yes                                                                                                             | **PROMISe portal**                                       | **MA 97 Outpatient Services Authorization Request Form** (+ 1150 waiver for limits) | 1-800-537-8862                     |
| pa_chip                                                                                                         | Per contracted MCO                                                                                              | Bill contracted MCO; PA via that MCO                     | —                                                                                   | 1-800-986-KIDS                     |
| tricare_east                                                                                                    | Yes (DMEPOS auth; CMN/order required with claim)                                                                | **Humana Military provider portal**                      | CMN / physician order                                                               | 1-800-444-5445                     |
| va_ccn_region1                                                                                                  | **Referral/auth required for all care**; CCN rentals capped at 30 days (RFS to VA beyond)                       | **Optum (vacommunitycare.com)**                          | VA RFS for extended rental                                                          | 1-888-901-7407                     |
| medicare_pa_novitas                                                                                             | **No** (PAP routes to DME MAC; no PA)                                                                           | —                                                        | clinical record (LCD L33718)                                                        | —                                  |
| medicare_dme_noridian                                                                                           | **No** — E0601 not on CMS Required PA List                                                                      | —                                                        | clinical record (LCD L33718)                                                        | 1-866-419-9458                     |
| swif_pa_wc, pma_companies_wc, erie_insurance_pa, liberty_mutual_wc, travelers_wc, the_hartford_wc, sedgwick_cms | **No standard DME PA** — authorization is per the accepted WC claim via the **adjuster**; bill via Jopari/paper | adjuster / claim authorization                           | —                                                                                   | per claim adjuster                 |

## Family notes & sources

### Medicare (no PA for PAP) — `medicare_dme_noridian`, `medicare_pa_novitas`

PAP devices are **not** on the CMS _Required Prior Authorization List_ and
Medicare does not issue a PA for them; coverage is established by the
clinical record per LCD L33718. PA-beneficiary PAP claims route to the
**Noridian Jurisdiction A DME MAC**, not Novitas.
Sources: CMS DMEPOS Required Prior Authorization List (updated 2026-01-13);
CMS LCD L33718 / Article A52467.

### Highmark — `highmark_bcbs_pa`, `highmark_bs_pa`, `highmark_medicare_advantage`, `highmark_wholecare`

Commercial + Freedom Blue (MA): **all prior-auth requests go through
Availity**; DMEPOS requiring auth is published in Highmark's _List of
Procedures/DME Requiring Authorization_ (capped-rental CPAP requires PA).
**Highmark Wholecare** (Medicaid) is the exception — it uses **NaviNet**,
with UM requests submitted through **GuidingCare** via NaviNet.
Sources: providers.highmark.com → Authorizations / Forms; Highmark
_Proc-Requiring-Auth-list.pdf_; Highmark Wholecare provider-portal update.

### Independence / AmeriHealth Caritas — `ibx`, `keystone_65`, `personal_choice_65`, `keystone_first`, `amerihealth_caritas_pa`, `health_partners_pa_medicaid`

Independence commercial + Keystone 65 / Personal Choice 65 (MA): precert via
**ProviderAccess / NaviNet Pre-Service Review**; **DME monthly rentals
require precert regardless of cost**. Keystone First & AmeriHealth Caritas
PA (Medicaid): **NaviNet → Medical Authorizations** (Workflows); **rental any
cost + purchase > $750 require PA**; both publish a **Prior Authorization
Request Form (PDF)**. Health Partners Plans (Jefferson): provider portal /
NaviNet.
Sources: ibx.com preapproval-requirements; keystonefirstpa.com prior-
authorization (+ PA Request Form PDF); amerihealthcaritaspa.com provider.

### UPMC — `upmc_health_plan`, `upmc_for_you`, `upmc_for_life`

PA via **UPMC Provider OnLine**; the **Certificate of Medical Necessity
(CMN)** is expected as supporting documentation for DME. Medical Management
1-800-425-7800.
Source: upmchealthplan.com/providers → Medical PA forms.

### Geisinger — `geisinger_health_plan`, `geisinger_gold`, `geisinger_health_plan_family`

PA via **NaviNet**, now augmented by the **Cohere** portal (guided
submissions / auto-approvals). DME under a **$500 allowed amount needs no
PA**, so CPAP (above that) requires PA. Care-connector 1-888-839-7972.
Source: geisinger.org/health-plan/providers/authorization-forms-and-resources.

### Capital BlueCross — `capital_bc`, `capital_blue_senior`

PA via the Capital BlueCross provider portal (NaviNet). Tier-2 DME requires
PA. (Blues-standard; confirm current portal at capbluecross.com/providers.)

### Aetna / CVS Health — `aetna_commercial`, `aetna_medicare_pa`, `aetna_better_health_kids_pa`, `meritain_health`, `psers_hop`

PA via **Availity** (availity.com/aetnaproviders). Aetna publishes a
**Sleep Apnea Appliance Precertification Information Request Form** (PDF) —
that one is for _oral appliances_; CPAP precert is driven by the annual
**Participating Provider Precertification List** through Availity. Meritain
(self-funded TPA) and PSERS HOP (admin by Aetna) follow the same Availity
path under the group's rules. Non-Medicare precert 1-800-624-0756.
Sources: aetna.com precertification; Aetna 2026 Precert List; Sleep Apnea
Appliance precert form (PDF).

### Cigna — `cigna_commercial`, `cigna_medicare_pa`

Commercial sleep is managed by **EviCore**: diagnostic sleep studies need
precert, but **PAP devices require _registration_, not full precert**. DME
PA is **moving from EviCore to HealthSpring effective 2026-03-01**.
Eligibility/benefits via **CignaforHCP.com**. EviCore 1-800-298-4806.
Sources: static.cigna.com sleep management; CareCentrix Cigna DME Provider
Manual; cigna.com precertification.

### UnitedHealthcare / Optum — `uhc_commercial`, `uhc_community_plan_pa`, `uhc_dual_complete_pa`, `umr`, `aarp_uhc_medsup`

PA via the **UnitedHealthcare Provider Portal** "Prior Authorization and
Notification" tool (uhcprovider.com) — check member first for a Decision ID.
Also EDI, Provider Services 1-877-842-3210, fax 1-855-352-1206. **UMR**
(self-funded TPA) uses umr.com/provider/prior-authorization per group.
**AARP Medicare Supplement** is Medigap — no PA; it pays the 20% coinsurance
by crossover after Medicare.
Source: uhcprovider.com prior-auth-advance-notification; umr.com.

### Humana — `humana_commercial`, `humana_gold_plus_pa`

PA via **Availity**; use Humana's **PA search tool** (provider.humana.com) to
confirm requirement; decisions within **72 hours**. DME delivery receipts
also go through Availity.
Source: provider.humana.com coverage-claims/prior-authorizations.

### Centene — `pa_health_and_wellness`, `wellcare_pa`

PA Health & Wellness (Medicaid): **Secure Provider Web Portal**
(provider.pahealthwellness.com); specific form **PA-PAF-1138 Outpatient
Medicaid Prior Authorization Form**; 1-844-626-6813; **CPAP supplies limited
to 1 every 5 years**. Wellcare (MA/D-SNP): provider.wellcare.com portal.
Sources: pahealthwellness.com prior-authorization (+ PA-PAF-1138 PDF).

### PA Medicaid fee-for-service — `pa_medicaid_ffs`

PA via the **PROMISe** provider portal; the specific intake is the **MA 97 —
Outpatient Services Authorization Request Form**. To exceed program limits
(e.g., CPAP-supply frequency), use the **1150 Administrative Waiver (Program
Exception)** process.
Source: pa.gov/agencies/dhs FAQ-Prior-Authorization; MA 97 / MA 300X.

### Devoted, Clover (regional MA) — `devoted_health_pa`, `clover_health_pa`

PA via each plan's own provider portal (provider.devoted.com,
cloverhealth.com/en/providers). CPAP follows the plan's DME medical policy.
_(Lighter research — confirm the current portal/medical policy before
relying on turnaround.)_

### Federal — `tricare_east`, `va_ccn_region1`

**TRICARE East (Humana Military):** DMEPOS authorization required (all DMEPOS
for active-duty service members; others per the DME list); a **CMN /
physician order must accompany the claim** and an approved auth does not
replace it. Portal: humanamilitary.com.
**VA CCN Region 1 (Optum):** a **referral/authorization is required for
essentially all CCN care**; immediately-needed DME may be provided, but CCN
**won't pay rentals beyond 30 days** without a Request for Service (RFS) back
to the VA. Portal: vacommunitycare.com.
Sources: humanamilitary.com DME tip sheet & East provider handbook; VA
Community Care Network provider manual (Optum).

### PA CHIP umbrella — `pa_chip`

A placeholder — each CHIP contract is held by a participating MCO (Highmark,
IBC, Capital, UPMC, Geisinger, Aetna Better Health, UPMC for Kids). Bill the
contracted MCO and follow **that MCO's** PA pathway above.

### Workers' compensation — `swif_pa_wc`, `pma_companies_wc`, `erie_insurance_pa`, `liberty_mutual_wc`, `travelers_wc`, `the_hartford_wc`, `sedgwick_cms`

WC has **no standardized DME prior-auth portal**. Treatment is authorized by
the **claims adjuster** under the accepted compensable claim; equipment is
billed per the PA L&I medical fee schedule via **Jopari** WC EDI or paper
HCFA-1500. CPAP is rarely a WC item. Verify the adjuster + claim number
before dispensing.

## How this maps into the app

- `prior_auth_submission_method` / `provider_portal_url` /
  `prior_auth_phone_e164` on `payer_profiles` carry the structured version of
  the above (set by migrations `0206` + `0207`).
- A concise `[PA]` line is appended to each payer's `notes` (migration
  `0207`) so a CSR sees the portal + specific form on the payer profile.
- The universal PA request form (`/admin/patients/:id/prior-authorizations/
:paId/request-form`) supplies the clinical data set for whichever intake
  the payer uses.

**Verify-before-relying:** portals, phone numbers, and form names drift.
Treat this as a researched starting point, re-confirm a payer's current
PA pathway before a first submission, and correct the row in the admin
payer-profile drawer (which stamps `requirements_last_verified_*`).
