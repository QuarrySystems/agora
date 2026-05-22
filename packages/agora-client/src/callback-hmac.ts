import { randomBytes, createHmac } from 'node:crypto';
import {
  SecretsManagerClient,
  CreateSecretCommand,
} from '@aws-sdk/client-secrets-manager';

export interface HmacMintOpts {
  client?: SecretsManagerClient;
  namePrefix?: string;
}

/**
 * Mint a per-dispatch HMAC key, stage it in Secrets Manager with a TTL
 * matching the dispatch's expected duration plus a 5-minute buffer, and
 * return the ARN plus the effective ttlSeconds.
 *
 * The worker fetches the key by ARN (passed as `AGORA_CALLBACK_TOKEN_REF`)
 * and uses {@link signCallback} to sign every callback POST so that the
 * client and worker compute identical signatures (§7.3).
 */
export async function mintCallbackHmac(
  opts: HmacMintOpts & { dispatchId: string; dispatchTimeoutSeconds?: number },
): Promise<{ arn: string; ttlSeconds: number }> {
  const client = opts.client ?? new SecretsManagerClient({});
  const namePrefix = opts.namePrefix ?? 'agora/callback-hmac';
  const ttlSeconds = (opts.dispatchTimeoutSeconds ?? 7200) + 300;
  const key = randomBytes(32).toString('hex');
  const res = await client.send(
    new CreateSecretCommand({
      Name: `${namePrefix}/${opts.dispatchId}`,
      SecretString: key,
      Tags: [
        { Key: 'agora:dispatchId', Value: opts.dispatchId },
        { Key: 'agora:ttlSeconds', Value: String(ttlSeconds) },
      ],
    }),
  );
  if (!res.ARN) throw new Error(`HMAC secret mint returned no ARN`);
  return { arn: res.ARN, ttlSeconds };
}

/**
 * Sign a callback payload per §7.3. The message is
 * `${dispatchId}.${timestampIso}.${payload}` and the digest is lowercase
 * hex HMAC-SHA256. Exported so the worker can compute identical
 * signatures from the same key.
 */
export function signCallback(opts: {
  hmacKey: string;
  dispatchId: string;
  timestampIso: string;
  payload: string;
}): string {
  const message = `${opts.dispatchId}.${opts.timestampIso}.${opts.payload}`;
  return createHmac('sha256', opts.hmacKey).update(message).digest('hex');
}
