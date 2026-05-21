# @quarry-systems/agora-providers-local-docker

Scaffold package for the **local-docker ComputeProvider** used in developer and test environments.

Full implementation of the local-docker ComputeProvider arrives in **DAG 2**, which will add `dockerode` as a dependency and wire this package into the Agora compute pipeline.

## Status

Scaffold only. No runtime exports yet.

## Usage

This package will export a `LocalDockerProvider` implementing the `ComputeProvider` interface from `@quarry-systems/agora-core`.

```typescript
import { LocalDockerProvider } from '@quarry-systems/agora-providers-local-docker';
```

## Development

```bash
pnpm -F @quarry-systems/agora-providers-local-docker typecheck
pnpm -F @quarry-systems/agora-providers-local-docker test
```
