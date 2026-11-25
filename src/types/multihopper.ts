export type MultiHopperEnvironment = "devnet" | "mainnet";

export const MULTIHOPPER_BASE_URLS: Record<MultiHopperEnvironment, string> = {
  devnet: "https://devnet.multihopper.com/api/v1",
  mainnet: "https://multihopper.com/api/v1"
};

export const SOLANA_RPC_URLS: Record<MultiHopperEnvironment, string> = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com"
};

export const MULTIHOPPER_DASHBOARD_URLS: Record<MultiHopperEnvironment, string> = {
  devnet: "https://devnet.multihopper.com/developer/dashboard",
  mainnet: "https://multihopper.com/developer/dashboard"
};

export const MULTIHOPPER_PROGRAMS = {
  core: "3jLoS2wbNgtKzieUUxwg6Xhdv6gbZkHDtPWA9ZAgspFh",
  orchestrator: "4TPCmR2uN3hDM1FbTsf7ZtFXwXGSz4u1Kxv5YHj6eruX",
  transferHookGuard: "2JEv3pD6nczEvn1xDXaEzehkJofPPjoQQpnW5nGY3r52"
} as const;

export const COMMON_SOLANA_MINTS = {
  SOL: {
    symbol: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9
  },
  USDC: {
    symbol: "USDC",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6
  },
  USDC_DEVNET: {
    symbol: "USDC",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6
  }
} as const;

export const TRM_SCREENING_FEE_LAMPORTS_PER_WALLET = 2_000_000; // 0.002 SOL
export const MAX_DESTINATIONS_PER_TRANSFER = 20;
export const MIN_HOPS = 3;
export const MAX_HOPS = 10;
export const MIN_WAIT_SECONDS = 20;
export const MAX_ARRIVAL_SECONDS = 2_592_000; // 30 days

export type MultiHopperErrorCode =
  | "MH_001"
  | "MH_002"
  | "MH_003"
  | "MH_004"
  | "MH_010"
  | "MH_011"
  | "MH_012"
  | "MH_013"
  | "MH_014"
  | "MH_015"
  | "MH_016"
  | "MH_017"
  | "MH_018"
  | "MH_019"
  | "MH_020"
  | "MH_021"
  | "MH_022"
  | "MH_023"
  | "MH_030"
  | "MH_031"
  | "MH_032"
  | "MH_033"
  | "MH_034"
  | "MH_035"
  | "MH_036"
  | "MH_037"
  | "MH_038"
  | "MH_039"
  | "MH_040"
  | "MH_041"
  | "MH_050"
  | "MH_051"
  | "MH_060"
  | "MH_061"
  | "MH_070"
  | "MH_071"
  | "MH_072"
  | "MH_080"
  | "MH_081"
  | "MH_082"
  | "MH_083"
  | "MH_090"
  | "MH_091"
  | "BAD_REQUEST"
  | (string & {});

export type HopCategory = "cex" | "dex" | "famous" | "kol" | "contracts" | "other";
export type HopBundleId = "cex" | "dex" | "exchanges" | "kol" | "contracts" | "mix";

export type CustomHopSpec =
  | { wallet: string; waitSeconds: number }
  | { bundle: HopBundleId; waitSeconds: number };

export interface CustomRouteSpec {
  hops: CustomHopSpec[];
}

export interface DestinationShareInput {
  wallet: string;
  amountRaw: string;
}

export interface EstimateRequest {
  tokenMint: string;
  amountRaw: string;
  tokenDecimals?: number;
  hops?: number;
  destinationCount?: number;
  arrivalSeconds?: number;
  route?: CustomRouteSpec;
  routeTemplateId?: number;
  tokenPriceUsd?: number;
}

export interface EstimateTokensBreakdown {
  amountRaw: string;
  feeRaw: string;
  netDeliveredRaw: string;
  decimals: number;
}

export interface EstimateSolBreakdown {
  routeInitRentLamports: number;
  orchestratorRentLamports: number;
  ataRentLamports: number;
  transactionFeesLamports: number;
  priorityFeesLamports: number;
  protocolFlatFeeLamports: number;
  screeningFeeLamports: number;
  dispersionRentLamports: number;
}

