// RFC 3161 trusted-timestamp roundtrip spike.
//
// Proves the candidate lib (pkijs + asn1js + pvutils) can, OFFLINE:
//   (a) build a self-signed CA + a TSA leaf cert (issued by the CA),
//   (b) accept a messageImprint (SHA-256 of an arbitrary 32-byte root),
//   (c) issue an RFC 3161 TimeStampToken (CMS SignedData wrapping a TSTInfo),
//   (d) verify the token: parse it, confirm messageImprint == root hash,
//       and validate the signer cert chains to the trusted CA.
//
// Prints `OK <tsa-time>` or throws. This is a prototype of the two real seams:
//   LocalCaTimestampAuthority.mint(messageImprint) -> token (steps a..c)
//   verifyTimestamp(rootHash, token, trustedCerts) -> boolean (step d)

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { webcrypto } from "node:crypto";

// ---------------------------------------------------------------------------
// 0. Wire the WebCrypto engine. pkijs has no native bindings; it drives the
//    platform SubtleCrypto. On Node 20+, node:crypto.webcrypto provides it.
// ---------------------------------------------------------------------------
const crypto = webcrypto;
pkijs.setEngine(
  "node",
  new pkijs.CryptoEngine({ name: "node", crypto, subtle: crypto.subtle }),
);

const SIG_ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const KEYGEN_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const id_eContentType_TSTInfo = pkijs.id_eContentType_TSTInfo; // 1.2.840.113549.1.9.16.1.4
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA_SHA256 = "1.2.840.113549.1.1.11";
const OID_TSA_EKU = "1.3.6.1.5.5.7.3.8"; // id-kp-timeStamping
const OID_EKU_EXT = "2.5.29.37";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";

function setRDN(typeAndValues, cn) {
  typeAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: "2.5.4.3", // commonName
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
}

// Build a certificate, sign it with `issuerKey` (self-signed if issuerKey is the
// subject's own private key and issuerName === subjectName).
async function makeCertificate({ subjectCN, issuerCN, subjectPubKey, issuerPrivKey, serial, isCa, isTsa }) {
  const cert = new pkijs.Certificate();
  cert.version = 2; // v3
  cert.serialNumber = new asn1js.Integer({ value: serial });
  setRDN(cert.issuer.typesAndValues, issuerCN);
  setRDN(cert.subject.typesAndValues, subjectCN);

  const now = new Date();
  cert.notBefore.value = new Date(now.getTime() - 60_000);
  cert.notAfter.value = new Date(now.getTime() + 365 * 24 * 3600 * 1000);

  cert.subjectPublicKeyInfo.importKey
    ? await cert.subjectPublicKeyInfo.importKey(subjectPubKey)
    : await cert.subjectPublicKeyInfo.importKey(subjectPubKey);

  cert.extensions = [];
  if (isCa) {
    const bc = new pkijs.BasicConstraints({ cA: true });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: OID_BASIC_CONSTRAINTS,
        critical: true,
        extnValue: bc.toSchema().toBER(false),
        parsedValue: bc,
      }),
    );
  }
  if (isTsa) {
    const eku = new pkijs.ExtKeyUsage({ keyPurposes: [OID_TSA_EKU] });
    cert.extensions.push(
      new pkijs.Extension({
        extnID: OID_EKU_EXT,
        critical: true,
        extnValue: eku.toSchema().toBER(false),
        parsedValue: eku,
      }),
    );
  }

  await cert.sign(issuerPrivKey, "SHA-256");
  return cert;
}

// ---------------------------------------------------------------------------
// LocalCaTimestampAuthority prototype: mint a TimeStampToken over messageImprint.
// Returns the DER bytes of a CMS ContentInfo(SignedData) — the RFC 3161 token.
// ---------------------------------------------------------------------------
async function mintTimestampToken(messageImprint /* Uint8Array, SHA-256 digest */) {
  // (a) CA keypair + self-signed CA cert.
  const caKeys = await crypto.subtle.generateKey(KEYGEN_ALG, true, ["sign", "verify"]);
  const caCert = await makeCertificate({
    subjectCN: "Spike RFC3161 Test CA",
    issuerCN: "Spike RFC3161 Test CA",
    subjectPubKey: caKeys.publicKey,
    issuerPrivKey: caKeys.privateKey,
    serial: 1,
    isCa: true,
  });

  // TSA leaf keypair + cert issued (signed) by the CA.
  const tsaKeys = await crypto.subtle.generateKey(KEYGEN_ALG, true, ["sign", "verify"]);
  const tsaCert = await makeCertificate({
    subjectCN: "Spike RFC3161 Test TSA",
    issuerCN: "Spike RFC3161 Test CA",
    subjectPubKey: tsaKeys.publicKey,
    issuerPrivKey: caKeys.privateKey, // signed BY the CA
    serial: 2,
    isTsa: true,
  });

  // (c) Build TSTInfo (the signed payload of an RFC 3161 token).
  const genTime = new Date();
  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: "1.2.3.4.1", // arbitrary TSA policy OID
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: messageImprint }),
    }),
    serialNumber: new asn1js.Integer({ value: Date.now() }),
    genTime,
  });
  const tstInfoDer = tstInfo.toSchema().toBER(false);

  // Wrap TSTInfo as the eContent of a CMS SignedData.
  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: id_eContentType_TSTInfo,
      eContent: new asn1js.OctetString({ valueHex: tstInfoDer }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: tsaCert.issuer,
          serialNumber: tsaCert.serialNumber,
        }),
      }),
    ],
    certificates: [tsaCert, caCert], // embed the chain so the verifier can build it
  });

  // sign(privateKey, signerIndex, hashAlgorithm) — produces the digest of eContent.
  await signedData.sign(tsaKeys.privateKey, 0, "SHA-256");

  // Wrap SignedData in a ContentInfo (the outer CMS structure of the token).
  const cmsContentInfo = new pkijs.ContentInfo({
    contentType: pkijs.id_ContentType_SignedData,
    content: signedData.toSchema(true),
  });
  const tokenDer = cmsContentInfo.toSchema().toBER(false);

  return { tokenDer: new Uint8Array(tokenDer), caCert, genTime };
}

