/** Retention for one terminal job state. */
export type RetentionRule =
  | boolean
  | {
      /** Max age in milliseconds a finished job is kept. */
      ttl?: number;
      /** Max number of finished jobs kept. */
      count?: number;
    };

/** A {@link RetentionRule} normalized to scalars consumable by Lua. */
export interface ResolvedRetention {
  mode: "delete" | "keep" | "trim";
  /** Max age in milliseconds; -1 = no age bound. */
  ttl: number;
  /** Max kept count; -1 = no count bound. */
  count: number;
}

/** Default: completed jobs are deleted on success. */
export const DEFAULT_COMPLETED_RETENTION: RetentionRule = false;

/** Default: failed jobs are kept 7 days, capped at 1000 entries. */
export const DEFAULT_FAILED_RETENTION: RetentionRule = { ttl: 604_800_000, count: 1000 };

/** Normalize a retention rule once in TS so Lua only sees scalars. */
export function resolveRetention(
  rule: RetentionRule | undefined,
  fallback: RetentionRule,
): ResolvedRetention {
  const effective = rule ?? fallback;
  if (effective === false) return { mode: "delete", ttl: -1, count: -1 };
  if (effective === true) return { mode: "keep", ttl: -1, count: -1 };

  const ttl = effective.ttl ?? -1;
  const count = effective.count ?? -1;
  if (ttl < 0 && count < 0) return { mode: "keep", ttl: -1, count: -1 };
  return { mode: "trim", ttl, count };
}
