# Changelog

## [0.0.2](https://github.com/50BytesOfJohn/panqueue/compare/config-v0.0.1...config-v0.0.2) (2026-06-12)


### ⚠ BREAKING CHANGES

* **config,core:** `QueueConfig.concurrency` is removed. `metaKey()` and `QueueKeys.meta` are removed; the meta hash is no longer used.
* **client:** `createQueueClient(config)` is removed. Use `new QueueClient(config)` instead. `QueueClientOptions` is removed; the constructor accepts `PanqueueConfig` (shared config, types inferred) or `QueueClientConfig` (standalone). `QueueClientConfig.queues` is removed.
* migrate to Node-first pnpm workspace (npm + JSR)
* **config:** default global concurrency scope
* **worker:** add leases and force shutdown
* **config:** QueueConfig.mode now accepts "global" instead of "simple"

### Features

* **client:** add createQueueClient factory with dual config support ([ab97683](https://github.com/50BytesOfJohn/panqueue/commit/ab9768364d091d67f1d979ab360522a07625f46c))
* **config:** add shared configuration package with definePanqueueConfig ([1985f21](https://github.com/50BytesOfJohn/panqueue/commit/1985f2117559b3d82b3fa4f80b8e94dcd8099ce6))
* **config:** default global concurrency scope ([f58c241](https://github.com/50BytesOfJohn/panqueue/commit/f58c2416ca2404fe4661f939dc9ca994bb345fe7))
* **core,worker,config:** add per-queue job retention ([e7e58d0](https://github.com/50BytesOfJohn/panqueue/commit/e7e58d0ef6ad5c48b0b7210c5f2bd47f8d1a87cd))
* migrate to Node-first pnpm workspace (npm + JSR) ([788dd51](https://github.com/50BytesOfJohn/panqueue/commit/788dd511b6ae1ad8aa4f882313992f77d3c74ffa))
* **worker:** add leases and force shutdown ([482e8a7](https://github.com/50BytesOfJohn/panqueue/commit/482e8a7a12187ac29b612310772fd0e1a4e4164c))


### Bug Fixes

* type redis lua scripts ([8260f97](https://github.com/50BytesOfJohn/panqueue/commit/8260f976c15dffcc38f7f049db2b44339d95ec44))


### Code Refactoring

* **client:** remove createQueueClient, accept PanqueueConfig in constructor ([f0e3a8c](https://github.com/50BytesOfJohn/panqueue/commit/f0e3a8c5a0ebd0e95085682e64b41279b5a72107))
* **config,core:** remove concurrency config and meta Redis key ([f999d7f](https://github.com/50BytesOfJohn/panqueue/commit/f999d7fb01bf70f2bf85d3fb829b0b29dbdb28cd))
* **config:** rename queue mode from "simple" to "global" ([8664e43](https://github.com/50BytesOfJohn/panqueue/commit/8664e43ddca317e3cc114e6dda433d42bb3f3fcf))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @panqueue/core bumped to 0.0.2
