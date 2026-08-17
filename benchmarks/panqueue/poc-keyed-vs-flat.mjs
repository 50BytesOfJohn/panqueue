// PoC: cost of the unified keyed layout vs the current flat global layout.
//
// Variant A  — flat:    waiting LIST + active ZSET (current panqueue global mode)
// Variant B  — keyed-1: ready ZSET + per-key wait LIST + active-count HASH,
//                       single default key "" (what a "global" queue would be
//                       on a unified keyed layout)
// Variant C  — keyed-100: same layout, 100 keys, per-key limit 10 (a real
//                       keyed workload, for context)
//
// Each variant runs the same lifecycle: enqueue N jobs, then drain with
// WORKERS parallel loops doing claim(batch=16) + complete per job.
// Metrics: wall-clock jobs/sec per phase, plus server-side CPU per job
// (INFO commandstats, CONFIG RESETSTAT between phases).

import { createClient } from "redis";

const N = Number(process.env.N ?? 50_000);
const BATCH = 16;
const WORKERS = 32;
const TAG = "{q:bench}";
const PAYLOAD = JSON.stringify({ hello: "world", n: 42 });

const client = createClient({ url: "redis://localhost:6390" });
await client.connect();

// ---------------------------------------------------------------- flat (A)

const FLAT_ENQUEUE = `
local jobKey = ARGV[1] .. ':job:' .. ARGV[2]
redis.call('HSET', jobKey, 'id', ARGV[2], 'payload', ARGV[3], 'status', 'waiting', 'runs', 0)
redis.call('LPUSH', KEYS[1], ARGV[2])
redis.call('PUBLISH', KEYS[2], '')
return 1
`;

// KEYS: waiting, active, concurrency(meta). ARGV: leaseMs, tag, count
const FLAT_CLAIM = `
local count = tonumber(ARGV[3])
local limit = tonumber(redis.call('HGET', KEYS[3], 'limit'))
if limit then
  local free = limit - redis.call('ZCARD', KEYS[2])
  if free < 1 then return {} end
  if free < count then count = free end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local deadline = now + tonumber(ARGV[1])
local claimed = {}
for i = 1, count do
  local jobId = redis.call('RPOP', KEYS[1])
  if not jobId then break end
  local jobKey = ARGV[2] .. ':job:' .. jobId
  local runs = redis.call('HINCRBY', jobKey, 'runs', 1)
  local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(runs))
  redis.call('HSET', jobKey, 'status', 'active', 'lastStartedAt', now, 'lockToken', token, 'leaseDeadline', deadline)
  redis.call('ZADD', KEYS[2], deadline, jobId)
  table.insert(claimed, jobId)
end
return claimed
`;

// KEYS: waiting, active, concurrency, notify. ARGV: tag, jobId
const FLAT_COMPLETE = `
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('DEL', ARGV[1] .. ':job:' .. ARGV[2])
local limit = tonumber(redis.call('HGET', KEYS[3], 'limit'))
if limit and redis.call('LLEN', KEYS[1]) > 0 then
  redis.call('PUBLISH', KEYS[4], '')
end
return 1
`;

// --------------------------------------------------------------- keyed (B/C)

// KEYS: ready, counts, meta, notify. ARGV: tag, jobId, payload, key
const KEYED_ENQUEUE = `
local jobKey = ARGV[1] .. ':job:' .. ARGV[2]
redis.call('HSET', jobKey, 'id', ARGV[2], 'payload', ARGV[3], 'status', 'waiting', 'runs', 0, 'ckey', ARGV[4])
redis.call('LPUSH', ARGV[1] .. ':k:wait:' .. ARGV[4], ARGV[2])
local cnt = tonumber(redis.call('HGET', KEYS[2], ARGV[4])) or 0
local limit = tonumber(redis.call('HGET', KEYS[3], 'keyLimit'))
if (not limit) or cnt < limit then
  local seq = redis.call('HINCRBY', KEYS[3], 'seq', 1)
  redis.call('ZADD', KEYS[1], 'NX', seq, ARGV[4])
  redis.call('PUBLISH', KEYS[4], '')
end
return 1
`;

