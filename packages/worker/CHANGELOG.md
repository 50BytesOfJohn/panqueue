# Changelog

## [0.0.2](https://github.com/50BytesOfJohn/panqueue/compare/worker-v0.0.1...worker-v0.0.2) (2026-06-12)


### ⚠ BREAKING CHANGES

* **worker:** WorkerErrorEvent.scope replaced by WorkerErrorEvent.kind/jobId/handlerName. WorkerPool constructor options now accepts an optional `events` field.
* **worker:** Worker event handler signatures changed. onJobStart → onJobStarted, onJobComplete → onJobCompleted, onJobFail → onJobFailed (all receive event objects). onError → onWorkerError. onJobRecovered removed. Stall terminal failures now emit onJobFailed.
* migrate to Node-first pnpm workspace (npm + JSR)
* **config:** default global concurrency scope
* **worker:** Job lifecycle accounting replaces attempts with runs, failures, and stalls.
* **worker:** add leases and force shutdown

### Features

* add async dispose support and connection promise caching ([60542cd](https://github.com/50BytesOfJohn/panqueue/commit/60542cd0ae24357e28f252057f6dd2af586cdc43))
* **client:** add createQueueClient factory with dual config support ([ab97683](https://github.com/50BytesOfJohn/panqueue/commit/ab9768364d091d67f1d979ab360522a07625f46c))
* **config:** default global concurrency scope ([f58c241](https://github.com/50BytesOfJohn/panqueue/commit/f58c2416ca2404fe4661f939dc9ca994bb345fe7))
* **core,worker,config:** add per-queue job retention ([e7e58d0](https://github.com/50BytesOfJohn/panqueue/commit/e7e58d0ef6ad5c48b0b7210c5f2bd47f8d1a87cd))
* migrate to Node-first pnpm workspace (npm + JSR) ([788dd51](https://github.com/50BytesOfJohn/panqueue/commit/788dd511b6ae1ad8aa4f882313992f77d3c74ffa))
* **worker:** add connection lifecycle hooks, typed errors, and refined WorkerErrorEvent ([4d94038](https://github.com/50BytesOfJohn/panqueue/commit/4d94038ef6b6e844d7058e4fcb7d26554d783bc3))
* **worker:** add leases and force shutdown ([482e8a7](https://github.com/50BytesOfJohn/panqueue/commit/482e8a7a12187ac29b612310772fd0e1a4e4164c))
* **worker:** add WorkerPool for managing multiple typed queue consumers ([34594b6](https://github.com/50BytesOfJohn/panqueue/commit/34594b60a0ca137173ebb51f38654a9730512c86))
* **worker:** implement Worker with lifecycle state machine and job processing ([50aaedc](https://github.com/50BytesOfJohn/panqueue/commit/50aaedc10e3c4fece9390c7f5df152d7eba20a9d))
* **worker:** introduce definition-based worker pools ([a1f3a62](https://github.com/50BytesOfJohn/panqueue/commit/a1f3a62e10e5df43920c5a201591663884e15fb3))
* **worker:** redesign event surface — single-event objects, distinct retry/fail, stall cause ([b85a638](https://github.com/50BytesOfJohn/panqueue/commit/b85a63894e68d0c05b6002666e64f880a6031a93))
* **worker:** refine event payloads — add timing, remove attempt copies, report hook failures ([a22c597](https://github.com/50BytesOfJohn/panqueue/commit/a22c597b599a868ecc580377347e8ef8e396e623))


### Bug Fixes

* type redis lua scripts ([8260f97](https://github.com/50BytesOfJohn/panqueue/commit/8260f976c15dffcc38f7f049db2b44339d95ec44))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @panqueue/config bumped to 0.0.2
    * @panqueue/core bumped to 0.0.2