// GOTCHA: after a CMS encode/decode roundtrip, eContent (a DER-encoded TSTInfo
// wrapped in an OCTET STRING) often comes back as a *constructed* OCTET STRING
// (BER), with the real bytes split across child primitive OCTET STRINGs in
// `.valueBlock.value[]`, and the parent `.valueHexView` empty. Concatenate the
// children for the constructed case; use the flat view for the primitive case.
function extractEContentBytes(octetString) {
  const vb = octetString.valueBlock;
  if (vb.isConstructed && Array.isArray(vb.value) && vb.value.length) {
    const parts = vb.value.map((child) => new Uint8Array(child.valueBlock.valueHexView));
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
  return new Uint8Array(vb.valueHexView);
}

// ---------------------------------------------------------------------------
// verifyTimestamp prototype: parse the token, check messageImprint == root hash,
// validate the signer chains to a trusted cert. Returns { ok, genTime }.
// ---------------------------------------------------------------------------
async function verifyTimestampToken(rootHash /* Uint8Array */, tokenDer /* Uint8Array */, trustedCerts /* Certificate[] */) {
  // Parse the outer CMS ContentInfo -> SignedData.
  const asn1 = asn1js.fromBER(tokenDer);
  if (asn1.offset === -1) throw new Error("token is not valid DER");
  const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
  if (contentInfo.contentType !== pkijs.id_ContentType_SignedData) {
    throw new Error(`unexpected CMS contentType ${contentInfo.contentType}`);
  }
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });

  // Confirm the encapsulated content is a TSTInfo, parse it.
  if (signedData.encapContentInfo.eContentType !== id_eContentType_TSTInfo) {
    throw new Error(`unexpected eContentType ${signedData.encapContentInfo.eContentType}`);
  }
  const tstDer = extractEContentBytes(signedData.encapContentInfo.eContent);
  const tstAsn1 = asn1js.fromBER(tstDer);
  if (tstAsn1.offset === -1) throw new Error("TSTInfo is not valid DER");
  const tstInfo = new pkijs.TSTInfo({ schema: tstAsn1.result });

  // GOTCHA: SignedData.verify takes a TSP-aware branch when eContentType is the
  // TSTInfo OID, and inside it calls TSTInfo.fromBER(eContent.valueBlock.valueHexView).
  // Our reparsed eContent is a *constructed* OCTET STRING (empty parent view), so
  // that internal call throws "TSTInfo wrong ASN.1 schema". Re-seat eContent as a
  // single *primitive* OCTET STRING holding the concatenated DER so the parent
  // .valueHexView is populated and pkijs's internal TSTInfo.fromBER succeeds.
  signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: tstDer });

  // (verify) messageImprint.hashedMessage == SHA-256 of the root.
  const imprint = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (imprint.length !== rootHash.length || !imprint.every((b, i) => b === rootHash[i])) {
    throw new Error("messageImprint does not match root hash");
  }
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
    throw new Error(`unexpected imprint hashAlgorithm ${tstInfo.messageImprint.hashAlgorithm.algorithmId}`);
  }

  // (verify) the CMS signature over the eContent, WITH chain validation to a
  // trusted CA. SignedData.verify checks the signature over the encapsulated
  // TSTInfo bytes AND, with checkChain + trustedCerts, validates that the signer
  // cert chains to a trusted root.
  //
  // GOTCHA: when eContentType is the TSTInfo OID, pkijs's verify takes a TSP
  // branch that REQUIRES a `data:` (the imprint's preimage) and re-hashes it to
  // re-derive the imprint. An RFC 3161 verifier holds only the imprint (the
  // hash), not the preimage, so that branch is the wrong contract for us — we
  // already checked imprint == rootHash above. Re-seat eContentType to id-data
  // so verify performs a *generic* CMS SignedData signature+chain check over the
  // exact same encapsulated bytes. (Equivalent to extracting SignerInfo and
  // verifying it directly; this keeps the call on the public API.)
  signedData.encapContentInfo.eContentType = pkijs.id_ContentType_Data;
  const result = await signedData.verify({
    signer: 0,
    trustedCerts,
    checkChain: true,
    extendedMode: true,
  });
  if (!result.signatureVerified) {
    throw new Error("CMS signature verification failed");
  }
  if (result.certificatePath && result.certificatePath.length === 0) {
    // extendedMode reports an empty path when the chain did not reach a trusted root.
    throw new Error("signer certificate did not chain to a trusted cert");
  }

  return { ok: true, genTime: tstInfo.genTime.value ?? tstInfo.genTime };
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
async function main() {
  // (b) arbitrary 32-byte "root", then its SHA-256 messageImprint.
  const root = crypto.getRandomValues(new Uint8Array(32));
  const rootHash = new Uint8Array(await crypto.subtle.digest("SHA-256", root));

  const { tokenDer, caCert, genTime } = await mintTimestampToken(rootHash);

  const { ok, genTime: verifiedTime } = await verifyTimestampToken(rootHash, tokenDer, [caCert]);
  if (!ok) throw new Error("verification returned not-ok");

  // Negative control: a tampered root must fail.
  const wrongHash = new Uint8Array(rootHash);
  wrongHash[0] ^= 0xff;
  let tamperRejected = false;
  try {
    await verifyTimestampToken(wrongHash, tokenDer, [caCert]);
  } catch {
    tamperRejected = true;
  }
  if (!tamperRejected) throw new Error("tampered root was NOT rejected — verifier is unsound");

  // Negative control: an untrusted CA must fail chain validation.
  const otherKeys = await crypto.subtle.generateKey(KEYGEN_ALG, true, ["sign", "verify"]);
  const strangerCa = await makeCertificate({
    subjectCN: "Unrelated CA",
    issuerCN: "Unrelated CA",
    subjectPubKey: otherKeys.publicKey,
    issuerPrivKey: otherKeys.privateKey,
    serial: 99,
    isCa: true,
  });
  let untrustedRejected = false;
  try {
    await verifyTimestampToken(rootHash, tokenDer, [strangerCa]);
  } catch {
    untrustedRejected = true;
  }
  if (!untrustedRejected) throw new Error("untrusted CA was accepted — chain validation is unsound");

  const iso = (verifiedTime instanceof Date ? verifiedTime : genTime).toISOString();
  console.log(`OK ${iso}`);

  // Step 4 (OPTIONAL, network): request a real token from freeTSA and verify it
  // against freeTSA's published CA. Proves the lib parses third-party real-world
  // tokens, not just self-minted ones. Enable with SPIKE_NETWORK=1.
  if (process.env.SPIKE_NETWORK === "1") {
    await freeTsaRoundtrip();
  }
}

