import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { S3LockClient } from '@quarry-systems/pangolin-core';

export interface AwsS3LockClientOpts { client: S3Client; bucket: string; }

export class AwsS3LockClient implements S3LockClient {
  constructor(private readonly o: AwsS3LockClientOpts) {}
  async putObject(key: string, body: Uint8Array, opts: { retainUntil: Date; mode: 'COMPLIANCE' }) {
    await this.o.client.send(new PutObjectCommand({
      Bucket: this.o.bucket, Key: key, Body: body,
      ObjectLockMode: opts.mode,
      ObjectLockRetainUntilDate: opts.retainUntil,
    }));
  }
  /**
   * Read the EARLIEST (original) version of `key`, NOT the latest.
   *
   * Object Lock (COMPLIANCE) makes the original sealed version undeletable, but it does
   * NOT prevent an attacker with bucket write access from PUT-ing a NEW version that becomes
   * "latest" — so a latest-version read of the anchored root is forgeable. S3 assigns version
   * order server-side and no version can be inserted before the first, so the earliest version
   * IS the original immutable root. Reading it (ignoring any later forged versions) is what makes
   * the anchor genuinely tamper-evident.
   */
  async getObject(key: string) {
    const listed = await this.o.client.send(
      new ListObjectVersionsCommand({ Bucket: this.o.bucket, Prefix: key }),
    );
    const versions = (listed.Versions ?? []).filter((v) => v.Key === key && v.VersionId);
    if (versions.length === 0) return undefined;
    versions.sort((a, b) => (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0));
    const r = await this.o.client.send(
      new GetObjectCommand({ Bucket: this.o.bucket, Key: key, VersionId: versions[0]!.VersionId }),
    );
    if (!r.Body) throw new Error('S3 GetObject returned no body');
    return new Uint8Array(await r.Body.transformToByteArray());
  }
}
