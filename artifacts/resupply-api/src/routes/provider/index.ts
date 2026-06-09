// Provider e-signature portal router — the authenticated surface a
// physician/NP uses to e-sign outstanding documents. Mounted at the app
// root (the route files carry their own /api/provider/* prefix) AFTER
// the provider /auth mount so the auth endpoints win on /api/provider/auth/*.

import { Router, type IRouter } from "express";

import portalRouter from "./portal.js";
import mfaRouter from "./mfa.js";

const router: IRouter = Router();

router.use(portalRouter);
router.use(mfaRouter);

export default router;
