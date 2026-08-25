# External mask-catalog audit — per-claim verdicts (2026-08-25)

An external LLM audit of the catalog's four core manufacturers (ResMed,
Fisher & Paykel, Philips Respironics, React Health) was supplied for
review. This is the result of checking **every** claim in it against the
manufacturers' own published data, plus the corrections it missed.

**Evidence bar** — unchanged from
[`mask-size-run-registry-2026-08-21.md`](./mask-size-run-registry-2026-08-21.md):
a manufacturer-hosted document or page, or two independent consistent
sources, preferably with per-size SKUs. A claim that did not clear it is
recorded below as an open item, **not** applied. Applied changes ship in
[`0519`](../lib/resupply-db/migrations/0519_mask_catalog_manufacturer_audit_corrections.sql).

The audit was **directionally useful and specifically unreliable**: it
found real defects nobody had noticed, and it also asked for changes that
contradict evidence already in this repo, over-counted one manufacturer's
gap, and would have deleted a size ResMed actually sells.

---

## 1. Applied — cleared the bar

| #   | Change                                                                                        | Evidence                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **AirFit N30i frames** `S/M/L` → `Small`, `Standard`; `Large` retired                         | ResMed eshop, AirFit N30i Frame System SKUs 63802–63809 — eight SKUs pairing **two** frame sizes (Small, Standard) with the four cushions                                                                      |
| 2   | **AirFit P30i frames** `S/M/L` → `Small`, `Standard`; `Large` retired                         | ResMed KB: "AirFit P30i fits most facial profiles with just **two frame size** starter packs, **small and standard**." Frame-system SKUs 63852–63857                                                           |
| 3   | **AirFit F30i frame** `M` → `Standard` (**`Large` kept**)                                     | ResMed eshop sells one "AirFit F30i/X30i Frame": Small 63368, Standard 63369, Large 63370. Same fix applied to the 0493 magnet-free twin                                                                       |
| 4   | **`philips-dreamwear-np`** → **DreamWear Gel Pillows**, material `Gel`                        | Philips name the product "DreamWear Gel Pillows"; 0512 already corrected this row's size run _as_ the gel pillows, and the registry already labels it so — only the row's own name and material never followed |
| 5   | **DreamWisp** `avoids_nasal_bridge` `true` → `false`, "under-nose" wording removed            | Philips' magnet notice names it "**DreamWisp Nasal Mask with Over the Nose Cushion**", and lists "DreamWear under-the-nose nasal mask" separately as an alternative _to_ it                                    |
| 6   | **Evora Full**: frames `S/M/L` → one universal frame; headgear `Standard`/`Extra Large` added | F&P's Evora Full page: "There are two sizes of headgear available" (Standard, Extra Large); the product-code list has a single "Evora Full Frame Spare" with no size                                           |
| 7   | **Solo** → **Solo Nasal**; **Rio II** → **Rio II Nasal Pillows Mask**                         | Both platforms ship multiple masks the bare name no longer distinguishes (below)                                                                                                                               |
| 8   | **+ AirTouch F30i Comfort**, **+ AirTouch F30i Clear**                                        | ResMed's US professional mask portfolio page; eshop cushion SW/M/L 62489–62491, Comfort systems 62442–62446, Clear systems 62404–62408                                                                         |
| 9   | **+ AirTouch N30i**                                                                           | Same portfolio page family; eshop cushion Small-Wide/Medium/Large 62330–62332, complete systems 62310–62315 (Small and Standard frames)                                                                        |
| 10  | **+ F&P Nova Nasal**                                                                          | F&P's own page: "three cushion sizes available: small, medium, large" + "Two headgear sizes available"                                                                                                         |
| 11  | **+ F&P Solo Pillows**                                                                        | F&P's Solo page carries **two** cushions on one AutoFit headgear — Solo Nasal (S/M/L/W) and Solo Pillows (S/M/L), each with its own fit pack and product codes                                                 |
| 12  | **+ React Siesta 2 Full Face, Rio II Full Face, Siesta 2 Nasal, Rio II Nasal**                | React Health's PAP mask page, with per-size replacement-cushion part numbers (SFF23001-3, RFF3001-3, SNM3001-3, RNM3001-3)                                                                                     |

