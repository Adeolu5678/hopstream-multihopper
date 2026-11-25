import {
  MAX_DESTINATIONS_PER_TRANSFER,
  TRM_SCREENING_FEE_LAMPORTS_PER_WALLET,
  type CreateTransferRequest,
  type CustomRouteSpec,
  type DestinationShareInput,
  type MultiHopperEnvironment
} from "../types/multihopper.js";

export interface PayrollRecipient {
  wallet: string;
  amountTokens: string;
  label?: string;
}

export interface PayrollBatchInput {
  environment: MultiHopperEnvironment;
  tokenMint: string;
  tokenDecimals: number;
  tokenSymbol: string;
  sourceOwner: string;
  recipients: PayrollRecipient[];
  hops?: number;
  arrivalSeconds?: number;
  route?: CustomRouteSpec;
  routeTemplateId?: number;
  externalIdPrefix: string;
}

export interface PlannedTranche {
  trancheIndex: number;
  request: CreateTransferRequest;
  estimatedScreeningFeeLamports: number;
  screenedWalletCount: number;
}

/**
 * Converts a decimal token string (e.g. "125.50") to base-unit integer string without float drift.
 */
export function parseTokenAmountToRaw(amountTokens: string, decimals: number): string {
  const trimmed = amountTokens.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid token amount '${amountTokens}'`);
  }
  const [wholePart = "0", fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) {
    throw new Error(`Amount '${amountTokens}' exceeds token precision (${decimals} decimals)`);
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const raw = BigInt(`${wholePart}${paddedFrac}`);
  if (raw <= 0n) {
    throw new Error(`Amount '${amountTokens}' must be greater than zero`);
  }
  return raw.toString();
}

export function formatRawToTokens(amountRaw: string, decimals: number): string {
  const raw = BigInt(amountRaw);
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Splits arbitrarily sized payroll recipient lists into MultiHopper-compliant tranches
 * (max 20 destinations per multi-destination transfer, using recipientWallet when size === 1).
 */
export function planPayrollTranches(input: PayrollBatchInput): PlannedTranche[] {
  if (input.recipients.length === 0) {
    throw new Error("At least one recipient is required");
  }

  const seenGlobal = new Set<string>();
  const normalized: Array<{ wallet: string; amountRaw: string }> = input.recipients.map((r, idx) => {
    const wallet = r.wallet.trim();
    if (!wallet) {
      throw new Error(`Recipient at index ${idx} is missing a wallet address`);
    }
    if (seenGlobal.has(wallet)) {
      throw new Error(`Duplicate recipient wallet '${wallet}' in payroll batch`);
    }
    seenGlobal.add(wallet);
    return {
      wallet,
      amountRaw: parseTokenAmountToRaw(r.amountTokens, input.tokenDecimals)
    };
  });

  const tranches: PlannedTranche[] = [];
  const chunkCount = Math.ceil(normalized.length / MAX_DESTINATIONS_PER_TRANSFER);

  for (let i = 0; i < chunkCount; i++) {
    const slice = normalized.slice(
      i * MAX_DESTINATIONS_PER_TRANSFER,
      (i + 1) * MAX_DESTINATIONS_PER_TRANSFER
    );

    const totalRaw = slice.reduce((acc, item) => acc + BigInt(item.amountRaw), 0n);
    const totalTokens = formatRawToTokens(totalRaw.toString(), input.tokenDecimals);
    const externalId = `${input.externalIdPrefix}-t${i + 1}`;

    const request: CreateTransferRequest = {
      tokenMint: input.tokenMint,
      amountRaw: totalRaw.toString(),
      amountTokens: totalTokens,
      tokenDecimals: input.tokenDecimals,
      tokenSymbol: input.tokenSymbol,
      sourceOwner: input.sourceOwner,
      externalId
    };

    if (slice.length === 1 && slice[0]) {
      request.recipientWallet = slice[0].wallet;
    } else {
      request.destinations = slice.map<DestinationShareInput>((s) => ({
        wallet: s.wallet,
        amountRaw: s.amountRaw
      }));
    }

    if (input.route) {
      request.route = input.route;
    } else if (input.routeTemplateId !== undefined) {
      request.routeTemplateId = input.routeTemplateId;
    } else {
      request.hops = input.hops ?? 5;
      request.arrivalSeconds = input.arrivalSeconds ?? 300;
    }

    const hopCount = input.route ? input.route.hops.length : (input.hops ?? 5);
    // Estimate wallets screened on mainnet: sourceOwner + hops + destinations (single recipient is last hop)
    const extraDestCount = slice.length > 1 ? slice.length : 0;
    const screenedWalletCount = 1 + hopCount + extraDestCount;
    const estimatedScreeningFeeLamports =
      input.environment === "mainnet"
        ? screenedWalletCount * TRM_SCREENING_FEE_LAMPORTS_PER_WALLET
        : 0;

    tranches.push({
      trancheIndex: i,
      request,
      screenedWalletCount,
      estimatedScreeningFeeLamports
    });
  }

  return tranches;
}
