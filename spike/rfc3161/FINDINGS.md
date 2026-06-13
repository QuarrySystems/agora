# RFC 3161 / CMS library decision

Ratified via a passing offline roundtrip (`node roundtrip.mjs` -> `OK <iso>`) **and** a real
third-party proof against freeTSA (`SPIKE_NETWORK=1 node roundtrip.mjs` -> `OK (freeTSA) <iso>`).
The same `verifyTimestampToken()` verifies both the self-minted token and the live freeTSA token.

## Ratified packages (exact versions)
- pkijs: 3.4.0        # pure-JS, MIT, no native bindings; full RFC 3161 TSP support
- asn1js: 3.0.10      # ASN.1 DER/BER codec that pkijs is built on
- pvutils: 1.1.5      # transitive helper pkijs depends on (kept per spike scaffold)

Note: `package.json` pins `^3.2.4 / ^3.0.5 / ^1.1.3`; npm resolved the above. The later
implementer should pin these EXACT resolved versions in the real package.

Engine: pkijs has no crypto of its own -- it drives WebCrypto. On Node 20+ wire it once:
```js
import { webcrypto } from "node:crypto";
pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto, subtle: webcrypto.subtle }));
```

## API entry points (real call chains, copy-pasteable)

All calls below are exercised by `roundtrip.mjs` and are verified working, not guessed.

### Mint a token (LocalCaTimestampAuthority)
Build a self-signed CA + a TSA leaf cert (signed by the CA), then a CMS SignedData over a TSTInfo.

```js
// --- self-signed CA cert ---
const caKeys = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" },
  true, ["sign", "verify"]);
const caCert = new pkijs.Certificate();
caCert.version = 2;                                            // v3
caCert.serialNumber = new asn1js.Integer({ value: 1 });
caCert.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "Test CA" }) }));
caCert.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.Utf8String({ value: "Test CA" }) }));
caCert.notBefore.value = new Date(Date.now() - 60_000);
caCert.notAfter.value  = new Date(Date.now() + 365*24*3600*1000);
await caCert.subjectPublicKeyInfo.importKey(caKeys.publicKey);
const bc = new pkijs.BasicConstraints({ cA: true });
caCert.extensions = [ new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: bc.toSchema().toBER(false), parsedValue: bc }) ];
await caCert.sign(caKeys.privateKey, "SHA-256");

// --- TSA leaf cert, signed BY the CA, carrying the id-kp-timeStamping EKU ---
const tsaKeys = await webcrypto.subtle.generateKey(/* same RSA params */, true, ["sign", "verify"]);
const tsaCert = new pkijs.Certificate(); // version=2, serial, issuer="Test CA", subject="Test TSA", validity as above
await tsaCert.subjectPublicKeyInfo.importKey(tsaKeys.publicKey);
const eku = new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }); // id-kp-timeStamping
tsaCert.extensions = [ new pkijs.Extension({ extnID: "2.5.29.37", critical: true, extnValue: eku.toSchema().toBER(false), parsedValue: eku }) ];
await tsaCert.sign(caKeys.privateKey, "SHA-256");              // <-- signed by the CA

// --- TSTInfo over the messageImprint (SHA-256 of the root, a Uint8Array) ---
const tstInfo = new pkijs.TSTInfo({
  version: 1,
  policy: "1.2.3.4.1",                                         // arbitrary TSA policy OID
  messageImprint: new pkijs.MessageImprint({
    hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: "2.16.840.1.101.3.4.2.1", algorithmParams: new asn1js.Null() }), // SHA-256
    hashedMessage: new asn1js.OctetString({ valueHex: messageImprint }),
  }),
  serialNumber: new asn1js.Integer({ value: Date.now() }),
  genTime: new Date(),
});
const tstInfoDer = tstInfo.toSchema().toBER(false);

// --- wrap TSTInfo as the eContent of a CMS SignedData, embed the chain, sign ---
const signedData = new pkijs.SignedData({
  version: 3,
  encapContentInfo: new pkijs.EncapsulatedContentInfo({
    eContentType: pkijs.id_eContentType_TSTInfo,              // "1.2.840.113549.1.9.16.1.4"
    eContent: new asn1js.OctetString({ valueHex: tstInfoDer }),
  }),
  signerInfos: [ new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: tsaCert.issuer, serialNumber: tsaCert.serialNumber }),
  }) ],
  certificates: [tsaCert, caCert],                            // embed so the verifier can build the chain
});
await signedData.sign(tsaKeys.privateKey, 0, "SHA-256");      // (privateKey, signerIndex, hashAlgo)

// --- outer ContentInfo -> the RFC 3161 token DER ---
const tokenDer = new Uint8Array(new pkijs.ContentInfo({
  contentType: pkijs.id_ContentType_SignedData,
  content: signedData.toSchema(true),                          // pass `true` to emit the SignedData body
}).toSchema().toBER(false));
```

### Verify a token (verifyTimestamp)
Parse the CMS SignedData, read `messageImprint.hashedMessage`, validate the signer chains to a trusted cert.

