# @quarry-systems/agora-providers-aws-creds

Scaffold package — future home of the AWS `CredentialProvider` implementation.

The CredentialProvider will wrap the AWS default credential chain (environment variables, shared credentials file, IAM role, etc.) and will be implemented in DAG 2, conforming to the `CredentialProvider` interface defined in `@quarry-systems/agora-core`.

## Status

Scaffold only. No public API yet.

## Dependencies

- `@quarry-systems/agora-core` — workspace peer providing core types and interfaces.
