// Provider portal router — the authenticated surface a physician/NP uses
// to e-sign outstanding documents (portal) and to monitor how their own
// patients are doing on therapy (rtm). Mounted at the app root (the route
// files carry their own /api/provider/* prefix) AFTER the provider /auth
// mount so the auth endpoints win on /api/provider/auth/*.

import { Router, type IRouter } from "express";

import portalRouter from "./portal.js";
import mfaRouter from "./mfa.js";
import rtmRouter from "./rtm.js";
import referralsRouter from "./referrals.js";
import referralWorkflowRouter from "./referral-workflow.js";
import orgsRouter from "./orgs.js";

const router: IRouter = Router();

router.use(portalRouter);
router.use(orgsRouter);
router.use(mfaRouter);
router.use(rtmRouter);
// Referral routes before the workflow router only for readability; the
// two mount disjoint paths, so the order carries no meaning.
router.use(referralsRouter);
router.use(referralWorkflowRouter);

export default router;