```js
// --- parse outer ContentInfo -> SignedData ---
const asn1 = asn1js.fromBER(tokenDer);                          // tokenDer: Uint8Array
if (asn1.offset === -1) return false;                           // not valid DER
const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
if (contentInfo.contentType !== pkijs.id_ContentType_SignedData) return false;
const signedData = new pkijs.SignedData({ schema: contentInfo.content });
if (signedData.encapContentInfo.eContentType !== pkijs.id_eContentType_TSTInfo) return false;

// --- extract the TSTInfo DER (see Gotcha #1: eContent comes back CONSTRUCTED) ---
function extractEContentBytes(oct) {
  const vb = oct.valueBlock;
  if (vb.isConstructed && Array.isArray(vb.value) && vb.value.length) {
    const parts = vb.value.map(c => new Uint8Array(c.valueBlock.valueHexView));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let off = 0; for (const p of parts) { out.set(p, off); off += p.byteLength; }
    return out;
  }
  return new Uint8Array(vb.valueHexView);
}
const tstDer = extractEContentBytes(signedData.encapContentInfo.eContent);
const tstInfo = new pkijs.TSTInfo({ schema: asn1js.fromBER(tstDer).result });

// --- check messageImprint.hashedMessage === SHA-256(root) ---
const imprint = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== "2.16.840.1.101.3.4.2.1") return false; // SHA-256
if (imprint.length !== rootHash.length || !imprint.every((b, i) => b === rootHash[i])) return false;

// --- validate signature + cert chain to a trusted root ---
// Re-seat eContent as a PRIMITIVE OctetString (Gotcha #1) and re-tag eContentType
// to id-data so pkijs runs a GENERIC SignedData check, not its TSP-specific branch
// (which requires the imprint's preimage; an RFC 3161 verifier has only the hash -- Gotcha #2).
signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: tstDer });
signedData.encapContentInfo.eContentType = pkijs.id_ContentType_Data;
try {
  const result = await signedData.verify({ signer: 0, trustedCerts, checkChain: true, extendedMode: true });
  if (!result.signatureVerified) return false;
  // trusted chain -> result.certificatePath is non-empty; untrusted -> verify THROWS (Gotcha #3)
  return result.certificatePath && result.certificatePath.length > 0;
} catch {
  return false;                                                 // bad signature OR no trusted path
}
// tstInfo.genTime.value is a Date -- the trusted time. (genTime is a pkijs `Time`; read `.value`.)
```

For requesting a token from a real TSA (freeTSA), build `new pkijs.TimeStampReq({ version:1, messageImprint, certReq:true })`,
`POST` `req.toSchema().toBER(false)` as `application/timestamp-query`, then parse the reply with
`new pkijs.TimeStampResp({ schema })`; `tsr.status.status === 0` means granted and `tsr.timeStampToken`
is the ContentInfo to feed into the verify chain above.

## Gotchas

- **#1 -- eContent reparses as a CONSTRUCTED OCTET STRING.** After a CMS encode->decode roundtrip,
  the encapsulated TSTInfo (an OCTET STRING) comes back *constructed*: the parent
  `.valueBlock.valueHexView` is EMPTY and the real DER bytes live in `.valueBlock.value[0]`
  (chunked across children for large content). `asn1js.fromBER(eContent.valueBlock.valueHexView)`
  on the parent therefore yields nothing -> "wrong ASN.1 schema". Use the `extractEContentBytes()`
  concat-the-children helper above. This bites BOTH self-minted and freeTSA tokens.

- **#2 -- `SignedData.verify` takes a TSP-specific branch on the TSTInfo OID, and it needs the imprint
  PREIMAGE.** When `eContentType === id_eContentType_TSTInfo`, pkijs internally calls
  `TSTInfo.fromBER(eContent.valueBlock.valueHexView)` (empty parent view -> throws, see #1) and then
  `tstInfo.verify({ data })` where `data` is the ORIGINAL message that was hashed into the imprint.
  An RFC 3161 verifier holds only the imprint (the hash), not the preimage, so that contract does not
  fit. Workaround used here: do the imprint check manually, then before calling `verify()` re-seat
  `eContent` as a primitive OctetString and set `eContentType = pkijs.id_ContentType_Data` so pkijs
  runs a GENERIC SignedData signature+chain check over the exact same encapsulated bytes. (Equivalent
  to verifying the SignerInfo directly; this keeps it on the public API.)

- **#3 -- chain failures THROW, they don't return false.** With `checkChain:true` + `trustedCerts`,
  a signer cert that does not chain to a trusted root makes `verify()` THROW
  `SignedDataVerifyError` (code 5, "No valid certificate paths found"), it does NOT resolve with an
  empty path. A `signatureVerified:false` (bad signature) surfaces via the result in `extendedMode`
  but other failure modes throw. The real `verifyTimestamp` must "return boolean, never throw" ->
  wrap the whole verify in `try/catch` and return `false` in `catch` (as above). In `extendedMode`,
  a SUCCESSFUL trusted verify returns `result.certificatePath` with length > 0 (length 2 for the
  freeTSA leaf->CA chain); treat empty path as untrusted.

- **#4 -- `genTime` is a pkijs `Time`, not a `Date`.** Read `tstInfo.genTime.value` (a JS `Date`).
  `accuracy` (optional `pkijs.Accuracy`, seconds/millis/micros) and `nonce` are OPTIONAL TSTInfo
  fields -- freeTSA omits accuracy here. Don't assume they're present.

- **#5 -- TSA cert needs the critical `id-kp-timeStamping` EKU (`1.3.6.1.5.5.7.3.8`).** RFC 3161
  requires the TSA leaf to carry exactly this EKU. Set it via `pkijs.ExtKeyUsage` on extension OID
  `2.5.29.37`. (This spike does not *enforce* the EKU during verify -- a production verifier SHOULD
  also assert the signer cert carries it; it lives on the signer Certificate, not the TSTInfo.)

- **#6 -- DER vs BER.** Always emit with `.toBER(false)` (DER, definite-length). pkijs parses BER on
  input (hence #1), so never assume the parsed shape mirrors what you encoded.

- **#7 -- engine wiring is mandatory on Node.** Forgetting `pkijs.setEngine(...)` yields opaque
  crypto / null-subtle errors. Wire it once at module load (see top).
