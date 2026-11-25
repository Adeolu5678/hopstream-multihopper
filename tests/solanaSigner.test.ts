import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  DeterministicMockSigner,
  loadSolanaKeypair
} from "../src/orchestrator/signer.js";
import { encodeBase58 } from "../src/utils/base58.js";

describe("Solana VersionedTransaction & legacy Transaction signing", () => {
  it("preserves server pre-signed ephemeral signatures when adding sourceOwner signature to v0 tx", async () => {
    const sourceOwner = Keypair.generate();
    const ephemeralRouteKey = Keypair.generate();
    const recipient = Keypair.generate();
    const recentBlockhash = "11111111111111111111111111111111";

    const ix1 = SystemProgram.transfer({
      fromPubkey: sourceOwner.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 10_000
    });
    const ix2 = SystemProgram.transfer({
      fromPubkey: ephemeralRouteKey.publicKey,
      toPubkey: recipient.publicKey,
      lamports: 5_000
    });

    const msgV0 = new TransactionMessage({
      payerKey: sourceOwner.publicKey,
      recentBlockhash,
      instructions: [ix1, ix2]
    }).compileToV0Message();

    const serverPreSigned = new VersionedTransaction(msgV0);
    serverPreSigned.sign([ephemeralRouteKey]);
    const preSignedBase64 = Buffer.from(serverPreSigned.serialize()).toString("base64");

    const signer = new DeterministicMockSigner({ keypair: sourceOwner });
    const fullySignedBase64 = await signer.signVersionedTx(preSignedBase64);
    const decoded = VersionedTransaction.deserialize(
      Uint8Array.from(Buffer.from(fullySignedBase64, "base64"))
    );

    // Both signatures (payer sourceOwner at index 0 and ephemeralRouteKey at index 1) must be non-zero
    assert.equal(decoded.signatures.length, 2);
    const sig0NonZero = decoded.signatures[0]?.some((b) => b !== 0);
    const sig1NonZero = decoded.signatures[1]?.some((b) => b !== 0);
    assert.equal(sig0NonZero, true);
    assert.equal(sig1NonZero, true);
    // Ephemeral signature bytes must match server's original signature byte-for-byte
    assert.deepEqual(decoded.signatures[1], serverPreSigned.signatures[1]);
  });

  it("partially signs legacy orchestratorInitTx while preserving prior signatures", async () => {
    const sourceOwner = Keypair.generate();
    const coSigner = Keypair.generate();
    const recentBlockhash = "11111111111111111111111111111111";

    const legacyTx = new Transaction({
      feePayer: sourceOwner.publicKey,
      recentBlockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey: sourceOwner.publicKey,
        toPubkey: coSigner.publicKey,
        lamports: 1_000
      })
    );
    // Simulate co-signer instruction/signature
    legacyTx.add(
      SystemProgram.transfer({
        fromPubkey: coSigner.publicKey,
        toPubkey: sourceOwner.publicKey,
        lamports: 500
      })
    );
    legacyTx.partialSign(coSigner);
    const partialBase64 = Buffer.from(
      legacyTx.serialize({ requireAllSignatures: false })
    ).toString("base64");

    const signer = new DeterministicMockSigner({ keypair: sourceOwner });
    const signedBase64 = await signer.signLegacyTx(partialBase64);
    const decoded = Transaction.from(Buffer.from(signedBase64, "base64"));

    assert.equal(decoded.verifySignatures(), true);
  });

  it("loads keypair from both base58 and JSON byte array strings", () => {
    const kp = Keypair.generate();
    const asBase58 = encodeBase58(kp.secretKey);
    const asJson = JSON.stringify(Array.from(kp.secretKey));

    assert.equal(loadSolanaKeypair(asBase58).publicKey.toBase58(), kp.publicKey.toBase58());
    assert.equal(loadSolanaKeypair(asJson).publicKey.toBase58(), kp.publicKey.toBase58());
  });
});
