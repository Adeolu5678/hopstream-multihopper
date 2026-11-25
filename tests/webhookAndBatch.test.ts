import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatRawToTokens,
  parseTokenAmountToRaw,
  planPayrollTranches
} from "../src/scheduler/batchRunner.js";
import { COMMON_SOLANA_MINTS } from "../src/types/multihopper.js";
import { MAX_WEBHOOK_BODY_BYTES, startWebhookServer } from "../src/webhook/server.js";
import {
  MULTIHOPPER_SIGNATURE_HEADER,
  computeWebhookSignature,
  verifyWebhookSignature
} from "../src/webhook/verify.js";

describe("Webhook HMAC-SHA256 verification & server", () => {
  it("verifies valid signatures and rejects tampered payloads or invalid formats", () => {
    const secret = "whsec_unit_test_secret";
    const payload = JSON.stringify({ event: "transfer.completed", data: { id: 42 } });
    const sig = computeWebhookSignature(payload, secret);

    assert.equal(verifyWebhookSignature(payload, sig, secret), true);
    assert.equal(verifyWebhookSignature(payload, sig.toUpperCase(), secret), true);
    assert.equal(verifyWebhookSignature(`${payload} `, sig, secret), false);
    assert.equal(verifyWebhookSignature(payload, sig, "wrong_secret"), false);
    assert.equal(verifyWebhookSignature(payload, "not-hex", secret), false);
    assert.equal(verifyWebhookSignature(payload, undefined, secret), false);
  });

  it("serves /webhooks/multihopper over localhost, accepting valid HMAC and rejecting invalid HMAC", async () => {
    const secret = "whsec_local_server_test";
    const receivedEvents: string[] = [];
    const handle = await startWebhookServer({
      secret,
      port: 0,
      host: "127.0.0.1",
      onEvent: (ev) => {
        receivedEvents.push(ev.event);
      }
    });

    try {
      const body = JSON.stringify({
        id: "evt_1",
        event: "transfer.hop_complete",
        data: { transferId: 77, hopIndex: 2 }
      });
      const validSig = computeWebhookSignature(body, secret);

      const okRes = await fetch(`${handle.url}/webhooks/multihopper`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [MULTIHOPPER_SIGNATURE_HEADER]: validSig
        },
        body
      });
      assert.equal(okRes.status, 200);

      const badRes = await fetch(`${handle.url}/webhooks/multihopper`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [MULTIHOPPER_SIGNATURE_HEADER]: "0".repeat(64)
        },
        body
      });
      assert.equal(badRes.status, 401);

      const oversizedBody = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
      const tooLargeRes = await fetch(`${handle.url}/webhooks/multihopper`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [MULTIHOPPER_SIGNATURE_HEADER]: computeWebhookSignature(oversizedBody, secret)
        },
        body: oversizedBody
      });
      assert.equal(tooLargeRes.status, 413);

      const eventsRes = await fetch(`${handle.url}/events`);
      assert.equal(eventsRes.status, 200);
      const json = (await eventsRes.json()) as { items: Array<{ payload: { event: string } }> };
      assert.equal(json.items.length, 1);
      assert.equal(json.items[0]?.payload.event, "transfer.hop_complete");
      assert.deepEqual(receivedEvents, ["transfer.hop_complete"]);
    } finally {
      await handle.close();
    }
  });
});

describe("Payroll batch tranche planner", () => {
  it("parses and formats token amounts cleanly without floating-point drift", () => {
    assert.equal(parseTokenAmountToRaw("125.50", 6), "125500000");
    assert.equal(parseTokenAmountToRaw("1.000000001", 9), "1000000001");
    assert.equal(formatRawToTokens("125500000", 6), "125.5");
    assert.equal(formatRawToTokens("1000000000", 9), "1");
  });

  it("chunks 21 recipients into a 20-destination tranche and a 1-recipientWallet tranche", () => {
    const recipients = Array.from({ length: 21 }, (_, idx) => ({
      wallet: `Wallet${idx.toString().padStart(2, "0")}111111111111111111111111111111111`,
      amountTokens: "10.25"
    }));

    const tranches = planPayrollTranches({
      environment: "mainnet",
      tokenMint: COMMON_SOLANA_MINTS.USDC.mint,
      tokenDecimals: 6,
      tokenSymbol: "USDC",
      sourceOwner: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      recipients,
      hops: 5,
      arrivalSeconds: 600,
      externalIdPrefix: "payroll-nov"
    });

    assert.equal(tranches.length, 2);
    assert.equal(tranches[0]?.request.destinations?.length, 20);
    assert.equal(tranches[0]?.request.recipientWallet, undefined);
    assert.equal(tranches[0]?.request.amountRaw, "205000000");
    // Mainnet TRM screening: 1 source + 5 hops + 20 destinations = 26 wallets * 0.002 SOL
    assert.equal(tranches[0]?.screenedWalletCount, 26);
    assert.equal(tranches[0]?.estimatedScreeningFeeLamports, 52_000_000);

    // Second tranche has 1 recipient, so it uses recipientWallet instead of destinations
    assert.equal(tranches[1]?.request.destinations, undefined);
    assert.equal(
      tranches[1]?.request.recipientWallet,
      "Wallet20111111111111111111111111111111111"
    );
    assert.equal(tranches[1]?.request.amountRaw, "10250000");
  });
});
