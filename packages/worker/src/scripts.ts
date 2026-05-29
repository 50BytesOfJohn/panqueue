import { CLAIM_GLOBAL_SCRIPT } from "./lua/claim_global.js";
import { COMPLETE_SCRIPT } from "./lua/complete.js";
import { EXTEND_LOCK_SCRIPT } from "./lua/extend_lock.js";
import { FAIL_SCRIPT } from "./lua/fail.js";
import { RECOVER_SCRIPT } from "./lua/recover.js";
import { REQUEUE_ACTIVE_SCRIPT } from "./lua/requeue_active.js";

export const WORKER_SCRIPTS = {
  claimGlobal: CLAIM_GLOBAL_SCRIPT,
  complete: COMPLETE_SCRIPT,
  fail: FAIL_SCRIPT,
  recover: RECOVER_SCRIPT,
  extendLock: EXTEND_LOCK_SCRIPT,
  requeueActive: REQUEUE_ACTIVE_SCRIPT,
} as const;