Every new model lands `fit_data_source='estimated'`,
`needs_clinical_review=true`. A verified **size run** is not verified
**geometry** — bands use 0511's derivation, and
`catalog-bands.test.ts` holds the nine new runs to the same
window-containment and no-gap tiling proofs as every existing run.

### Corrections the audit missed

- **AirFit F30i's frame `M`** was wrong for the same reason as the N30i
  and P30i, and the audit did not mention the F30i at all.
- **It would have deleted the F30i/X30i `Large` frame.** It asked for the
  whole 30i platform to become Small/Standard. ResMed sell a Large F30i/X30i
  frame (63370); the X30i rows added in 0494 already had it right.
- **Frame `size_label` was the bare code** on every 0486-seeded 30i row,
  so the corrected run would have read "S / Standard / L".

---

## 2. Not applied — did not clear the bar

| Claim                                                                               | Why not                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retire the **AirFit F20 for Her `XS`** cushion                                      | The registry records this run as confirmed (XS/S/M, "for Her" packs), and 0514 re-derived its bands positionally against the shared F20 platform ladder. No manufacturer source contradicting it was found. Changing it would also re-open the defect 0514 fixed                                                             |
| Reconcile the **Wisp** size run down to three sizes                                 | 0512 verified Petite / S-M / L / XL against per-size SKUs (1094086/87/88 + 1112031). The audit itself says not to delete a size on marketing copy alone — that is the right call, and it applies to its own claim                                                                                                            |
| Move **Forma** and **Pilairo Q** to legacy                                          | Both are still listed in F&P's own current product navigation. "Not in the flagship range" is a merchandising judgment, not a discontinuation                                                                                                                                                                                |
| Move React **iVolve F1A/N2/N3/P2**, **Numa Nasal Pillow**, **Viva Nasal** to legacy | They are absent from React's current PAP mask page — suggestive, but absence from a web page is not a discontinuation notice. Worth asking React directly; see open items                                                                                                                                                    |
| Flip **Numa Full Face** to non-magnetic, drop its `XL`                              | See the safety note below. The size-run half has no current manufacturer source at all, since React no longer list the Numa                                                                                                                                                                                                  |
| Import **ResMed's F20 74/86/98/110 mm** bands                                       | Correct as ResMed measures it (nasal bridge → lower-lip crease) and wrong for this pipeline (nose **tip** → menton). The audit says this itself; it is also already the finding of [`mask-fit-band-audit-2026-08-21.md`](./mask-fit-band-audit-2026-08-21.md)                                                                |
| Add `manufacturer_fit_method`, `measurement_axis`, `sizing_template_url`, …         | A schema change, not a data correction. Reasonable idea, out of scope for a data-audit migration                                                                                                                                                                                                                             |
| Add **AirFit P10 for AirMini** as a configuration                                   | The product is real (ResMed eshop, "AirFit P10 Mask Kit for AirMini", SKU 38824), but the catalog has no "device-specific configuration under a model" concept. Modelling it as a second P10 would double-count the same facial geometry — which the audit correctly warns against. Needs the schema question answered first |
| Add an **X30i oral-cushion** size variant                                           | The `mask_components` row already exists with the right combination HCPCS (A7028, migration 0494). Whether a one-size component also needs a `mask_size_variants` row is a modelling question, not a data defect                                                                                                             |

### The React Health magnet question — deliberately left excluded

