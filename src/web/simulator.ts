import {
  TRM_SCREENING_FEE_LAMPORTS_PER_WALLET,
  type CreateTransferRequest,
  type EstimateRequest,
  type EstimateResponse,
  type HopLibraryResponse,
  type MultiHopperEnvironment,
  type RouteTemplate,
  type Transfer,
  type UsageResponse,
  type WebhookEventType
} from "../types/multihopper.js";

export const DEMO_WALLETS = {
  treasury: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  contributors: [
    { label: "Core Protocol Lead", wallet: "7pBqizvE8vQZ29F49NWSu9cho3s7M9SqJyNN1UoQyQ2u", amountTokens: "1200" },
    { label: "Keeper Ops Agent", wallet: "3UdgSTpcUbiBSmgdPBiVHRMbcDS731kMT6bAQQZgE3c4", amountTokens: "850" },
    { label: "Security Auditor", wallet: "DQTf1yf1YM4B48PqJyQ53SEWGDM6ib4YBV7P3wm2MCxj", amountTokens: "950" },
    { label: "Frontend Maintainer", wallet: "64CuV85HHCydAwxQMoXwZ9HXoyw5qE65NkiJxCtuFErF", amountTokens: "500" }
  ]
};

export const DEMO_HOP_LIBRARY: HopLibraryResponse = {
  wallets: [
    {
      address: "64CuV85HHCydAwxQMoXwZ9HXoyw5qE65NkiJxCtuFErF",
      label: "OKX Hot Wallet 10",
      category: "cex",
      canEndRoute: true
    },
    {
      address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
      label: "Binance Hot Wallet 2",
      category: "cex",
      canEndRoute: true
    },
    {
      address: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      label: "Jupiter Aggregator v6",
      category: "contracts",
      canEndRoute: false
    },
    {
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      label: "Raydium Liquidity Vault",
      category: "dex",
      canEndRoute: true
    }
  ],
  bundles: [
    { id: "cex", categories: ["cex"], available: 74 },
    { id: "dex", categories: ["dex"], available: 61 },
    { id: "exchanges", categories: ["cex", "dex"], available: 135 },
    { id: "kol", categories: ["kol"], available: 100 },
    { id: "contracts", categories: ["contracts"], available: 98 },
    { id: "mix", categories: ["cex", "dex", "famous", "kol", "contracts", "other"], available: 598 }
  ],
  categories: ["cex", "dex", "famous", "kol", "contracts", "other"]
};

export const DEMO_ROUTE_TEMPLATES: RouteTemplate[] = [
  {
    id: 5,
    name: "treasury-cex-kol-shield",
    description: "Balances exchange liquidity hop, named anchor, and KOL decoy before payout dispersion",
    route: {
      hops: [
        { bundle: "cex", waitSeconds: 120 },
        { wallet: "DQTf1yf1YM4B48PqJyQ53SEWGDM6ib4YBV7P3wm2MCxj", waitSeconds: 300 },
        { bundle: "kol", waitSeconds: 600 }
      ]
    },
    arrivalSeconds: 1020,
    usableFor: { recipientWallet: true, destinations: true },
    problems: {},
    createdAt: "2026-10-21T09:00:00.000Z",
    updatedAt: "2026-10-21T09:00:00.000Z"
  },
  {
    id: 8,
    name: "agent-fast-sweep",
    description: "Low-latency 3-hop exchange route for autonomous agent disbursements",
    route: {
      hops: [
        { bundle: "exchanges", waitSeconds: 30 },
        { bundle: "dex", waitSeconds: 45 },
        { bundle: "mix", waitSeconds: 45 }
      ]
    },
    arrivalSeconds: 120,
    usableFor: { recipientWallet: true, destinations: true },
    problems: {},
    createdAt: "2026-11-01T14:20:00.000Z",
    updatedAt: "2026-11-01T14:20:00.000Z"
  }
];