export interface EstimateSolInfo {
  requiredSolUpFrontLamports: number;
  minTransferAmountLamports: number;
  breakdown: EstimateSolBreakdown;
  refundableLamports: number;
  netCostLamports: number;
}

export interface EstimateResponse {
  tier: string;
  tierIndex: number;
  percentFeeBps: number;
  percentFeeRaw: string;
  flatFeeLamportsPerHop: number;
  flatFeeLamportsPerRoute: number;
  totalFlatFeeLamports: number;
  integratorPercentShare: string;
  integratorFlatShare: number;
  hopAmountRaw: string;
  usdEquivalent: number;
  usdValueMicros: string;
  priceSource: "onchain_pool" | "override" | "oracle" | string;
  cappedAtTierBoundary: boolean;
  destinationCount?: number | null;
  isTestMode: boolean;
  tokens: EstimateTokensBreakdown;
  sol: EstimateSolInfo;
  route?: {
    hopCount: number;
    arrivalSeconds: number;
  };
}

export interface CreateTransferRequest {
  tokenMint: string;
  amountRaw: string;
  amountTokens: string;
  sourceOwner: string;
  recipientWallet?: string;
  destinations?: DestinationShareInput[];
  tokenDecimals?: number;
  tokenSymbol?: string;
  hops?: number;
  arrivalSeconds?: number;
  route?: CustomRouteSpec;
  routeTemplateId?: number;
  externalId?: string;
  tokenPriceUsd?: number;
}

export type TransferStatus =
  | "quote"
  | "awaiting_signature"
  | "processing"
  | "active"
  | "completed"
  | "failed"
  | "expired"
  | "refunded";

export type TransferPhase =
  | "quoted"
  | "deploying"
  | "executing"
  | "settled"
  | "failed"
  | "recoverable"
  | "rescued"
  | "reclaimed"
  | "expired";

export interface DestinationPayout {
  wallet: string;
  amountRaw: string;
  status: "pending" | "paid";
  payoutSignature: string | null;
  paidAt: string | null;
}

export interface TransferRouteHop {
  index: number;
  address: string;
  label: string | null;
  category: HopCategory | null;
  scheduledAt: string;
  executedAt: string | null;
  txSignature: string | null;
}

export interface TransferLastError {
  code: MultiHopperErrorCode;
  message: string;
  at: string;
}

export interface TransferRecoveryInfo {
  canRescue: boolean;
  rescuableLamports: number;
  rescuableAccounts: Array<{ kind: string; lamports: number }>;
  canReclaimRent: boolean;
  reclaimableLamports: number;
}

export interface TransferSignatures {
  routeInit: string[];
  sessionInit: string[];
  hops: string[];
}

export interface Transfer {
  id: number;
  externalId?: string | null;
  supportBundleId?: string;
  tokenMint?: string;
  amountRaw?: string;
  amountTokens?: string;
  sourceOwner?: string;
  recipientWallet?: string | null;
  destinationCount?: number | null;
  destinations?: DestinationPayout[] | null;
  recipientReceivesRaw?: string;
  fundingStrategy?: string;
  hops?: number;
  arrivalSeconds?: number;
  pricingTier?: string;
  percentFeeBps?: number;
  percentFeeRaw?: string;
  flatFeeLamportsPerHop?: number;
  totalFlatFeeLamports?: number;
  status: TransferStatus;
  phase?: TransferPhase;
  isTest?: boolean;
  quotedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  route?: {
    hops: TransferRouteHop[];
  };
  progress?: {
    hopsCompleted: number;
    hopsTotal: number;
  };
  lastError?: TransferLastError | null;
  recovery?: TransferRecoveryInfo | null;
  signatures?: TransferSignatures;
}

export interface PrepareDispersionResume {
  totalDestinations: number;
  orchestratorInitialized: boolean;
  stepsInitialized: number;
  routeExitBound: boolean;
}

