# Changelog

## [0.0.2](https://github.com/50BytesOfJohn/panqueue/compare/client-v0.0.1...client-v0.0.2) (2026-06-12)


### ⚠ BREAKING CHANGES

* **client:** RedisConnection constructor now accepts a second options argument. Disconnect is permanent — ClientClosedError is thrown on post-disconnect access.
* **client:** `createQueueClient(config)` is removed. Use `new QueueClient(config)` instead. `QueueClientOptions` is removed; the constructor accepts `PanqueueConfig` (shared config, types inferred) or `QueueClientConfig` (standalone). `QueueClientConfig.queues` is removed.
* migrate to Node-first pnpm workspace (npm + JSR)
* **config:** default global concurrency scope
* **worker:** Job lifecycle accounting replaces attempts with runs, failures, and stalls.

### Features

* add async dispose support and connection promise caching ([60542cd](https://github.com/50BytesOfJohn/panqueue/commit/60542cd0ae24357e28f252057f6dd2af586cdc43))
* **client:** add createQueueClient factory with dual config support ([ab97683](https://github.com/50BytesOfJohn/panqueue/commit/ab9768364d091d67f1d979ab360522a07625f46c))
* **client:** add typed errors, connection lifecycle hooks, and producer defaults ([757d4e0](https://github.com/50BytesOfJohn/panqueue/commit/757d4e00606e976c8b2d57027049d722bad79ea6))
* **config:** default global concurrency scope ([f58c241](https://github.com/50BytesOfJohn/panqueue/commit/f58c2416ca2404fe4661f939dc9ca994bb345fe7))
* implement job enqueue with atomic Lua script ([0064fa9](https://github.com/50BytesOfJohn/panqueue/commit/0064fa93b5c1c4a56a1a7392345c8f8f809db8a8))
* migrate to Node-first pnpm workspace (npm + JSR) ([788dd51](https://github.com/50BytesOfJohn/panqueue/commit/788dd511b6ae1ad8aa4f882313992f77d3c74ffa))
* **worker:** introduce definition-based worker pools ([a1f3a62](https://github.com/50BytesOfJohn/panqueue/commit/a1f3a62e10e5df43920c5a201591663884e15fb3))


### Bug Fixes

* type redis lua scripts ([8260f97](https://github.com/50BytesOfJohn/panqueue/commit/8260f976c15dffcc38f7f049db2b44339d95ec44))


### Code Refactoring

* **client:** remove createQueueClient, accept PanqueueConfig in constructor ([f0e3a8c](https://github.com/50BytesOfJohn/panqueue/commit/f0e3a8c5a0ebd0e95085682e64b41279b5a72107))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @panqueue/config bumped to 0.0.2
    * @panqueue/core bumped to 0.0.2
