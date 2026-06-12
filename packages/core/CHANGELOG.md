# Changelog

## [0.0.2](https://github.com/50BytesOfJohn/panqueue/compare/core-v0.0.1...core-v0.0.2) (2026-06-12)


### ⚠ BREAKING CHANGES

* **core:** assertJsonSerializable now throws SerializationError instead of TypeError. Callers catching TypeError must update to catch SerializationError or PanqueueError.
* **config,core:** `QueueConfig.concurrency` is removed. `metaKey()` and `QueueKeys.meta` are removed; the meta hash is no longer used.
* migrate to Node-first pnpm workspace (npm + JSR)

### Features

* **core,worker,config:** add per-queue job retention ([e7e58d0](https://github.com/50BytesOfJohn/panqueue/commit/e7e58d0ef6ad5c48b0b7210c5f2bd47f8d1a87cd))
* **core:** add PanqueueError base class and SerializationError ([d71ce0c](https://github.com/50BytesOfJohn/panqueue/commit/d71ce0ca29a3c29b6e21d952bf46c95828ddc2ff))
* migrate to Node-first pnpm workspace (npm + JSR) ([788dd51](https://github.com/50BytesOfJohn/panqueue/commit/788dd511b6ae1ad8aa4f882313992f77d3c74ffa))


### Bug Fixes

* **core:** bound JSON payload depth in assertJsonSerializable ([e28183d](https://github.com/50BytesOfJohn/panqueue/commit/e28183dcaa5523d077fd7f1bb3c3a185f2007763))
* type redis lua scripts ([8260f97](https://github.com/50BytesOfJohn/panqueue/commit/8260f976c15dffcc38f7f049db2b44339d95ec44))


### Code Refactoring

* **config,core:** remove concurrency config and meta Redis key ([f999d7f](https://github.com/50BytesOfJohn/panqueue/commit/f999d7fb01bf70f2bf85d3fb829b0b29dbdb28cd))
