# CPAP Mask Fitter — AeroFit

## Overview

CPAP mask recommendation web app for DME companies. Guides patients through a privacy-first facial measurement flow and clinical questionnaire to find the best-fit CPAP mask.

## Architecture

### Privacy-First Design (Critical Constraint)
- **All facial image processing happens ON-DEVICE in the browser** using MediaPipe Face Mesh
- **Images NEVER leave the user's device** — only numeric measurements (mm) are transmitted
- **Backend is fully stateless** — no database, no PHI storage, no request body logging
- Deployment target: HIPAA-compliant infra (AWS with BAA)

### Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Validation**: Zod (`zod/v4`), generated from OpenAPI spec
- **API codegen**: Orval (from OpenAPI spec)
- **On-device AI**: MediaPipe Face Mesh (`@mediapipe/tasks-vision`) — 478 facial landmarks
- **Frontend**: React + Vite + Tailwind CSS + Wouter routing

### App Flow

1. **Home** (`/`) — Landing page, Start CTA
2. **Consent** (`/consent`) — BIPA-aware privacy disclosures with `[ATTORNEY REVIEW]` placeholders
3. **Capture** (`/capture`) — Live camera with SVG face oval guide + credit card calibration reference
4. **Measure** (`/measure`) — On-device MediaPipe Face Mesh processing → numeric measurements
5. **Questionnaire** (`/questionnaire`) — Clinical questions (mouth breathing, claustrophobia, sleep position, etc.)
6. **Results** (`/results`) — Top 3 mask recommendations with confidence scores and reasoning
7. **Masks** (`/masks`) — Mask catalog browser (filterable by type)
8. **Privacy** (`/privacy`) — Privacy policy stub for attorney completion

### Network Boundary

```
Device (browser)                    Server
─────────────────                  ─────────────────────
Camera frame        (never leaves) 
Face landmarks      (never leaves)
Pixel→mm calibration (never leaves)
                                    
Measurements (mm)  ─── POST /api/recommend ──→  Recommendation engine
Questionnaire answers                           (pure function, stateless)
                   ←── Top 3 masks + reasoning ─
```

### Packages

| Package | Purpose |
|---------|---------|
| `@workspace/cpap-fitter` | React frontend — camera, MediaPipe, questionnaire, results UI |
| `@workspace/api-server` | Express backend — stateless recommendation API |
| `@workspace/api-spec` | OpenAPI spec (source of truth) |
| `@workspace/api-client-react` | Generated React Query hooks |
| `@workspace/api-zod` | Generated Zod validation schemas |

### Mask Catalog

20 representative masks across 4 types:
- **Full Face** (5): ResMed AirFit F20, F30, F40; Philips DreamWear FF; Fisher & Paykel Vitera; Philips Amara View
- **Nasal** (5): ResMed AirFit N20, N30, AirTouch N20; Philips DreamWear Nasal; Fisher & Paykel Eson 2; ResMed Mirage FX
- **Nasal Pillow** (4): ResMed AirFit P10, P10 For Her; Fisher & Paykel Brevida; Philips DreamWear NP; Bleep DreamPort
- **Hybrid** (2): ResMed AirFit F30i; Philips DreamWear FF Gel

Replace with actual DME inventory before production use.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Important Notes

- **Do not add image logging** anywhere in the backend — this breaks the PHI architecture guarantee
- **Do not add a database** unless specifically for non-PHI business data (mask catalog, etc.)
- Consent screen has `[ATTORNEY REVIEW]` placeholders — requires attorney sign-off before launch
- FDA SaMD analysis may be required before patient use — consult regulatory counsel
- Calibration math documented in `src/pages/measure.tsx` — iris fallback (11.7mm avg diameter) and credit card ISO/IEC 7810 ID-1 dimensions (85.60 × 53.98 mm)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
