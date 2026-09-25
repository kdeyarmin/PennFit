import type { Request, Response, NextFunction } from "express";
import {
  readTenantTwilioAccounts,
  requireTwilioSignature,
  verifyTenantTwilioCallback,
  type RequireTwilioSignatureOptions,
} from "@workspace/resupply-telecom";
import { resolveOrgIdByCalledNumber } from "./tenant-telecom";

/** Authenticate with exactly one account's token, then authorize its tenant. */
export function requireTenantTwilioSignature(
  options: RequireTwilioSignatureOptions,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const deny = () => {
      res.status(403).type("text/plain").send("Forbidden");
    };
    try {
      const accounts = readTenantTwilioAccounts();
      if (!accounts.length)
        return requireTwilioSignature(options)(req, res, next);
      const accountSid = req.body?.AccountSid;
      const tenant = accounts.find(
        (account) => account.accountSid === accountSid,
      );
      if (!tenant) {
        if (accountSid !== process.env.TWILIO_ACCOUNT_SID) return deny();
        // The parent must not accidentally accept a tenant's inbound number.
        const inbound = /\/(sms\/inbound|voice\/inbound-reorder)$/.test(
          req.path,
        );
        if (
          inbound &&
          accounts.some((account) => account.numbers.includes(req.body?.To))
        )
          return deny();
        return requireTwilioSignature(options)(req, res, next);
      }
      if (tenant.state !== "active") return deny();
      let valid = false;
      requireTwilioSignature({
        ...options,
        getAuthToken: () => tenant.authToken,
        onReject: () => {},
      })(req, res, () => {
        valid = true;
      });
      if (!valid) return deny();
      const inbound = /\/(sms\/inbound|voice\/inbound-reorder)$/.test(req.path);
      if (inbound) {
        if (
          typeof req.body?.To !== "string" ||
          !tenant.numbers.includes(req.body.To)
        )
          return deny();
        const channel = req.path.endsWith("/sms/inbound") ? "sms" : "voice";
        if (
          (await resolveOrgIdByCalledNumber(req.body.To, channel)) !==
          tenant.orgId
        )
          return deny();
      } else {
        const built = options.buildPublicUrl(req);
        const urls = Array.isArray(built) ? built : [built];
        if (!urls.some((url) => verifyTenantTwilioCallback(url, tenant)))
          return deny();
      }
      req.orgId = tenant.orgId;
      res.locals.tenantTwilioAccount = tenant;
      next();
    } catch {
      deny();
    }
  };
}