// KEYS: ready, counts, meta, active. ARGV: leaseMs, tag, count
const KEYED_CLAIM = `
local count = tonumber(ARGV[3])
local glimit = tonumber(redis.call('HGET', KEYS[3], 'limit'))
if glimit then
  local free = glimit - redis.call('ZCARD', KEYS[4])
  if free < 1 then return {} end
  if free < count then count = free end
end
local keys = redis.call('ZRANGE', KEYS[1], 0, 0)
local ckey = keys[1]
if not ckey then return {} end
local cnt = tonumber(redis.call('HGET', KEYS[2], ckey)) or 0
local klimit = tonumber(redis.call('HGET', KEYS[3], 'keyLimit'))
if klimit then
  local kfree = klimit - cnt
  if kfree < 1 then
    redis.call('ZREM', KEYS[1], ckey)
    return {}
  end
  if kfree < count then count = kfree end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local deadline = now + tonumber(ARGV[1])
local waitList = ARGV[2] .. ':k:wait:' .. ckey
local claimed = {}
local n = 0
for i = 1, count do
  local jobId = redis.call('RPOP', waitList)
  if not jobId then break end
  n = n + 1
  local jobKey = ARGV[2] .. ':job:' .. jobId
  local runs = redis.call('HINCRBY', jobKey, 'runs', 1)
  local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(runs))
  redis.call('HSET', jobKey, 'status', 'active', 'lastStartedAt', now, 'lockToken', token, 'leaseDeadline', deadline)
  redis.call('ZADD', KEYS[4], deadline, jobId)
  table.insert(claimed, jobId)
end
if n > 0 then
  cnt = redis.call('HINCRBY', KEYS[2], ckey, n)
end
if redis.call('LLEN', waitList) > 0 and ((not klimit) or cnt < klimit) then
  local seq = redis.call('HINCRBY', KEYS[3], 'seq', 1)
  redis.call('ZADD', KEYS[1], seq, ckey)
else
  redis.call('ZREM', KEYS[1], ckey)
end
return claimed
`;

// KEYS: ready, counts, meta, active, notify. ARGV: tag, jobId, key
const KEYED_COMPLETE = `
redis.call('ZREM', KEYS[4], ARGV[2])
redis.call('DEL', ARGV[1] .. ':job:' .. ARGV[2])
local cnt = redis.call('HINCRBY', KEYS[2], ARGV[3], -1)
if cnt <= 0 then redis.call('HDEL', KEYS[2], ARGV[3]) end
local waitList = ARGV[1] .. ':k:wait:' .. ARGV[3]
if redis.call('LLEN', waitList) > 0 then
  local klimit = tonumber(redis.call('HGET', KEYS[3], 'keyLimit'))
  if (not klimit) or cnt < klimit then
    local seq = redis.call('HINCRBY', KEYS[3], 'seq', 1)
    redis.call('ZADD', KEYS[1], 'NX', seq, ARGV[3])
    redis.call('PUBLISH', KEYS[5], '')
  end
end
return 1
`;

// ------------------------------------------------------------------ harness

const sha = {};
for (const [name, src] of Object.entries({
  FLAT_ENQUEUE, FLAT_CLAIM, FLAT_COMPLETE,
  KEYED_ENQUEUE, KEYED_CLAIM, KEYED_COMPLETE,
})) {
  sha[name] = await client.scriptLoad(src);
}

const K = {
  waiting: `${TAG}:waiting`,
  active: `${TAG}:active`,
  meta: `${TAG}:concurrency`,
  notify: `${TAG}:notify`,
  ready: `${TAG}:k:ready`,
  counts: `${TAG}:k:counts`,
};

