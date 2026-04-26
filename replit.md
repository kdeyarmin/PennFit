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
*   **Page Background:** Layered "ambient wash" effect with radial gradients, a soft navy dot grid, and subtle SVG `feTurbulence` grain for a tactile feel.
*   **Scroll Restoration:** `window.scrollTo(0, 0)` on route changes for enhanced user experience.

### Tutorial Video
A short, animated tutorial (`/penn-fit-tutorial/`) guides users. It's built with framer-motion + lucide-react, brand-themed, and features dual-mode rendering: embedded (inside the main app) or standalone (full landing experience with navigation and a written walkthrough). Real app screenshots are embedded for visual accuracy.

## External Dependencies

*   **SendGrid:** For sending order fulfillment emails from `POST /api/orders`.
*   **MediaPipe Face Mesh:** Google's machine learning solution for on-device facial landmark detection.
*   **AWS:** Deployment target for HIPAA-compliant infrastructure with a Business Associate Agreement (BAA).