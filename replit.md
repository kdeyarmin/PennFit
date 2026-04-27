# Penn Fit — CPAP Mask Fitter

## Overview

Penn Fit is a web application designed for Penn Home Medical Supply, LLC, to guide patients in selecting the best-fit CPAP mask. The application provides a privacy-first facial measurement process and a clinical questionnaire to recommend suitable CPAP masks from Penn's catalog.

**Key Capabilities:**

*   **Privacy-First Facial Measurement:** Utilizes on-device processing of facial images to extract numeric measurements without transmitting or storing sensitive image data.
*   **Clinical Questionnaire:** Gathers patient-specific information to refine mask recommendations.
*   **Personalized Mask Recommendations:** Provides a ranked list of top masks with detailed justifications, considering both facial fit and clinical needs.
*   **Order Placement:** Facilitates order submission to Penn Home Medical Supply through a secure and stateless API.
*   **Brand Alignment:** Adheres to Penn's branding with a distinct visual design system.
*   **Tutorial:** Includes an animated tutorial to guide users through the fitting process.

## User Preferences

I prefer iterative development, with a focus on delivering functional components that can be tested and refined.
I want detailed explanations for any complex architectural decisions or significant code changes.
Please ask before making major changes to the project structure or core functionalities.
Do not add image logging anywhere in the backend.
Do not log or persist order request bodies.
Do not add a database unless specifically for non-PHI business data (mask catalog, etc.).

## System Architecture

The Penn Fit application adopts a privacy-first, stateless architecture with a focus on on-device processing for sensitive patient data.

### Privacy-First Design
All facial image processing occurs exclusively on the user's device using MediaPipe Face Mesh. Only numeric measurements are transmitted to the backend. The backend is stateless for the recommendation flow, meaning no personal health information (PHI) is stored or logged. The only PHI-touching endpoint (`POST /api/orders`) validates, forwards the order via SendGrid, and immediately discards the payload, ensuring no persistence of sensitive data.

### Technical Stack
*   **Monorepo Tool:** pnpm workspaces
*   **Node.js Version:** 24
*   **Package Manager:** pnpm
*   **TypeScript Version:** 5.9
*   **API Framework:** Express 5
*   **Validation:** Zod (generated from OpenAPI spec)
*   **API Codegen:** Orval (from OpenAPI spec)
*   **On-device AI:** MediaPipe Face Mesh (`@mediapipe/tasks-vision`) for 478 facial landmarks
*   **Frontend:** React, Vite, Tailwind CSS, Wouter routing

### Application Flow
The user journey includes distinct stages:
1.  **Home:** Landing page.
2.  **Consent:** BIPA-aware privacy disclosures.
3.  **Capture:** Live camera feed with face oval guide and 3-second steady-shot countdown. Calibration is iris-based (11.7 mm average iris diameter).
4.  **Measure:** On-device MediaPipe processing extracts numeric measurements, and the captured image is immediately discarded.
5.  **Questionnaire:** 11 clinical questions for personalized recommendations.
6.  **Results:** Displays top 3 mask recommendations with confidence scores.
7.  **Order:** Patient/contact/shipping/insurance/prescription intake form.
8.  **Order Success:** Confirmation page with an order reference.
9.  **Masks:** Filterable mask catalog browser.
10. **Privacy:** Privacy policy stub.

### Recommendation Scoring
The recommendation engine uses a combined score:
*   **Combined score** = (typeScore × 0.60 + fitScore × 0.40) × contraMultiplier × pressureMultiplier
*   **typeScore:** Driven by questionnaire answers.
*   **fitScore:** Based on physical match between facial measurements and mask size ranges.
*   **contraMultiplier:** Reduces score for contraindications (e.g., heavy beard for full-face).
*   **pressureMultiplier:** Reduces score for high-pressure patients with unsuitable masks.
*   **Top-3 diversification:** Ensures a variety of mask types in the top recommendations.

### Visual Design System
The application features a high-end, professional visual language using Penn's navy and gold brand palette.
*   **No Dark Mode:** Intentional design decision for a light-mode-only interface.
*   **Brand Tokens:** Custom CSS properties for Penn navy, gold, and other brand colors.
*   **Reusable Utility Classes:** Tailwind CSS classes for consistent styling of cards, icons, buttons, and form elements.
*   **Eyebrow Pattern:** Consistent page header design with small caps text and gradient gold accents.
*   **Page Background:** Layered "ambient atmosphere" — eight stacked radial blooms (cool plinth, gold sun + sunrise top-right, navy bloom top-left, mid-right depth, navy bottom plinth, gold whisper bottom-left) plus a diagonal sheen highlight, a viewport-fixed navy dot grid masked into a soft center bloom, and a low-opacity SVG `feTurbulence` grain. Background is `fixed` so it anchors as you scroll. The penn-fit-tutorial standalone page mirrors the same recipe (with rgba literals instead of HSL vars) so the two artifacts feel like one product.
*   **Scroll Restoration:** `window.scrollTo(0, 0)` on route changes for enhanced user experience.

