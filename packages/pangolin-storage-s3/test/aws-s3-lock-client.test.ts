import { describe, it, expect } from 'vitest';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { AwsS3LockClient } from '../src/aws-s3-lock-client.js';

const MINIO = process.env.PANGOLIN_S3_ENDPOINT;
const d = MINIO ? describe : describe.skip;

function client() {
  return new S3Client({ endpoint: MINIO, forcePathStyle: true, region: 'us-east-1',
    credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' } });
}

d('AwsS3LockClient against MinIO object lock', () => {
  it('reads the original locked version even after an attacker adds a forged new version', async () => {
    // This is the WORM property the audit anchor relies on. Object Lock keeps the ORIGINAL
    // version undeletable under COMPLIANCE, but it does NOT stop an attacker (with write
    // access) from PUT-ing a NEW version that becomes "latest". So a latest-version read is
    // forgeable; getObject MUST return the earliest (original, locked) version.
    const c = client();
    await c.send(new CreateBucketCommand({ Bucket: 'pangolin-audit', ObjectLockEnabledForBucket: true })).catch(() => {});
    const lock = new AwsS3LockClient({ client: c, bucket: 'pangolin-audit' });
    const key = `audit/roots/worm-${Date.now()}.json`;
    const future = new Date(Date.now() + 60_000);

    // Seal: the anchor writes the original root under COMPLIANCE retention.
    await lock.putObject(key, new Uint8Array([1]), { retainUntil: future, mode: 'COMPLIANCE' });

    // Attacker with bucket write access PUTs a forged body to the SAME key — S3 versioning
    // makes this a NEW (latest) version; the locked original survives as an older version.
    await c.send(new PutObjectCommand({ Bucket: 'pangolin-audit', Key: key, Body: new Uint8Array([2]) }));

    // The anchor's read must return the ORIGINAL (earliest, locked) bytes — not the forgery.
    expect(await lock.getObject(key)).toEqual(new Uint8Array([1]));
  });
});
