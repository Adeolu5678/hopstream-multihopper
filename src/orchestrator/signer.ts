import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import { decodeBase58, encodeBase58 } from "../utils/base58.js";

export interface SignerAdapter {
  readonly publicKey: string;
  signVersionedTx(base64Tx: string): Promise<string>;
  signLegacyTx(base64Tx: string): Promise<string>;
  broadcastAndConfirm(signedBase64Tx: string, label: string): Promise<string>;
}

/**
 * Loads a Solana Keypair from either a base58-encoded secret key or a JSON byte array string.
 */
export function loadSolanaKeypair(secretInput: string): Keypair {
  const trimmed = secretInput.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }
  return Keypair.fromSecretKey(decodeBase58(trimmed));
}

/**
 * Production Solana signer using @solana/web3.js.
 * Preserves server pre-signed ephemeral signatures on VersionedTransaction v0 bundles
 * and uses partialSign on legacy orchestratorInitTx transactions.
 */
export class SolanaWeb3Signer implements SignerAdapter {
  public readonly publicKey: string;
  private readonly keypair: Keypair;
  private readonly connection: Connection;
  private readonly commitment: "confirmed" | "finalized";

  constructor(params: {
    keypair: Keypair;
    rpcUrl: string;
    commitment?: "confirmed" | "finalized";
  }) {
    this.keypair = params.keypair;
    this.publicKey = params.keypair.publicKey.toBase58();
    this.commitment = params.commitment ?? "confirmed";
    this.connection = new Connection(params.rpcUrl, this.commitment);
  }

  public async signVersionedTx(base64Tx: string): Promise<string> {
    const bytes = Uint8Array.from(Buffer.from(base64Tx, "base64"));
    const tx = VersionedTransaction.deserialize(bytes);
    // VersionedTransaction.sign([keypair]) writes ONLY to the signer slot matching
    // keypair.publicKey in staticAccountKeys, preserving server pre-signed ephemeral keys.
    tx.sign([this.keypair]);
    return Buffer.from(tx.serialize()).toString("base64");
  }

  public async signLegacyTx(base64Tx: string): Promise<string> {
    const bytes = Uint8Array.from(Buffer.from(base64Tx, "base64"));
    const tx = Transaction.from(bytes);
    tx.partialSign(this.keypair);
    return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  }

  public async broadcastAndConfirm(signedBase64Tx: string, _label: string): Promise<string> {
    const raw = Buffer.from(signedBase64Tx, "base64");
    const signature = await this.connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: this.commitment
    });
    const confirmation = await this.connection.confirmTransaction(signature, this.commitment);
    if (confirmation.value.err) {
      throw new Error(`Solana transaction ${signature} failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  }
}

export interface RecordedBroadcast {
  label: string;
  signedBase64Tx: string;
  signature: string;
}

/**
 * Deterministic offline signer for unit/integration tests and dry runs.
 * Can optionally sign real serialized @solana/web3.js transactions when a Keypair is supplied.
 */
export class DeterministicMockSigner implements SignerAdapter {
  public readonly publicKey: string;
  public readonly broadcasts: RecordedBroadcast[] = [];
  private readonly keypair?: Keypair;
  private counter = 0;
  private readonly failOnceLabels: Set<string>;

  constructor(options?: {
    keypair?: Keypair;
    publicKey?: string;
    failOnceLabels?: string[];
  }) {
    this.keypair = options?.keypair;
    this.publicKey =
      options?.keypair?.publicKey.toBase58() ??
      options?.publicKey ??
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    this.failOnceLabels = new Set(options?.failOnceLabels ?? []);
  }

  public async signVersionedTx(base64Tx: string): Promise<string> {
    if (this.keypair) {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(base64Tx, "base64")));
      tx.sign([this.keypair]);
      return Buffer.from(tx.serialize()).toString("base64");
    }
    return `signed_v0:${base64Tx}`;
  }

  public async signLegacyTx(base64Tx: string): Promise<string> {
    if (this.keypair) {
      const tx = Transaction.from(Uint8Array.from(Buffer.from(base64Tx, "base64")));
      tx.partialSign(this.keypair);
      return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
    }
    return `signed_legacy:${base64Tx}`;
  }

  public async broadcastAndConfirm(signedBase64Tx: string, label: string): Promise<string> {
    if (this.failOnceLabels.has(label)) {
      this.failOnceLabels.delete(label);
      throw new Error(`Simulated transient RPC expiry on ${label}`);
    }
    this.counter++;
    const seed = new Uint8Array(64);
    const labelBytes = Buffer.from(`${this.counter}:${label}`, "utf8");
    for (let i = 0; i < seed.length; i++) {
      seed[i] = ((labelBytes[i % labelBytes.length] ?? 1) + this.counter + i) & 0xff;
    }
    const signature = encodeBase58(seed);
    this.broadcasts.push({ label, signedBase64Tx, signature });
    return signature;
  }
}
