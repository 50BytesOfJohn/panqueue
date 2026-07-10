import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the declare-concurrency-limit script. */
export interface DeclareConcurrencyLimitArgs {
  /** Maximum concurrently active jobs across all worker processes. */
  limit: number;
  /** Monotonic declaration version. */
  version: number;
}

type DeclareConcurrencyLimitScriptArguments = [keys: QueueKeys, args: DeclareConcurrencyLimitArgs];

export type DeclareConcurrencyLimitScript =
  PanqueueRedisScript<DeclareConcurrencyLimitScriptArguments>;

/**
 * Lua script implementing the versioned declare-and-verify fencing rule for
 * the per-queue global concurrency limit (any language binding can implement
 * the same contract against the same key):
 * 1. Key absent -> write {limit, version}, return 'written'.
 * 2. Incoming version higher than stored -> overwrite, return 'written'.
 * 3. Incoming version lower than stored -> no-op, return 'ignored'.
 * 4. Same version, same limit -> no-op, return 'unchanged' (idempotent restart).
 * 5. Same version, different limit -> no write, return 'conflict' (operator
 *    error; the caller must fail the boot loudly).
 *
 * Returns a 2-element array {status, storedLimit} where storedLimit is the
 * limit stored in Redis after this call.
 */
export const DECLARE_CONCURRENCY_LIMIT_SCRIPT: DeclareConcurrencyLimitScript = defineScript({
  NUMBER_OF_KEYS: 1,
  SCRIPT: `
local limit = tonumber(ARGV[1])
local version = tonumber(ARGV[2])
local stored = redis.call('HMGET', KEYS[1], 'limit', 'version')

if not stored[2] then
  redis.call('HSET', KEYS[1], 'limit', limit, 'version', version)
  return {'written', limit}
end

local storedLimit = tonumber(stored[1])
local storedVersion = tonumber(stored[2])

if version > storedVersion then
  redis.call('HSET', KEYS[1], 'limit', limit, 'version', version)
  return {'written', limit}
end
if version < storedVersion then
  return {'ignored', storedLimit}
end
if limit == storedLimit then
  return {'unchanged', storedLimit}
end
return {'conflict', storedLimit}
`,
  /**
   * KEYS[1] = concurrency; ARGV[1..2] = limit, version.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link DeclareConcurrencyLimitArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: DeclareConcurrencyLimitArgs): void {
    parser.pushKeys([keys.concurrency]);
    parser.push(args.limit.toString(), args.version.toString());
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