export const DEMO_USAGE: UsageResponse = {
  totalTransfers: 142,
  completedTransfers: 136,
  failedTransfers: 2,
  totalVolumeRaw: "128500000000",
  totalFlatFeeEarned: 18420000,
  tokenFeesEarned: [
    {
      tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      tokenDecimals: 6,
      amountRaw: "321250000"
    }
  ],
  totalPayouts: 136,
  isTestMode: false
};

const FEE_SCHEDULE_TIERS: Array<{ maxUsd: number; lamportsPerHop: number }> = [
  { maxUsd: 50, lamportsPerHop: 0 },
  { maxUsd: 106.25, lamportsPerHop: 125_000 },
  { maxUsd: 162.5, lamportsPerHop: 375_000 },
  { maxUsd: 218.75, lamportsPerHop: 625_000 },
  { maxUsd: 275, lamportsPerHop: 875_000 },
  { maxUsd: 331.25, lamportsPerHop: 1_125_000 },
  { maxUsd: 387.5, lamportsPerHop: 1_375_000 },
  { maxUsd: 443.75, lamportsPerHop: 1_625_000 },
  { maxUsd: 500, lamportsPerHop: 1_875_000 },
  { maxUsd: Number.POSITIVE_INFINITY, lamportsPerHop: 2_000_000 }
];

export function simulateEstimate(
  req: EstimateRequest,
  env: MultiHopperEnvironment,
  tokenPriceUsd = 1
): EstimateResponse {
  const decimals = req.tokenDecimals ?? 6;
  const amountRaw = BigInt(req.amountRaw);
  const percentFeeBps = 50;
  const hopAmountRaw = (amountRaw * 10_000n) / BigInt(10_000 + percentFeeBps);
  const percentFeeRaw = amountRaw - hopAmountRaw;
  const integratorPercentShare = percentFeeRaw / 2n;

  const usdDisplay = (Number(amountRaw) / 10 ** decimals) * tokenPriceUsd;
  const hopUsd = (Number(hopAmountRaw) / 10 ** decimals) * tokenPriceUsd;

  let tierIndex = FEE_SCHEDULE_TIERS.findIndex((t) => hopUsd <= t.maxUsd);
  if (tierIndex < 0) tierIndex = 9;
  const flatFeeLamportsPerHop = FEE_SCHEDULE_TIERS[tierIndex]?.lamportsPerHop ?? 2_000_000;
  const hops = req.route ? req.route.hops.length : (req.hops ?? 5);
  const totalFlatFeeLamports = flatFeeLamportsPerHop * hops;

  const destCount = req.destinationCount ?? 1;
  const dispersionRentLamports = destCount > 1 ? destCount * 2_039_280 : 0;
  const routeInitRentLamports = 15_407_640;
  const orchestratorRentLamports = 13_655_040;
  const ataRentLamports = 2_428_240 + hops * 1_900_000;
  const transactionFeesLamports = (4 + hops + (destCount > 1 ? destCount : 0)) * 5_000;
  const lateReScreenMultiplier = (req.arrivalSeconds ?? 300) > 21_600 ? 2 : 1;
  const screenedWallets = 1 + hops + (destCount > 1 ? destCount : 0) * lateReScreenMultiplier;
  const screeningFeeLamports =
    env === "mainnet" ? screenedWallets * TRM_SCREENING_FEE_LAMPORTS_PER_WALLET : 0;

  const requiredSolUpFrontLamports =
    routeInitRentLamports +
    orchestratorRentLamports +
    ataRentLamports +
    transactionFeesLamports +
    totalFlatFeeLamports +
    screeningFeeLamports +
    dispersionRentLamports;

  const refundableLamports = 16_083_280 + dispersionRentLamports;

  return {
    tier: `tier_${tierIndex}`,
    tierIndex,
    percentFeeBps,
    percentFeeRaw: percentFeeRaw.toString(),
    flatFeeLamportsPerHop,
    flatFeeLamportsPerRoute: 0,
    totalFlatFeeLamports,
    integratorPercentShare: integratorPercentShare.toString(),
    integratorFlatShare: 0,
    hopAmountRaw: hopAmountRaw.toString(),
    usdEquivalent: Number(usdDisplay.toFixed(2)),
    usdValueMicros: Math.round(hopUsd * 1_000_000).toString(),
    priceSource: "onchain_pool",
    cappedAtTierBoundary: false,
    destinationCount: req.destinationCount ?? null,
    isTestMode: env === "devnet",
    tokens: {
      amountRaw: req.amountRaw,
      feeRaw: percentFeeRaw.toString(),
      netDeliveredRaw: hopAmountRaw.toString(),
      decimals
    },
    sol: {
      requiredSolUpFrontLamports,
      minTransferAmountLamports: 2_039_280,
      breakdown: {
        routeInitRentLamports,
        orchestratorRentLamports,
        ataRentLamports,
        transactionFeesLamports,
        priorityFeesLamports: 0,
        protocolFlatFeeLamports: totalFlatFeeLamports,
        screeningFeeLamports,
        dispersionRentLamports
      },
      refundableLamports,
      netCostLamports: requiredSolUpFrontLamports - refundableLamports
    },
    route: req.route
      ? {
          hopCount: req.route.hops.length + (destCount > 1 ? 0 : 1),
          arrivalSeconds: req.route.hops.reduce((acc, h) => acc + h.waitSeconds, 0)
        }
      : undefined
  };
}

