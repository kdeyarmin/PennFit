import { Router, type IRouter } from "express";
import { requireAdmin } from "../middlewares/requireAdmin";

// /resupply-api/me — admin identity smoke endpoint.
//
// Why this exists:
//   The dashboard needs a single, cheap call after sign-in to ask
//   "am I authorized as an admin on THIS server, what email
//   does the API see for me, and at what privilege level?". That
//   answer drives:
//     - Whether to show the admin UI at all (200 = show, 403 =
//       render the friendly "not authorized" screen).
//     - What email to display in the dashboard chrome ("Signed in as
//       info@pennpaps.com").
//     - Whether to render destructive UI affordances. `role: "agent"`
//       hides/disables Delete buttons so customer-service agents
//       never see a control they cannot use.
//
//   We deliberately do NOT echo the Clerk session token, the full
//   Clerk user object, or the admin allowlist — only the three
//   identifiers the UI legitimately needs to render. Even an attacker
//   who steals a session cookie should learn nothing from /me beyond
//   what they already know (their own email + Clerk id + role).
//
// Auth:
//   `requireAdmin` runs first. By the time the handler executes,
//   it has already proven:
//     1. There is a valid Clerk session (else 401),
//     2. The session's primary email is verified (else 403),
//     3. The email is on the admin OR agent allowlist (else 403),
//   AND attached `adminEmail`, `adminClerkId`, and `adminRole` to
//   `req`. The handler itself never reaches Clerk and never
//   re-validates.

const router: IRouter = Router();

router.get("/me", requireAdmin, (req, res) => {
  // All three fields are guaranteed to be set by requireAdmin on the
  // success path; the `??` is a belt-and-braces guard so a future
  // refactor that breaks that contract surfaces as an empty string
  // / "admin" default (which the dashboard will treat as a hard
  // error in the email case, and a safe default in the role case)
  // rather than as `undefined` serialized to `null`.
  res.json({
    clerkId: req.adminClerkId ?? "",
    email: req.adminEmail ?? "",
    role: req.adminRole ?? "admin",
  });
});

export default router;
