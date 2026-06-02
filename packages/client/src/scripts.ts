import type { RedisScripts } from "redis";

import { ENQUEUE_SCRIPT, type EnqueueScript } from "./lua/enqueue.js";

export interface ClientScripts extends RedisScripts {
  enqueue: EnqueueScript;
}

export const CLIENT_SCRIPTS: ClientScripts = {
  enqueue: ENQUEUE_SCRIPT,
};
