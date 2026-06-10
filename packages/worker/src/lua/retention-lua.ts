/**
 * Shared Lua fragment that finalizes a job under the queue's retention
 * policy. Used verbatim by complete, fail, and recover so eviction logic
 * cannot drift between scripts.
 *
 * Assumes locals `now`, `jobKey`, and `tag` exist in the surrounding script.
 * `zsetKey`, `jobIdArg`, `modeArg`, `ttlArg`, and `countArg` are Lua
 * expressions (e.g. `KEYS[2]`, `ARGV[1]`, or a local) evaluated in place.
 */
export function retentionLua(options: {
  status: "completed" | "failed";
  zsetKey: string;
  jobIdArg: string;
  modeArg: string;
  ttlArg: string;
  countArg: string;
}): string {
  const { status, zsetKey, jobIdArg, modeArg, ttlArg, countArg } = options;
  return `
if ${modeArg} == 'delete' then
  redis.call('DEL', jobKey)
else
  redis.call('HSET', jobKey, 'status', '${status}', 'finishedAt', now)
  redis.call('ZADD', ${zsetKey}, now, ${jobIdArg})
  if ${modeArg} == 'trim' then
    local ttl = tonumber(${ttlArg})
    local count = tonumber(${countArg})
    if ttl >= 0 then
      local cutoff = now - ttl
      for _, id in ipairs(redis.call('ZRANGEBYSCORE', ${zsetKey}, 0, cutoff)) do
        redis.call('DEL', tag .. ':job:' .. id)
      end
      redis.call('ZREMRANGEBYSCORE', ${zsetKey}, 0, cutoff)
    end
    if count >= 0 then
      local overflow = redis.call('ZCARD', ${zsetKey}) - count
      if overflow > 0 then
        for _, id in ipairs(redis.call('ZRANGE', ${zsetKey}, 0, overflow - 1)) do
          redis.call('DEL', tag .. ':job:' .. id)
        end
        redis.call('ZREMRANGEBYRANK', ${zsetKey}, 0, overflow - 1)
      end
    end
  end
end
`;
}
