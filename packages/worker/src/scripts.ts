import type { RedisScripts } from "redis";

import { CLAIM_GLOBAL_SCRIPT, type ClaimGlobalScript } from "./lua/claim-global.js";
import { COMPLETE_SCRIPT, type CompleteScript } from "./lua/complete.js";
import { EXTEND_LOCK_SCRIPT, type ExtendLockScript } from "./lua/extend-lock.js";
import { FAIL_SCRIPT, type FailScript } from "./lua/fail.js";
import { RECOVER_SCRIPT, type RecoverScript } from "./lua/recover.js";
import { REQUEUE_ACTIVE_SCRIPT, type RequeueActiveScript } from "./lua/requeue-active.js";

export interface WorkerScripts extends RedisScripts {
  claimGlobal: ClaimGlobalScript;
  complete: CompleteScript;
  fail: FailScript;
  recover: RecoverScript;
  extendLock: ExtendLockScript;
  requeueActive: RequeueActiveScript;
}

export const WORKER_SCRIPTS: WorkerScripts = {
  claimGlobal: CLAIM_GLOBAL_SCRIPT,
  complete: COMPLETE_SCRIPT,
  extendLock: EXTEND_LOCK_SCRIPT,
  fail: FAIL_SCRIPT,
  recover: RECOVER_SCRIPT,
  requeueActive: REQUEUE_ACTIVE_SCRIPT,
};
