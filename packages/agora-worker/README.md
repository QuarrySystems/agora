# agora-worker

`@quarry-systems/agora-worker` is the container-side runtime in DAG 2.

## Design

The worker is runtime-agnostic (per §6 of the spec): it carries no knowledge of
the underlying execution environment. Instead, it dispatches work to the
configured `RuntimeAdapter`, which is injected at runtime by the operator.

This means provider packages (`agora-providers-*`) are never direct dependencies
of this package — they are composed at the deployment boundary, not here.

## Usage

Install together with your chosen `RuntimeAdapter` implementation and wire the
adapter into the worker at startup:

```ts
import { createWorker } from "@quarry-systems/agora-worker";
import { MyRuntimeAdapter } from "@quarry-systems/agora-providers-my-runtime";

const worker = createWorker({ adapter: new MyRuntimeAdapter() });
await worker.start();
```

## Dependencies

- `@quarry-systems/agora-core` — shared types and contracts (workspace dep)
- No `agora-providers-*` packages — providers are injected, not bundled
