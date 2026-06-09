import type { CommandParser, RedisScripts } from "redis";

export type PanqueueRedisScript<TArgs extends unknown[]> = RedisScripts[string] & {
  parseCommand(this: void, parser: CommandParser, ...args: TArgs): void;
  transformReply(this: void, reply: unknown): unknown;
};