export interface PrepareResumeState {
  routeAlreadyDeployed: boolean;
  existingHopCount: number;
  totalHops: number;
  orchestratorAlreadyInitialized: boolean;
  completedStepIndices: number[];
  totalSteps: number;
  keeperAlreadyFunded: boolean;
  dispersion: PrepareDispersionResume | null;
  nothingToDo: boolean;
}

export interface PreparedTxsBundle {
  keeperFundingTx: string | null;
  routeInitTxs: Array<{ base64: string }> | null;
  orchestratorInitTx: string | null;
  sessionInitTxs: string[] | null;
  dispersionInitTxs: string[] | null;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  resume?: PrepareResumeState;
}

export interface PrepareTransferResponse {
  transfer: Transfer;
  preparedTxs: PreparedTxsBundle;
}

export interface ConfirmBroadcastRequest {
  routeInitSignatures: string[];
  keeperFundingSignature?: string;
  orchestratorInitSignature?: string;
  sessionInitSignatures?: string[];
  dispersionInitSignatures?: string[];
}

export interface ConfirmBroadcastResponse {
  transfer: Transfer;
}

export interface ListTransfersQuery {
  status?: TransferStatus;
  fromDate?: string;
  toDate?: string;
  externalId?: string;
  supportBundleId?: string;
  limit?: number;
  offset?: number;
}

export interface ListTransfersResponse {
  items: Transfer[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

export interface HopLibraryQuery {
  category?: HopCategory;
  bundle?: HopBundleId;
  canEndRoute?: boolean;
}

export interface HopLibraryWallet {
  address: string;
  label: string;
  category: HopCategory;
  canEndRoute: boolean;
}

export interface HopLibraryBundle {
  id: HopBundleId;
  categories: HopCategory[];
  available: number;
}

export interface HopLibraryResponse {
  wallets: HopLibraryWallet[];
  bundles: HopLibraryBundle[];
  categories: HopCategory[];
}

export interface CreateRouteTemplateRequest {
  name: string;
  description?: string | null;
  route: CustomRouteSpec;
}

export interface UpdateRouteTemplateRequest {
  name?: string;
  description?: string | null;
  route?: CustomRouteSpec;
}

export interface RouteTemplate {
  id: number;
  name: string;
  description: string | null;
  route: CustomRouteSpec;
  arrivalSeconds: number;
  usableFor: {
    recipientWallet: boolean;
    destinations: boolean;
  };
  problems: Record<string, string[] | string>;
  createdAt: string;
  updatedAt: string;
}

export interface ListRouteTemplatesResponse {
  items: RouteTemplate[];
}

export interface UsageQuery {
  fromDate?: string;
  toDate?: string;
}

export interface TokenFeeEarned {
  tokenMint: string;
  tokenDecimals: number;
  amountRaw: string;
}

export interface UsageResponse {
  totalTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  totalVolumeRaw: string;
  totalFlatFeeEarned: number;
  tokenFeesEarned: TokenFeeEarned[];
  totalPayouts: number;
  isTestMode: boolean;
}

export type WebhookEventType =
  | "transfer.quote_created"
  | "transfer.deposit_confirmed"
  | "transfer.processing"
  | "transfer.phase_changed"
  | "transfer.hop_complete"
  | "transfer.completed"
  | "transfer.failed"
  | "transfer.expired"
  | "transfer.refunded"
  | "transfer.recoverable"
  | "transfer.rescued"
  | "transfer.rent_reclaimed"
  | "payout.completed";

export interface RegisterWebhookRequest {
  url: string;
  events?: WebhookEventType[];
}

export interface RegisterWebhookResponse {
  id: number;
  url: string;
  secret: string;
  events: WebhookEventType[];
}

export interface WebhookEndpoint {
  id: number;
  url: string;
  events: WebhookEventType[];
  isActive: boolean;
  createdAt: string;
}

export interface ListWebhooksResponse {
  items: WebhookEndpoint[];
}

export interface WebhookEventPayload<T = Record<string, unknown>> {
  id?: string;
  event: WebhookEventType;
  timestamp?: string;
  data: T;
}

export interface RescuePrepareResponse {
  rescueTxs: string[];
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
}

export interface RescueConfirmRequest {
  signatures: string[];
}
