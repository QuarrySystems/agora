---
title: plan.json schema
description: Every field of an orchestrator plan — the Run envelope and its WorkItem entries (executor, inputs, depends_on, resourceLocks).
sidebar:
  order: 6
---

A `plan.json` describes a DAG of agent tasks submitted to the orchestrator via
`agora orch submit`. It deserializes into a `Run` — a set of `WorkItem`s plus
their edges, placed on a named queue. The schema below is the `Run` /
`WorkItem` shape from `agora-orchestrator`.

## The `Run` envelope

```typescript
interface Run {
  id: string;        // run id (also overridable via `agora orch submit --queue` for queue)
  queue: string;     // named queue this run is placed on
  items: WorkItem[]; // the DAG nodes
}
```

`agora orch submit --queue <name>` overrides the plan's `queue` at submit time.

## `WorkItem`

Each entry in `items` is one dispatchable DAG node:

```typescript
interface WorkItem {
  id: string;                       // unique within the run
  executor: string;                 // id of the registered Executor that runs this item
  inputs: Record<string, unknown>;  // forwarded to the executor
  depends_on: string[];             // ids of items that must reach `done` before this readies
  resourceLocks: string[];          // shared resource keys that serialize contending items
  subagentShape?: string;           // optional: id of a registered SubagentShape; when set, `inputs` is validated against its inputSchema
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | `string` | yes | Item id, unique within the run. Referenced by other items' `depends_on`. |
| `executor` | `string` | yes | The registered `Executor` that runs this item (e.g. `dispatch`). |
| `inputs` | object | yes | Free-form inputs forwarded to the executor. For the `dispatch` executor these include `subagent` and `workerInput`. |
| `depends_on` | `string[]` | yes | Ids of items in the same run that must reach `done` before this item readies. Empty array = no dependencies. |
| `resourceLocks` | `string[]` | yes | Shared resource keys. Items holding overlapping keys serialize; items with disjoint keys fan out in parallel. Empty array = no locks. |
| `subagentShape` | `string` | no | When set, the item's `inputs` are validated against the named `SubagentShape`'s `inputSchema`. |

:::note
The lock field is `resourceLocks`, **not** `locks`. Some prose (including the
README's Offload section) abbreviates it to "resource locks" / "locks", but the
actual JSON key and the `WorkItem` interface field are `resourceLocks`.
:::

## Worked example

This is
[`examples/offload-fanout/plan.json`](https://github.com/quarrysystems/agora/tree/main/examples/offload-fanout/plan.json)
— a four-item fan-out: three independent edits (disjoint locks, run in parallel)
followed by a `verify` that depends on all three.

```json
{
  "id": "fanout-1",
  "queue": "default",
  "items": [
    {
      "id": "edit-alpha",
      "executor": "dispatch",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "alpha.ts" } },
      "depends_on": [],
      "resourceLocks": ["fixture/alpha.ts"]
    },
    {
      "id": "edit-beta",
      "executor": "dispatch",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "beta.ts" } },
      "depends_on": [],
      "resourceLocks": ["fixture/beta.ts"]
    },
    {
      "id": "edit-shared",
      "executor": "dispatch",
      "inputs": { "subagent": "code-edit", "workerInput": { "file": "shared.ts" } },
      "depends_on": [],
      "resourceLocks": ["fixture/shared.ts"]
    },
    {
      "id": "verify",
      "executor": "dispatch",
      "inputs": { "subagent": "verify" },
      "depends_on": ["edit-alpha", "edit-beta", "edit-shared"],
      "resourceLocks": []
    }
  ]
}
```

## Item lifecycle states

Once submitted, each item carries a mutable status from this closed set:
`pending`, `ready`, `running`, `done`, `failed`, `skipped`, `cancelled`. The
terminal subset is `done` / `failed` / `skipped` / `cancelled`. When an item
fails or is cascaded, its persisted state carries a `reason` string. These are
internal run-state fields (`ItemState`), not part of the submitted plan.

## Subagent / env / target bindings

A `WorkItem` itself does not pin a target, env bundle, or worker image —
those bindings live on the **executor** configured in `agora.config`, not in
the plan. For the `dispatch` executor (`DispatchExecutor`), the
[`agora.config.mjs`](/agora/reference/config/) wires `target`, `workerImage`,
and `secrets`; the plan item supplies only `inputs.subagent` and the
per-item `workerInput`. This keeps the plan portable across environments —
the same `plan.json` runs locally or against Fargate depending solely on the
executor wiring.
