// Conversation routes — /conversations (list), /conversations/:id (detail),
// and /conversations/:id/reply (admin appends to an open thread).

import { Router, type IRouter } from "express";

import assignmentRouter from "./assignment";
import attachmentRouter from "./attachment";
import detailRouter from "./detail";
import listRouter from "./list";
import replyRouter from "./reply";

const router: IRouter = Router();
router.use(listRouter);
router.use(detailRouter);
router.use(replyRouter);
// Assignment + priority + SLA + escalation endpoints. Mounted last
// so the more-specific :id/<verb> routes don't shadow detail.
router.use(assignmentRouter);
// Attachment download — its path is more specific than :id (it
// reads :id/messages/:mid/attachments/:aid) so order doesn't matter
// for shadowing, but we keep it grouped with the other conversation
// sub-resources.
router.use(attachmentRouter);

export default router;
