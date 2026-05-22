import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CreateSecretCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { mintCallbackHmac, signCallback } from '../src/callback-hmac.js';

describe('signCallback', () => {
  it('produces a stable HMAC-SHA256 hex over dispatchId.timestamp.payload', () => {
    const sig = signCallback({
      hmacKey: 'k' + 'a'.repeat(63),
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: '{"kind":"dispatch.finished"}',
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);

    // Stable: same inputs → same signature
    const sig2 = signCallback({
      hmacKey: 'k' + 'a'.repeat(63),
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: '{"kind":"dispatch.finished"}',
    });
    expect(sig2).toBe(sig);
  });

  it('matches an independent HMAC-SHA256 computation of dispatchId.timestamp.payload', () => {
    const hmacKey = 'super-secret-key';
    const dispatchId = 'dispatch-42';
    const timestampIso = '2026-05-21T13:14:15Z';
    const payload = '{"hello":"world"}';

    const sig = signCallback({ hmacKey, dispatchId, timestampIso, payload });

    const expected = createHmac('sha256', hmacKey)
      .update(`${dispatchId}.${timestampIso}.${payload}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  it('produces a different signature when any field changes', () => {
    const base = {
      hmacKey: 'key',
      dispatchId: 'd1',
      timestampIso: '2026-05-21T12:00:00Z',
      payload: 'p',
    };
    const sigBase = signCallback(base);
    expect(signCallback({ ...base, hmacKey: 'different' })).not.toBe(sigBase);
    expect(signCallback({ ...base, dispatchId: 'd2' })).not.toBe(sigBase);
    expect(signCallback({ ...base, timestampIso: '2026-05-21T12:00:01Z' })).not.toBe(sigBase);
    expect(signCallback({ ...base, payload: 'q' })).not.toBe(sigBase);
  });
});

/**
 * Minimal fake SecretsManagerClient that captures sent commands and
 * returns a synthesized ARN response. We only need the `send` shape.
 */
function makeFakeSecretsClient(arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:test-AbCdEf') {
  const sent: CreateSecretCommand[] = [];
  const client = {
    send: async (cmd: CreateSecretCommand) => {
      sent.push(cmd);
      return { ARN: arn, Name: cmd.input.Name, VersionId: 'v1' };
    },
  } as unknown as SecretsManagerClient;
  return { client, sent };
}

describe('mintCallbackHmac', () => {
  it('returns the ARN reported by Secrets Manager', async () => {
    const arn = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:my-AbCdEf';
    const { client } = makeFakeSecretsClient(arn);
    const result = await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-1',
    });
    expect(result.arn).toBe(arn);
  });

  it('returns ttlSeconds equal to dispatchTimeoutSeconds + 300 (5min buffer)', async () => {
    const { client } = makeFakeSecretsClient();
    const result = await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-1',
      dispatchTimeoutSeconds: 3600,
    });
    expect(result.ttlSeconds).toBe(3900);
  });

  it('defaults ttlSeconds to 7200+300 when no dispatchTimeoutSeconds given', async () => {
    const { client } = makeFakeSecretsClient();
    const result = await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-1',
    });
    expect(result.ttlSeconds).toBe(7500);
  });

  it('sends a CreateSecretCommand with name prefix + dispatchId', async () => {
    const { client, sent } = makeFakeSecretsClient();
    await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-xyz',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.Name).toBe('agora/callback-hmac/dispatch-xyz');
  });

  it('uses a custom namePrefix when provided', async () => {
    const { client, sent } = makeFakeSecretsClient();
    await mintCallbackHmac({
      client,
      namePrefix: 'my/prefix',
      dispatchId: 'd9',
    });
    expect(sent[0]!.input.Name).toBe('my/prefix/d9');
  });

  it('stages a 64-char hex (32-byte) random key as the SecretString', async () => {
    const { client, sent } = makeFakeSecretsClient();
    await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-1',
    });
    const secret = sent[0]!.input.SecretString!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a fresh key on each invocation', async () => {
    const { client, sent } = makeFakeSecretsClient();
    await mintCallbackHmac({ client, dispatchId: 'a' });
    await mintCallbackHmac({ client, dispatchId: 'b' });
    expect(sent[0]!.input.SecretString).not.toBe(sent[1]!.input.SecretString);
  });

  it('tags the secret with agora:dispatchId and agora:ttlSeconds', async () => {
    const { client, sent } = makeFakeSecretsClient();
    await mintCallbackHmac({
      client,
      dispatchId: 'dispatch-tagged',
      dispatchTimeoutSeconds: 1800,
    });
    const tags = sent[0]!.input.Tags ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        { Key: 'agora:dispatchId', Value: 'dispatch-tagged' },
        { Key: 'agora:ttlSeconds', Value: '2100' },
      ]),
    );
  });

  it('throws if Secrets Manager returns no ARN', async () => {
    const client = {
      send: async () => ({}),
    } as unknown as SecretsManagerClient;
    await expect(
      mintCallbackHmac({ client, dispatchId: 'dispatch-1' }),
    ).rejects.toThrow(/no ARN/);
  });
});