React Health's mask page states, twice: _"Features easy release clips -
not magnets - that are common to all React Health masks."_ That resolves
the open question migration **0492** recorded ("React Health publish no
magnet statement either way that could be found") — **for the five masks
React currently sell**. The four new React masks are therefore seeded
`has_magnetic_components = false` on that statement.

`react-health-numa-full-face` is **not** flipped. The statement sits on a
page listing five current masks and the Numa is not among them, so its
scope over a product React no longer list is exactly the ambiguity 0492
declined to resolve by guessing. The two directions are not symmetric:
flipping it **admits** a possibly-magnetic mask to patients with
pacemakers, ICDs, neurostimulators, shunts or aneurysm clips, while
leaving it costs those patients one option out of ninety-two. The quote is
attached to the row's `magnetic_component_notes` so the clinical sign-off
resolves it rather than rediscovering it.

The three new ResMed masks are seeded magnetic for the same fail-safe
reason. For the AirTouch F30i pair that follows its platform (the AirFit
F30i is on the FDA Class I recall list). For the **AirTouch N30i** it is
deliberately conservative and probably wrong — its AirFit N30i
platform-mate is magnet-free per 0492 — and it is flagged in the row's
notes as the first thing the sign-off should settle.

---

## 3. Open items

1. **AirTouch N30i magnet status** — confirm against ResMed's user guide
   and, if magnet-free, clear the flag and the two contraindications.
2. **React Health legacy status** — ask React whether iVolve F1A/N2/N3/P2,
   Numa Full Face, Numa Nasal Pillow and Viva Nasal remain orderable in
   the US, and whether the Numa carries magnets. Six models turn on this.
3. **AirFit P10 for AirMini** — decide whether the catalog grows a
   device-configuration concept, or the AirMini kit stays out.
4. **Philips Wisp `hose_position`** — the audit says adult Wisp is a
   front-tube mask and the catalog says `top`. That is very likely right
   (top-of-head is DreamWisp's whole differentiator), but no Philips page
   stating it could be retrieved, so it is **unchanged** pending a source.
5. **Philips non-magnetic replacement clips** — Philips state that "Amara
   View … and Wisp/Wisp Youth have non-magnetic headgear clip replacement
   parts that can be used in place of the magnetic headgear clips." This
   is a genuinely different mechanism from ResMed's (0493 notes ResMed's
   non-magnetic clips do **not** convert a magnetic mask), and the catalog
   has no way to express it. Three models are affected.
6. **F30i `interface_type`** — seeded `hybrid`, while 0515's own header
   argues it is a full-face mask. The new AirTouch F30i rows mirror the
   sibling for platform consistency; worth settling for the family.

## Sources

ResMed — [professional mask portfolio](https://www.resmed.com/en-us/health-professionals/products/cpap/masks/),
[AirTouch F30i Comfort](https://www.resmed.com/en-us/health-professionals/products/cpap/masks/airtouch-f30i-comfort/),
[AirTouch N30i](https://www.resmed.com/en-us/health-professionals/products/cpap/masks/airtouch-n30i/),
[KB: which starter pack](https://ap.resmed.com/knowledge/how-do-i-know-which-starter-pack-to-use),
and the per-size SKUs on [eshop.resmed.com](https://eshop.resmed.com/).
Fisher & Paykel — [mask range](https://www.fphcare.com/us/homecare/sleep-apnea/masks/),
[Nova Nasal](https://www.fphcare.com/us/homecare/sleep-apnea/masks/nova-nasal/),
[Solo](https://www.fphcare.com/us/homecare/sleep-apnea/masks/solo/),
[Evora Full](https://www.fphcare.com/us/homecare/sleep-apnea/masks/evora-full/),
[masks contain no magnets](https://www.fphcare.com/us/homecare/sleep-apnea/fp-healthcare-masks-no-magnets/).
Philips Respironics — [magnet notification](https://www.usa.philips.com/sleep-respiratory-care/news/business-updates/magnet-notification),
[DreamWear](https://www.usa.philips.com/sleep-respiratory-care/campaign/discover-dreamwear).
React Health — [PAP masks](https://www.reacthealth.com/sleep/sleep-masks).
