import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MultiHopperApiError } from "../src/client/errors.js";
import { MultiHopperClient } from "../src/client/multihopper.js";
import { DeterministicMockSigner } from "../src/orchestrator/signer.js";
import { TransferOrchestrator } from "../src/orchestrator/stateMachine.js";
import { COMMON_SOLANA_MINTS } from "../src/types/multihopper.js";

describe("TransferOrchestrator state machine", () => {
  it("broadcasts and confirms keeperFundingTx FIRST before route/orchestrator/session/dispersion txs", async () => {
    const confirmCalls: Array<Record<string, unknown>> = [];
    const signer = new DeterministicMockSigner();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.endsWith("/transfers/estimate")) {
        return new Response(
          JSON.stringify({
            tier: "tier_2",
            tierIndex: 2,
            percentFeeBps: 50,
            percentFeeRaw: "497512",
            flatFeeLamportsPerHop: 375000,
            flatFeeLamportsPerRoute: 0,
            totalFlatFeeLamports: 1125000,
            integratorPercentShare: "248756",
            integratorFlatShare: 0,
            hopAmountRaw: "99502488",
            usdEquivalent: 100,
            usdValueMicros: "99502488",
            priceSource: "onchain_pool",
            cappedAtTierBoundary: false,
            isTestMode: true,
            tokens: { amountRaw: "100000000", feeRaw: "497512", netDeliveredRaw: "99502488", decimals: 6 },
            sol: {
              requiredSolUpFrontLamports: 35000000,
              minTransferAmountLamports: 2039280,
              breakdown: {
                routeInitRentLamports: 15000000,
                orchestratorRentLamports: 10000000,
                ataRentLamports: 2400000,
                transactionFeesLamports: 45000,
                priorityFeesLamports: 0,
                protocolFlatFeeLamports: 1125000,
                screeningFeeLamports: 0,
                dispersionRentLamports: 4000000
              },
              refundableLamports: 16000000,
              netCostLamports: 19000000
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/transfers")) {
        return new Response(
          JSON.stringify({ id: 77, status: "quote", destinationCount: 2 }),
          { status: 200 }
        );
      }

      if (url.endsWith("/transfers/77/prepare")) {
        return new Response(
          JSON.stringify({
            transfer: { id: 77, status: "awaiting_signature" },
            preparedTxs: {
              keeperFundingTx: "KEEPER_TX",
              routeInitTxs: [{ base64: "ROUTE_TX_0" }, { base64: "ROUTE_TX_1" }],
              orchestratorInitTx: "ORCH_TX",
              sessionInitTxs: ["SESSION_TX_0"],
              dispersionInitTxs: ["DISPERSION_TX_0", "DISPERSION_TX_1"],
              recentBlockhash: "5eykt4",
              lastValidBlockHeight: 123456,
              resume: {
                routeAlreadyDeployed: false,
                existingHopCount: 0,
                totalHops: 3,
                orchestratorAlreadyInitialized: false,
                completedStepIndices: [],
                totalSteps: 3,
                keeperAlreadyFunded: false,
                dispersion: {
                  totalDestinations: 2,
                  orchestratorInitialized: false,
                  stepsInitialized: 0,
                  routeExitBound: false
                },
                nothingToDo: false
              }
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/transfers/77/confirm-broadcast")) {
        confirmCalls.push(body);
        return new Response(
          JSON.stringify({
            transfer: {
              id: 77,
              status: confirmCalls.length === 1 ? "awaiting_signature" : "processing"
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/transfers/77")) {
        return new Response(
          JSON.stringify({
            id: 77,
            status: "completed",
            phase: "settled",
            progress: { hopsCompleted: 3, hopsTotal: 3 }
          }),
          { status: 200 }
        );
      }

      return new Response("{}", { status: 404 });
    };

    const client = new MultiHopperClient({
      apiKey: "mh_test_orch",
      environment: "devnet",
      fetchImpl: mockFetch
    });

    const orchestrator = new TransferOrchestrator({
      client,
      signer,
      propagationDelayMs: 0,
      pollIntervalMs: 0
    });

    const result = await orchestrator.execute({
      createRequest: {
        tokenMint: COMMON_SOLANA_MINTS.USDC_DEVNET.mint,
        amountRaw: "100000000",
        amountTokens: "100",
        tokenDecimals: 6,
        sourceOwner: signer.publicKey,
        hops: 3,
        arrivalSeconds: 300,
        destinations: [
          { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountRaw: "60000000" },
          { wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountRaw: "40000000" }
        ]
      },
      runPreflightEstimate: true,
      pollUntilTerminal: true
    });

    assert.equal(result.state, "settled");
    assert.equal(result.prepareAttempts, 1);

    // Strict broadcast order check
    assert.deepEqual(
      signer.broadcasts.map((b) => b.label),
      [
        "keeperFundingTx",
        "routeInitTxs[0]",
        "routeInitTxs[1]",
        "orchestratorInitTx",
        "sessionInitTxs[0]",
        "dispersionInitTxs[0]",
        "dispersionInitTxs[1]"
      ]
    );

    // confirm-broadcast MUST be called twice: first with keeperFundingSignature + empty routeInitSignatures
    assert.equal(confirmCalls.length, 2);
    assert.deepEqual(confirmCalls[0]?.routeInitSignatures, []);
    assert.ok(typeof confirmCalls[0]?.keeperFundingSignature === "string");
    assert.equal((confirmCalls[1]?.routeInitSignatures as string[]).length, 2);
    assert.equal((confirmCalls[1]?.dispersionInitSignatures as string[]).length, 2);
  });

  it("resumes cleanly after mid-bundle blockhash expiry and MH_041 without double-funding keeper", async () => {
    let prepareCall = 0;
    let confirmCall = 0;
    const signer = new DeterministicMockSigner({
      failOnceLabels: ["sessionInitTxs[0]"]
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith("/transfers")) {
        return new Response(JSON.stringify({ id: 88, status: "quote" }), { status: 200 });
      }

      if (url.endsWith("/transfers/88/prepare")) {
        prepareCall++;
        if (prepareCall === 1) {
          return new Response(
            JSON.stringify({
              transfer: { id: 88, status: "awaiting_signature" },
              preparedTxs: {
                keeperFundingTx: "KEEPER_TX",
                routeInitTxs: [{ base64: "ROUTE_TX_0" }],
                orchestratorInitTx: "ORCH_TX",
                sessionInitTxs: ["SESSION_TX_0"],
                dispersionInitTxs: ["DISP_TX_0"],
                recentBlockhash: "bh1",
                lastValidBlockHeight: 100
              }
            }),
            { status: 200 }
          );
        }
        // On second /prepare, keeper + route + orchestrator are null (already landed!)
        return new Response(
          JSON.stringify({
            transfer: { id: 88, status: "awaiting_signature" },
            preparedTxs: {
              keeperFundingTx: null,
              routeInitTxs: null,
              orchestratorInitTx: null,
              sessionInitTxs: prepareCall === 2 ? ["SESSION_TX_0"] : null,
              dispersionInitTxs: ["DISP_TX_0"],
              recentBlockhash: "bh2",
              lastValidBlockHeight: 150
            }
          }),
          { status: 200 }
        );
      }

      if (url.endsWith("/transfers/88/confirm-broadcast")) {
        confirmCall++;
        // Call 1: intermediate keeper funding confirm -> 200
        if (confirmCall === 1) {
          return new Response(JSON.stringify({ transfer: { id: 88, status: "awaiting_signature" } }), { status: 200 });
        }
        // Call 2: simulate MH_041 requiring dispersion re-broadcast
        if (confirmCall === 2) {
          return new Response(
            JSON.stringify({
              error: { code: "MH_041", message: "Destinations not yet bound on chain" }
            }),
            { status: 409 }
          );
        }
        return new Response(JSON.stringify({ transfer: { id: 88, status: "processing" } }), { status: 200 });
      }

      return new Response("{}", { status: 404 });
    };

    const client = new MultiHopperClient({
      apiKey: "mh_test_resume",
      environment: "devnet",
      fetchImpl: mockFetch
    });

    const orchestrator = new TransferOrchestrator({
      client,
      signer,
      propagationDelayMs: 0,
      pollIntervalMs: 0,
      maxPrepareAttempts: 4
    });

    const result = await orchestrator.execute({
      createRequest: {
        tokenMint: COMMON_SOLANA_MINTS.SOL.mint,
        amountRaw: "1000000000",
        amountTokens: "1.0",
        tokenDecimals: 9,
        sourceOwner: signer.publicKey,
        destinations: [
          { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountRaw: "500000000" },
          { wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountRaw: "500000000" }
        ],
        hops: 3,
        arrivalSeconds: 300
      },
      runPreflightEstimate: false,
      pollUntilTerminal: false
    });

    assert.equal(result.prepareAttempts, 3);
    assert.equal(result.transfer.status, "processing");
    // keeperFundingTx was broadcast EXACTLY ONCE across 3 prepare attempts
    const keeperBroadcasts = signer.broadcasts.filter((b) => b.label === "keeperFundingTx");
    assert.equal(keeperBroadcasts.length, 1);
  });

  it("aborts immediately on MH_040 stale quote", async () => {
    const signer = new DeterministicMockSigner();
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/transfers")) {
        return new Response(JSON.stringify({ id: 99, status: "quote" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { code: "MH_040", message: "Quote stale" } }),
        { status: 409 }
      );
    };

    const client = new MultiHopperClient({
      apiKey: "mh_test_stale",
      environment: "devnet",
      fetchImpl: mockFetch
    });

    const orchestrator = new TransferOrchestrator({
      client,
      signer,
      propagationDelayMs: 0
    });

    await assert.rejects(
      () =>
        orchestrator.execute({
          createRequest: {
            tokenMint: COMMON_SOLANA_MINTS.SOL.mint,
            amountRaw: "1000000000",
            amountTokens: "1.0",
            tokenDecimals: 9,
            sourceOwner: signer.publicKey,
            recipientWallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u",
            hops: 3,
            arrivalSeconds: 300
          },
          runPreflightEstimate: false
        }),
      (err: unknown) => err instanceof MultiHopperApiError && err.isStaleQuote()
    );
  });
});