// Optional real-world proof against https://freetsa.org/tsr.
async function freeTsaRoundtrip() {
  const msg = new TextEncoder().encode(`pangolin-scale rfc3161 spike ${Date.now()}`);
  const imprint = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));

  // Build + POST an RFC 3161 TimeStampReq.
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256, algorithmParams: new asn1js.Null() }),
      hashedMessage: new asn1js.OctetString({ valueHex: imprint }),
    }),
    certReq: true, // ask the TSA to embed its cert chain in the token
  });
  const resp = await fetch("https://freetsa.org/tsr", {
    method: "POST",
    headers: { "Content-Type": "application/timestamp-query" },
    body: Buffer.from(req.toSchema().toBER(false)),
  });
  const tsrBytes = new Uint8Array(await resp.arrayBuffer());

  // Parse TimeStampResp -> token (ContentInfo/SignedData).
  const tsr = new pkijs.TimeStampResp({ schema: asn1js.fromBER(tsrBytes).result });
  if (tsr.status.status !== 0) throw new Error(`freeTSA PKIStatus ${tsr.status.status} (not granted)`);
  const tokenDer = new Uint8Array(tsr.timeStampToken.toSchema().toBER(false));

  // Fetch freeTSA's published CA and verify the token against it.
  const caPem = await (await fetch("https://freetsa.org/files/cacert.pem")).text();
  const caDer = Buffer.from(caPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  const caCert = new pkijs.Certificate({ schema: asn1js.fromBER(new Uint8Array(caDer)).result });

  const { genTime } = await verifyTimestampToken(imprint, tokenDer, [caCert]);
  const iso = (genTime instanceof Date ? genTime : new Date(genTime)).toISOString();
  console.log(`OK (freeTSA) ${iso}`);
}

main().catch((err) => {
  console.error("SPIKE FAILED:", err);
  process.exit(1);
});