async function statsPhase(label, fn) {
  await client.configSet("latency-tracking", "no").catch(() => {});
  await client.sendCommand(["CONFIG", "RESETSTAT"]);
  const t0 = performance.now();
  const jobs = await fn();
  const ms = performance.now() - t0;
  const info = await client.info("commandstats");
  let usec = 0;
  for (const line of info.split("\n")) {
    const m = line.match(/^cmdstat_evalsha:calls=(\d+),usec=(\d+)/);
    if (m) usec += Number(m[2]);
  }
  console.log(
    `  ${label.padEnd(22)} ${Math.round(jobs / (ms / 1000)).toString().padStart(8)} jobs/s   ` +
    `server ${(usec / jobs).toFixed(1).padStart(6)} µs/job`,
  );
  return { jobsPerSec: jobs / (ms / 1000), usecPerJob: usec / jobs };
}

function evalsha(s, keys, args) {
  return client.evalSha(s, { keys, arguments: args.map(String) });
}

async function runVariant(name, { keyed, numKeys, keyLimit, globalLimit }) {
  await client.flushAll();
  console.log(`\n${name}`);
  if (globalLimit) await client.hSet(K.meta, "limit", String(globalLimit));
  if (keyLimit) await client.hSet(K.meta, "keyLimit", String(keyLimit));

  const ckeyOf = (i) => (numKeys === 1 ? "_" : `u${i % numKeys}`);

  const enq = await statsPhase("enqueue", async () => {
    let i = 0;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (i < N) {
        const id = `j${i++}`;
        if (keyed) {
          await evalsha(sha.KEYED_ENQUEUE, [K.ready, K.counts, K.meta, K.notify], [TAG, id, PAYLOAD, ckeyOf(Number(id.slice(1)))]);
        } else {
          await evalsha(sha.FLAT_ENQUEUE, [K.waiting, K.notify], [TAG, id, PAYLOAD]);
        }
      }
    }));
    return N;
  });

  const drain = await statsPhase("claim+complete", async () => {
    let done = 0;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (done < N) {
        let claimed;
        if (keyed) {
          claimed = await evalsha(sha.KEYED_CLAIM, [K.ready, K.counts, K.meta, K.active], [30000, TAG, BATCH]);
        } else {
          claimed = await evalsha(sha.FLAT_CLAIM, [K.waiting, K.active, K.meta], [30000, TAG, BATCH]);
        }
        if (claimed.length === 0) {
          if (done >= N) break;
          await new Promise((r) => setImmediate(r));
          continue;
        }
        done += claimed.length;
        await Promise.all(claimed.map((id) =>
          keyed
            ? evalsha(sha.KEYED_COMPLETE, [K.ready, K.counts, K.meta, K.active, K.notify], [TAG, id, ckeyOf(Number(id.slice(1)))])
            : evalsha(sha.FLAT_COMPLETE, [K.waiting, K.active, K.meta, K.notify], [TAG, id]),
        ));
      }
    }));
    return N;
  });

  const leftovers = await client.dbSize();
  if (leftovers > 2) console.log(`  WARNING: ${leftovers} keys left in db`);
  return { enq, drain };
}

console.log(`N=${N} jobs, batch=${BATCH}, ${WORKERS} parallel loops, redis:7-alpine @ localhost:6390`);

const a = await runVariant("A. flat (current global layout)", { keyed: false, numKeys: 1 });
const b = await runVariant("B. keyed layout, 1 key (unified 'global')", { keyed: true, numKeys: 1 });
const b2 = await runVariant("B2. keyed layout, 1 key + global limit 500", { keyed: true, numKeys: 1, globalLimit: 500 });
const a2 = await runVariant("A2. flat + global limit 500", { keyed: false, numKeys: 1, globalLimit: 500 });
const c = await runVariant("C. keyed layout, 100 keys, limit 10/key", { keyed: true, numKeys: 100, keyLimit: 10 });

console.log("\nSummary (server µs of Redis CPU per job, full lifecycle):");
for (const [label, r] of [["A flat", a], ["B keyed-1key", b], ["A2 flat+limit", a2], ["B2 keyed+limit", b2], ["C keyed-100keys", c]]) {
  console.log(`  ${label.padEnd(16)} ${(r.enq.usecPerJob + r.drain.usecPerJob).toFixed(1)} µs/job  (enq ${r.enq.usecPerJob.toFixed(1)} + drain ${r.drain.usecPerJob.toFixed(1)})`);
}

await client.quit();
