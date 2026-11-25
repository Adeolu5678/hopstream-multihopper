import { MultiHopperClient } from "./client/multihopper.js";
import {
  DeterministicMockSigner,
  SolanaWeb3Signer,
  loadSolanaKeypair
} from "./orchestrator/signer.js";
import { TransferOrchestrator } from "./orchestrator/stateMachine.js";
import {
  formatRawToTokens,
  parseTokenAmountToRaw,
  planPayrollTranches
} from "./scheduler/batchRunner.js";
import {
  COMMON_SOLANA_MINTS,
  SOLANA_RPC_URLS,
  type CreateTransferRequest,
  type MultiHopperEnvironment
} from "./types/multihopper.js";
import { startWebhookServer } from "./webhook/server.js";

function getEnv(name: string, fallback?: string): string {
  const val = process.env[name];
  if (val && val.trim().length > 0) return val.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token || !token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function createClientFromEnv(): MultiHopperClient {
  const envName = (process.env.MH_ENV ?? "devnet") as MultiHopperEnvironment;
  const apiKey = getEnv("MH_API_KEY");
  const baseUrl = process.env.MH_BASE_URL;
  return new MultiHopperClient({
    apiKey,
    environment: envName,
    baseUrl
  });
}

function printHelp(): void {
  console.log(`HopStream Treasury & Agentic Multi-Send CLI (MultiHopper)

Commands:
  estimate   --mint <MINT> --amount <TOKENS> [--decimals 6] [--hops 5] [--destinations 1]
  send       --mint <MINT> --amount <TOKENS> --to <WALLET[,WALLET2...]> [--decimals 6] [--hops 5] [--arrival 300] [--template <ID>]
  status     --id <TRANSFER_ID> | --external <EXTERNAL_ID>
  templates  [--name <EXACT_NAME>]
  usage      [--from <ISO_DATE>] [--to <ISO_DATE>]
  webhook    [--port 8787]
  simulate   Run an offline end-to-end orchestration simulation with DeterministicMockSigner

Environment variables:
  MH_ENV=devnet|mainnet
  MH_API_KEY=mh_test_... (devnet) or mh_live_... (mainnet)
  SOLANA_RPC_URL=https://api.devnet.solana.com
  SOLANA_PRIVATE_KEY=<base58 secret key>
  MH_WEBHOOK_SECRET=whsec_...`);
}

async function runSimulate(): Promise<void> {
  const signer = new DeterministicMockSigner();
  const sampleRecipients = [
    { wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountTokens: "400" },
    { wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountTokens: "350" },
    { wallet: "DQTf1yf1YM4B48PqJyQ53SEWGDM6ib4YBV7P3wm2MCxj", amountTokens: "250" }
  ];

  const tranches = planPayrollTranches({
    environment: "devnet",
    tokenMint: COMMON_SOLANA_MINTS.USDC_DEVNET.mint,
    tokenDecimals: 6,
    tokenSymbol: "USDC",
    sourceOwner: signer.publicKey,
    recipients: sampleRecipients,
    hops: 5,
    arrivalSeconds: 300,
    externalIdPrefix: "sim-payroll"
  });

  let confirmCalls = 0;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (url.endsWith("/transfers/estimate")) {
      return new Response(
        JSON.stringify({
          tier: "tier_9",
          tierIndex: 9,
          percentFeeBps: 50,
          percentFeeRaw: "4975124",
          flatFeeLamportsPerHop: 2000000,
          flatFeeLamportsPerRoute: 0,
          totalFlatFeeLamports: 10000000,
          integratorPercentShare: "2487562",
          integratorFlatShare: 0,
          hopAmountRaw: "995024876",
          usdEquivalent: 1000,
          usdValueMicros: "995024876",
          priceSource: "onchain_pool",
          cappedAtTierBoundary: false,
          destinationCount: 3,
          isTestMode: true,
          tokens: {
            amountRaw: body.amountRaw,
            feeRaw: "4975124",
            netDeliveredRaw: "995024876",
            decimals: 6
          },
          sol: {
            requiredSolUpFrontLamports: 35000000,
            minTransferAmountLamports: 2039280,
            breakdown: {
              routeInitRentLamports: 15000000,
              orchestratorRentLamports: 10000000,
              ataRentLamports: 2400000,
              transactionFeesLamports: 50000,
              priorityFeesLamports: 0,
              protocolFlatFeeLamports: 10000000,
              screeningFeeLamports: 0,
              dispersionRentLamports: 6000000
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
        JSON.stringify({
          id: 101,
          externalId: body.externalId,
          status: "quote",
          destinationCount: body.destinations?.length ?? null,
          recipientReceivesRaw: "995024876"
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/prepare")) {
      return new Response(
        JSON.stringify({
          transfer: { id: 101, status: "awaiting_signature" },
          preparedTxs: {
            keeperFundingTx: "MOCK_KEEPER_TX",
            routeInitTxs: [{ base64: "MOCK_ROUTE_TX_0" }],
            orchestratorInitTx: "MOCK_ORCH_TX",
            sessionInitTxs: ["MOCK_SESSION_TX_0"],
            dispersionInitTxs: ["MOCK_DISPERSION_TX_0"],
            recentBlockhash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            lastValidBlockHeight: 300000000,
            resume: {
              routeAlreadyDeployed: false,
              existingHopCount: 0,
              totalHops: 5,
              orchestratorAlreadyInitialized: false,
              completedStepIndices: [],
              totalSteps: 5,
              keeperAlreadyFunded: false,
              dispersion: {
                totalDestinations: 3,
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

    if (url.endsWith("/confirm-broadcast")) {
      confirmCalls++;
      return new Response(
        JSON.stringify({
          transfer: {
            id: 101,
            status: confirmCalls === 1 ? "awaiting_signature" : "processing"
          }
        }),
        { status: 200 }
      );
    }

    if (url.endsWith("/transfers/101")) {
      return new Response(
        JSON.stringify({
          id: 101,
          status: "completed",
          phase: "settled",
          progress: { hopsCompleted: 5, hopsTotal: 5 },
          destinations: sampleRecipients.map((r) => ({
            wallet: r.wallet,
            amountRaw: "331674958",
            status: "paid",
            payoutSignature: "simPayoutSig",
            paidAt: new Date().toISOString()
          }))
        }),
        { status: 200 }
      );
    }

    return new Response(JSON.stringify({ error: { code: "MH_030", message: "Unknown mock path" } }), { status: 404 });
  };

  const client = new MultiHopperClient({
    apiKey: "mh_test_offline_sim",
    environment: "devnet",
    fetchImpl: mockFetch
  });

  const orchestrator = new TransferOrchestrator({
    client,
    signer,
    propagationDelayMs: 0,
    pollIntervalMs: 0,
    onEvent: (entry) => {
      console.log(`[${entry.state}] ${entry.message}`);
    }
  });

  const tranche = tranches[0];
  if (!tranche) throw new Error("Expected at least one tranche");

  const result = await orchestrator.execute({
    createRequest: tranche.request,
    runPreflightEstimate: true,
    pollUntilTerminal: true
  });

  console.log("\nSimulation complete:");
  console.log(
    JSON.stringify(
      {
        transferId: result.transfer.id,
        status: result.transfer.status,
        phase: result.transfer.phase,
        broadcastOrder: signer.broadcasts.map((b) => b.label),
        integratorPercentShareRaw: result.estimate?.integratorPercentShare,
        destinationsPaid: result.transfer.destinations?.length ?? 0
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "simulate") {
    await runSimulate();
    return;
  }

  if (command === "webhook") {
    const secret = getEnv("MH_WEBHOOK_SECRET");
    const port = Number(flags.port ?? process.env.WEBHOOK_PORT ?? 8787);
    const handle = await startWebhookServer({
      secret,
      port,
      onEvent: (ev) => {
        console.log(`[webhook] verified event=${ev.event} id=${ev.id ?? "n/a"}`);
      }
    });
    console.log(`MultiHopper webhook server listening on ${handle.url}/webhooks/multihopper`);
    return;
  }

  const client = createClientFromEnv();
  if (client.keyWarning) {
    console.warn(`Warning: ${client.keyWarning}`);
  }

  if (command === "estimate") {
    const mint = String(flags.mint ?? COMMON_SOLANA_MINTS.USDC.mint);
    const decimals = Number(flags.decimals ?? 6);
    const amountTokens = String(flags.amount ?? "100");
    const amountRaw = parseTokenAmountToRaw(amountTokens, decimals);
    const res = await client.estimateTransfer({
      tokenMint: mint,
      amountRaw,
      tokenDecimals: decimals,
      hops: flags.hops ? Number(flags.hops) : 5,
      destinationCount: flags.destinations ? Number(flags.destinations) : undefined
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "send") {
    const rpcUrl = getEnv("SOLANA_RPC_URL", SOLANA_RPC_URLS[client.environment]);
    const privateKey = getEnv("SOLANA_PRIVATE_KEY");
    const keypair = loadSolanaKeypair(privateKey);
    const signer = new SolanaWeb3Signer({ keypair, rpcUrl });

    const mint = String(flags.mint ?? COMMON_SOLANA_MINTS.USDC.mint);
    const decimals = Number(flags.decimals ?? 6);
    const amountTokens = String(flags.amount ?? "10");
    const totalRaw = parseTokenAmountToRaw(amountTokens, decimals);
    const recipients = String(flags.to ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (recipients.length === 0) {
      throw new Error("--to <WALLET[,WALLET2...]> is required");
    }

    const req: CreateTransferRequest = {
      tokenMint: mint,
      amountRaw: totalRaw,
      amountTokens: formatRawToTokens(totalRaw, decimals),
      tokenDecimals: decimals,
      sourceOwner: signer.publicKey,
      externalId: flags.external ? String(flags.external) : `hopstream-${Date.now()}`
    };

    if (recipients.length === 1) {
      req.recipientWallet = recipients[0];
    } else {
      const perWallet = BigInt(totalRaw) / BigInt(recipients.length);
      const remainder = BigInt(totalRaw) % BigInt(recipients.length);
      req.destinations = recipients.map((wallet, idx) => ({
        wallet,
        amountRaw: (perWallet + (idx === 0 ? remainder : 0n)).toString()
      }));
    }

    if (flags.template) {
      req.routeTemplateId = Number(flags.template);
    } else {
      req.hops = flags.hops ? Number(flags.hops) : 5;
      req.arrivalSeconds = flags.arrival ? Number(flags.arrival) : 300;
    }

    const orchestrator = new TransferOrchestrator({
      client,
      signer,
      onEvent: (entry) => console.log(`[${entry.state}] ${entry.message}`)
    });

    const result = await orchestrator.execute({
      createRequest: req,
      runPreflightEstimate: true,
      pollUntilTerminal: Boolean(flags.poll)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    const res = flags.external
      ? await client.getTransferByExternalId(String(flags.external))
      : await client.getTransfer(Number(flags.id));
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "templates") {
    const res = await client.listRouteTemplates(
      typeof flags.name === "string" ? flags.name : undefined
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "usage") {
    const res = await client.getUsage({
      fromDate: typeof flags.from === "string" ? flags.from : undefined,
      toDate: typeof flags.to === "string" ? flags.to : undefined
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