export function buildSimulatedTransfer(
  req: CreateTransferRequest,
  est: EstimateResponse,
  env: MultiHopperEnvironment
): Transfer {
  const hopsCount = req.route ? req.route.hops.length : (req.hops ?? 5);
  const destinations = req.destinations?.map((d) => {
    const share = (BigInt(d.amountRaw) * BigInt(est.hopAmountRaw)) / BigInt(req.amountRaw);
    return {
      wallet: d.wallet,
      amountRaw: share.toString(),
      status: "pending" as const,
      payoutSignature: null,
      paidAt: null
    };
  });

  return {
    id: Math.floor(1000 + Math.random() * 8999),
    externalId: req.externalId ?? `sim-${Date.now()}`,
    supportBundleId: `MH-hopstream-${Math.floor(10 + Math.random() * 89)}`,
    tokenMint: req.tokenMint,
    amountRaw: req.amountRaw,
    amountTokens: req.amountTokens,
    sourceOwner: req.sourceOwner,
    recipientWallet: req.recipientWallet ?? null,
    destinationCount: destinations ? destinations.length : null,
    destinations: destinations ?? null,
    recipientReceivesRaw: est.hopAmountRaw,
    fundingStrategy: "direct_orchestration",
    hops: hopsCount,
    arrivalSeconds: req.arrivalSeconds ?? est.route?.arrivalSeconds ?? 300,
    pricingTier: est.tier,
    percentFeeBps: est.percentFeeBps,
    percentFeeRaw: est.percentFeeRaw,
    flatFeeLamportsPerHop: est.flatFeeLamportsPerHop,
    totalFlatFeeLamports: est.totalFlatFeeLamports,
    status: "quote",
    phase: "quoted",
    isTest: env === "devnet",
    quotedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    progress: {
      hopsCompleted: 0,
      hopsTotal: hopsCount
    }
  };
}

export async function computeHmacSha256HexBrowser(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const ALL_WEBHOOK_EVENTS: WebhookEventType[] = [
  "transfer.quote_created",
  "transfer.deposit_confirmed",
  "transfer.processing",
  "transfer.phase_changed",
  "transfer.hop_complete",
  "transfer.completed",
  "transfer.failed",
  "transfer.expired",
  "transfer.refunded",
  "transfer.recoverable",
  "transfer.rescued",
  "transfer.rent_reclaimed",
  "payout.completed"
];
