import { Router } from "express";
import { billingAccessLogMiddleware } from "../middleware/billingAccessLog.js";
import creditsRouter from "./billing/credits.js";
import deductRouter from "./billing/deduct.js";
import disputesRouter from "./billing/disputes.js";
import { createFeeAbstractionRouter } from "./billing/feeAbstraction.js";

const router = Router();

router.use(billingAccessLogMiddleware);

router.use("/credits", creditsRouter);
router.use("/disputes", disputesRouter);
router.use("/deduct", deductRouter);
router.use("/fee-abstraction", createFeeAbstractionRouter());

export default router;
