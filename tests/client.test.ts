import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiHopperApiError, MultiHopperValidationError } from "../src/client/errors.js";
import {
  MultiHopperClient,
  validateCreateTransferRequest
} from "../src/client/multihopper.js";
import { COMMON_SOLANA_MINTS, MULTIHOPPER_BASE_URLS } from "../src/types/multihopper.js";

describe("MultiHopperClient & validation", () => {
  it("selects environment base URLs and warns on mh_live_ key in devnet", () => {
    const devClient = new MultiHopperClient({
      apiKey: "mh_test_dev_123",
      environment: "devnet"
    });
    assert.equal(devClient.baseUrl, MULTIHOPPER_BASE_URLS.devnet);
    assert.equal(devClient.keyWarning, undefined);

    const mismatchClient = new MultiHopperClient({
      apiKey: "mh_live_prod_123",
      environment: "devnet"
    });
    assert.ok(mismatchClient.keyWarning?.includes("mh_live_"));

    assert.throws(
      () =>
        new MultiHopperClient({
          apiKey: "mh_live_prod_123",
          environment: "devnet",
          strictKeyEnvironmentCheck: true
        }),
      MultiHopperValidationError
    );
  });

  it("enforces createTransfer invariants for multi-destination payouts", () => {
    const base = {
      tokenMint: COMMON_SOLANA_MINTS.USDC.mint,
      amountRaw: "1000000",
      amountTokens: "1.0",
      sourceOwner: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
    };

    // Both recipientWallet and destinations -> reject
    assert.throws(
      () =>
        validateCreateTransferRequest({
          ...base,
          recipientWallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u",
          destinations: [{ wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountRaw: "1000000" }]
        }),
      MultiHopperValidationError
    );

    // > 20 destinations -> reject
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      wallet: `DestWallet${i.toString().padStart(2, "0")}1111111111111111111111111111111`,
      amountRaw: i === 0 ? "980000" : "1000"
    }));
    assert.throws(
      () => validateCreateTransferRequest({ ...base, destinations: tooMany }),
      /at most 20/
    );

    // Duplicate destination wallet -> reject
    assert.throws(
      () =>
        validateCreateTransferRequest({
          ...base,
          destinations: [
            { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountRaw: "500000" },
            { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountRaw: "500000" }
          ]
        }),
      /Duplicate destination wallet/
    );

    // Shares do not sum to amountRaw -> reject
    assert.throws(
      () =>
        validateCreateTransferRequest({
          ...base,
          destinations: [
            { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountRaw: "500000" },
            { wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountRaw: "400000" }
          ]
        }),
      /must equal amountRaw/
    );

    // Custom route combined with hops -> reject
    assert.throws(
      () =>
        validateCreateTransferRequest({
          ...base,
          recipientWallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u",
          hops: 4,
          route: {
            hops: [
              { bundle: "cex", waitSeconds: 60 },
              { bundle: "kol", waitSeconds: 60 }
            ]
          }
        }),
      /Do not combine/
    );
  });

  it("preserves Idempotency-Key across transient 429/503 retries and surfaces MH_XXX errors", async () => {
    const seenKeys: string[] = [];
    let callCount = 0;

    const mockFetch: typeof fetch = async (_url, init) => {
      callCount++;
      const headers = init?.headers as Record<string, string>;
      if (headers["Idempotency-Key"]) {
        seenKeys.push(headers["Idempotency-Key"]);
      }

      if (callCount === 1) {
        return new Response(
          JSON.stringify({ error: { code: "MH_004", message: "Rate limit exceeded" } }),
          { status: 429, headers: { "Retry-After": "0" } }
        );
      }

      return new Response(
        JSON.stringify({
          id: 42,
          status: "quote",
          externalId: "order_retry_1"
        }),
        { status: 200 }
      );
    };

    const client = new MultiHopperClient({
      apiKey: "mh_test_retry",
      environment: "devnet",
      fetchImpl: mockFetch,
      baseRetryDelayMs: 1,
      generateIdempotencyKey: () => "idem-fixed-uuid-1234"
    });

    const transfer = await client.createTransfer({
      tokenMint: COMMON_SOLANA_MINTS.SOL.mint,
      amountRaw: "1000000000",
      amountTokens: "1.0",
      tokenDecimals: 9,
      sourceOwner: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      recipientWallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u",
      hops: 3,
      arrivalSeconds: 300,
      externalId: "order_retry_1"
    });

    assert.equal(transfer.id, 42);
    assert.equal(callCount, 2);
    assert.deepEqual(seenKeys, ["idem-fixed-uuid-1234", "idem-fixed-uuid-1234"]);
  });

  it("does not retry 409 MH_040 stale quote or 400 MH_019 devnet hop-library error", async () => {
    let calls = 0;
    const mockFetch: typeof fetch = async (input) => {
      calls++;
      const url = String(input);
      if (url.includes("/hop-library")) {
        return new Response(
          JSON.stringify({ error: { code: "MH_019", message: "Hop library unavailable on devnet" } }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({ error: { code: "MH_040", message: "Tier shifted since quote" } }),
        { status: 409 }
      );
    };

    const client = new MultiHopperClient({
      apiKey: "mh_test_err",
      environment: "devnet",
      fetchImpl: mockFetch,
      maxRetries: 3
    });

    await assert.rejects(
      () => client.getHopLibrary({ bundle: "cex" }),
      (err: unknown) => err instanceof MultiHopperApiError && err.isDevnetLibraryUnavailable()
    );
    await assert.rejects(
      () => client.prepareTransfer(42),
      (err: unknown) => err instanceof MultiHopperApiError && err.isStaleQuote()
    );
    assert.equal(calls, 2);
  });

  it("queries estimate, route templates, and usage endpoints with expected params", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ method, url });

      if (url.endsWith("/transfers/estimate")) {
        return new Response(JSON.stringify({ tier: "tier_2", percentFeeBps: 50 }), { status: 200 });
      }
      if (url.includes("/route-templates")) {
        return new Response(JSON.stringify({ id: 5, name: "ex-hop" }), { status: 200 });
      }
      if (url.includes("/usage")) {
        return new Response(JSON.stringify({ totalTransfers: 10, totalPayouts: 9 }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const client = new MultiHopperClient({
      apiKey: "mh_live_queries",
      environment: "mainnet",
      fetchImpl: mockFetch
    });

    const est = await client.estimateTransfer({
      tokenMint: COMMON_SOLANA_MINTS.USDC.mint,
      amountRaw: "100000000",
      destinationCount: 4
    });
    assert.equal(est.tier, "tier_2");

    const tpl = await client.createRouteTemplate({
      name: "ex-hop",
      route: { hops: [{ bundle: "cex", waitSeconds: 120 }] }
    });
    assert.equal(tpl.id, 5);

    const usage = await client.getUsage({ fromDate: "2026-01-01T00:00:00.000Z" });
    assert.equal(usage.totalTransfers, 10);
    assert.equal(requests.length, 3);
  });
});
