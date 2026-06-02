import type { CommandParser, RedisScripts } from "redis";

export type PanqueueRedisScript<TArgs extends string[]> = RedisScripts[string] & {
  parseCommand(this: void, parser: CommandParser, ...args: TArgs): void;
  transformReply(this: void, reply: unknown): unknown;
};