### Tutorial Video
A short, animated tutorial (`/penn-fit-tutorial/`) guides users. The standalone landing page mirrors the cpap-fitter's "ambient atmosphere" page background (see the design-system note above) so the two artifacts feel like one product. It's built with framer-motion + lucide-react, brand-themed, and features dual-mode rendering: embedded (inside the main app) or standalone (full landing experience with navigation and a written walkthrough). Real app screenshots are embedded for visual accuracy. Total runtime is ~58 seconds — each scene is timed so all body copy is revealed by ~70% of its duration, leaving 4-6 seconds of "everything visible" hold time at the end for re-reading before the next scene transitions in. The video container uses a portrait aspect ratio (`aspect-[3/5]`) on mobile and 16:9 (`sm:aspect-video`) from tablet up — required because Scenes 2 and 4 stack their phone-mockup + text vertically on mobile, which doesn't fit a 16:9 letterbox. Scene 2 reuses the home-page screenshot for Step 1 (the camera-capture page can't be screenshotted in headless because no camera is available). Mobile-only content density is reduced in Scenes 2 and 4 (smaller phone, hidden long-form paragraphs/taglines, condensed chip rows) so all scene content fits inside the container without clipping.

## External Dependencies

*   **SendGrid:** For sending order fulfillment emails from `POST /api/orders`.
*   **MediaPipe Face Mesh:** Google's machine learning solution for on-device facial landmark detection. WASM runtime and the `face_landmarker.task` model are **self-hosted** under `artifacts/cpap-fitter/public/mediapipe/` (populated by `scripts/setup-mediapipe.mjs` via predev/prebuild hooks; the directory is gitignored). No external CDN is contacted at runtime, which lets the app's CSP stay strict.
*   **AWS:** Deployment target for HIPAA-compliant infrastructure with a Business Associate Agreement (BAA).

## Recent Hardening (April 2026 deep-review pass)

A full severity-ranked review was implemented end-to-end. Key items future contributors should be aware of:

### Backend (`artifacts/api-server`)
*   `app.ts` enables `trust proxy` (required for accurate client IPs behind the Replit / AWS proxy), reads its CORS allowlist from `PENN_ALLOWED_ORIGINS` (comma-separated), and caps JSON bodies at 100 kb.
*   `routes/orders.ts` applies `express-rate-limit` keyed via `ipKeyGenerator` (do **not** swap to raw `req.ip` — it breaks IPv6 normalization), and short-circuits with a fake-success response if the honeypot field `website` is non-empty. Honeypot hits are intentionally indistinguishable from real success on the wire.

### Frontend routing (`artifacts/cpap-fitter/src/App.tsx`)
*   Protected routes are implemented as **inline `Guarded*` function components rendered via standard `<Route component={GuardedX}>`**. Wouter's `<Switch>` only inspects the `path` prop on its direct `<Route>` children, so a generic `<ProtectedRoute>` wrapper component falls through to `NotFound`. Keep guards inline.
*   Each guard reads from the in-memory fitter store and returns `<Redirect>` when the precondition fails — preventing flash-of-protected-content. Per-page `useEffect`+`setLocation`+`return null` guards have been removed.

### Form accessibility (`artifacts/cpap-fitter/src/pages/order.tsx`)
*   The `Field` helper generates an id with `useId()` and clones its child input to bind `htmlFor`. For shadcn `Select` triggers (which already render their own label association), pass `skipHtmlFor` to avoid double-binding.
*   The honeypot `website` input is registered in the zod schema, rendered offscreen with `aria-hidden`, `tabindex={-1}`, and `autocomplete="off"`; the submit handler short-circuits to a fake success when filled.

### Type safety
*   `lib/api-client-react/src/index.ts` now re-exports `ApiError` and `ErrorType` so consumers can type errors as `ApiError<{error?: string; details?: string[]}>` instead of `as any`.
*   `order.tsx`'s `consentToContact` uses `z.boolean().refine()` so the form no longer needs the `false as unknown as true` cast.