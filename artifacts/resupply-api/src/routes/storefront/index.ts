import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import recommendRouter from "./recommend.js";
import ordersRouter from "./orders.js";
import trackOrderRouter from "./track-order.js";
import adminRouter from "./admin.js";
import usageEventsRouter from "./usage-events.js";
import remindersRouter from "./reminders.js";
import chatRouter from "./chat.js";
import sleepCoachRouter from "./sleep-coach.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(recommendRouter);
router.use(ordersRouter);
router.use(trackOrderRouter);
router.use(adminRouter);
router.use(usageEventsRouter);
router.use(remindersRouter);
router.use(chatRouter);
router.use(sleepCoachRouter);

export default router;
