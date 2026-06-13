import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { LocalCaTimestampAuthority, verifyTimestamp } from '../src/timestamp-authority.js';
import type { TimestampToken } from '@quarry-systems/pangolin-core';

const OID_SHA1 = '1.3.14.3.2.26';

/** Parse a token's CMS SignedData → SignerInfo[0] + TSTInfo for in-test forgery surgery. */
function parseToken(token: Uint8Array): {
  contentInfo: pkijs.ContentInfo;
  signedData: pkijs.SignedData;
} {
  const asn1 = asn1js.fromBER(token.buffer.slice(token.byteOffset, token.byteOffset + token.byteLength));
  const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  return { contentInfo, signedData };
}

/** Re-emit a (possibly mutated) SignedData as a token DER. */
function reEmit(signedData: pkijs.SignedData): Uint8Array {
  return new Uint8Array(
    new pkijs.ContentInfo({
      contentType: pkijs.id_ContentType_SignedData,
      content: signedData.toSchema(true),
    })
      .toSchema()
      .toBER(false),
  );
}

it('local-CA TSA issues a token that verifyTimestamp accepts for the same root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true);
});
it('verifyTimestamp rejects a token whose messageImprint != root', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const token = await tsa.timestamp(createHash('sha256').update('root').digest());
  const otherRoot = createHash('sha256').update('different').digest();
  expect(verifyTimestamp(otherRoot, token, [tsa.caCertDer])).toBe(false);
});
it('verifyTimestamp rejects a token signed by an untrusted CA', async () => {
  const tsaA = new LocalCaTimestampAuthority();
  const tsaB = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const token = await tsaA.timestamp(root);
  expect(verifyTimestamp(root, token, [tsaB.caCertDer])).toBe(false);
});

// ── Negative controls + capability tests (security review hardening) ─────────

it('rejects a messageImprint-swap forgery (imprint replaced WITHOUT re-signing)', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const other = createHash('sha256').update('other-root').digest();
  const honest = await tsa.timestamp(root);

  // Re-wrap the token with the imprint pointing at SHA-256(other) but the original signature.
  const { signedData } = parseToken(honest.token);
  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error('no eContent');
  const tstDer = new Uint8Array(eContent.valueBlock.value[0].valueBlock.valueHexView);
  const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(tstDer.buffer.slice(0)).result });
  tstInfo.messageImprint.hashedMessage = new asn1js.OctetString({
    valueHex: createHash('sha256').update(other).digest(),
  });
  const forgedTstDer = new Uint8Array(tstInfo.toSchema().toBER(false));
  signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: forgedTstDer });
  const forged: TimestampToken = { ...honest, token: reEmit(signedData) };

  expect(verifyTimestamp(other, forged, [tsa.caCertDer])).toBe(false);
});

it('rejects a signature-tamper forgery (a byte flipped in the SignerInfo signature)', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const honest = await tsa.timestamp(root);

  const { signedData } = parseToken(honest.token);
  const sig = signedData.signerInfos[0].signature;
  const bytes = new Uint8Array(sig.valueBlock.valueHexView);
  bytes[0] ^= 0xff;
  signedData.signerInfos[0].signature = new asn1js.OctetString({ valueHex: bytes });
  const forged: TimestampToken = { ...honest, token: reEmit(signedData) };

  expect(verifyTimestamp(root, forged, [tsa.caCertDer])).toBe(false);
});

it('rejects an algo-downgrade token (messageImprint hashAlgo is SHA-1)', async () => {
  const tsa = new LocalCaTimestampAuthority();
  const root = createHash('sha256').update('root').digest();
  const honest = await tsa.timestamp(root);

  const { signedData } = parseToken(honest.token);
  const eContent = signedData.encapContentInfo.eContent;
  if (!eContent) throw new Error('no eContent');
  const tstDer = new Uint8Array(eContent.valueBlock.value[0].valueBlock.valueHexView);
  const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(tstDer.buffer.slice(0)).result });
  tstInfo.messageImprint.hashAlgorithm = new pkijs.AlgorithmIdentifier({
    algorithmId: OID_SHA1,
    algorithmParams: new asn1js.Null(),
  });
  const forgedTstDer = new Uint8Array(tstInfo.toSchema().toBER(false));
  signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: forgedTstDer });
  const forged: TimestampToken = { ...honest, token: reEmit(signedData) };

  expect(verifyTimestamp(root, forged, [tsa.caCertDer])).toBe(false);
});

it('never throws on malformed token bytes; returns false', () => {
  const root = createHash('sha256').update('root').digest();
  let result: boolean | undefined;
  expect(() => {
    result = verifyTimestamp(
      root,
      { alg: 'rfc3161', token: new Uint8Array([1, 2, 3]), at: '2026-06-12T00:00:00Z' },
      [],
    );
  }).not.toThrow();
  expect(result).toBe(false);
});

it('rejects a token whose leaf lacks the id-kp-timeStamping EKU (I1)', async () => {
  const tsa = new LocalCaTimestampAuthority({ tsaEku: false });
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(false);
});

it('rejects a token whose leaf validity window excludes genTime (I2)', async () => {
  // Leaf already expired by the time the token is minted (genTime = now).
  const tsa = new LocalCaTimestampAuthority({
    leafNotBefore: new Date(Date.now() - 2 * 86_400_000),
    leafNotAfter: new Date(Date.now() - 86_400_000),
  });
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(false);
});

it('verifies a signed-attributes token TRUE, and rejects a tampered one (I3)', async () => {
  const tsa = new LocalCaTimestampAuthority({ signedAttrs: true });
  const root = createHash('sha256').update('root').digest();
  const token = await tsa.timestamp(root);
  // The signed-attrs path verifies the real freeTSA-shaped token.
  expect(verifyTimestamp(root, token, [tsa.caCertDer])).toBe(true);

  // Tampering the signed-attrs signature must fail.
  const { signedData } = parseToken(token.token);
  const sig = signedData.signerInfos[0].signature;
  const bytes = new Uint8Array(sig.valueBlock.valueHexView);
  bytes[0] ^= 0xff;
  signedData.signerInfos[0].signature = new asn1js.OctetString({ valueHex: bytes });
  const forged: TimestampToken = { ...token, token: reEmit(signedData) };
  expect(verifyTimestamp(root, forged, [tsa.caCertDer])).toBe(false);

  // Swapping the TSTInfo content (so message-digest attr no longer binds it) must fail,
  // even though signedAttrs + its signature are untouched. Proves the message-digest bind.
  const { signedData: sd2 } = parseToken(token.token);
  const eContent = sd2.encapContentInfo.eContent;
  if (!eContent) throw new Error('no eContent');
  const tstDer = new Uint8Array(eContent.valueBlock.value[0].valueBlock.valueHexView);
  const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(tstDer.buffer.slice(0)).result });
  tstInfo.messageImprint.hashedMessage = new asn1js.OctetString({
    valueHex: createHash('sha256').update(Buffer.from('other-root')).digest(),
  });
  sd2.encapContentInfo.eContent = new asn1js.OctetString({
    valueHex: new Uint8Array(tstInfo.toSchema().toBER(false)),
  });
  const contentForged: TimestampToken = { ...token, token: reEmit(sd2) };
  const otherRoot = createHash('sha256').update(Buffer.from('other-root')).digest();
  expect(verifyTimestamp(otherRoot, contentForged, [tsa.caCertDer])).toBe(false);
});
