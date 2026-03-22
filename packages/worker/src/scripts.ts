import { CLAIM_GLOBAL_SCRIPT } from "./lua/claim_global.ts";
import { COMPLETE_SCRIPT } from "./lua/complete.ts";
import { FAIL_SCRIPT } from "./lua/fail.ts";

export const WORKER_SCRIPTS = {
  claimGlobal: CLAIM_GLOBAL_SCRIPT,
  complete: COMPLETE_SCRIPT,
  fail: FAIL_SCRIPT,
} as const;
