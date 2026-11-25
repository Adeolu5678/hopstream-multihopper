import { MultiHopperApiError } from "../client/errors.js";
import type { MultiHopperClient } from "../client/multihopper.js";
import type {
  ConfirmBroadcastRequest,
  CreateTransferRequest,
  EstimateRequest,
  EstimateResponse,
  PreparedTxsBundle,
  Transfer
} from "../types/multihopper.js";
import type { SignerAdapter } from "./signer.js";

export type OrchestratorState =
  | "idle"
  | "estimating"
  | "estimated"
  | "creating"
  | "created"
  | "preparing"
  | "funding_keeper"
  | "confirming_keeper"
  | "broadcasting_route"
  | "confirming_bundle"
  | "polling"
  | "settled"
  | "recoverable"
  | "refunded"
  | "expired"
  | "failed";

export interface OrchestratorLogEntry {
  timestamp: string;
  state: OrchestratorState;
  message: string;
  details?: Record<string, unknown>;
}

export interface OrchestratorOptions {
  client: MultiHopperClient;
  signer: SignerAdapter;
  /**
   * Delay after last routeInitTx and after orchestratorInitTx for RPC state propagation.
   * MultiHopper docs recommend 3000ms on devnet/mainnet; pass 0 in offline unit tests.
   */
  propagationDelayMs?: number;
  pollIntervalMs?: number;
  maxPrepareAttempts?: number;
  maxPollAttempts?: number;
  onEvent?: (entry: OrchestratorLogEntry) => void;
}

export interface ExecuteTransferParams {
  createRequest: CreateTransferRequest;
  runPreflightEstimate?: boolean;
  pollUntilTerminal?: boolean;
}

export interface ExecuteTransferResult {
  state: OrchestratorState;
  estimate?: EstimateResponse;
  transfer: Transfer;
  signatures: ConfirmBroadcastRequest;
  prepareAttempts: number;
  logs: OrchestratorLogEntry[];
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toEstimateRequest(req: CreateTransferRequest): EstimateRequest {
  return {
    tokenMint: req.tokenMint,
    amountRaw: req.amountRaw,
    tokenDecimals: req.tokenDecimals,
    hops: req.hops,
    destinationCount: req.destinations?.length,
    arrivalSeconds: req.arrivalSeconds,
    route: req.route,
    routeTemplateId: req.routeTemplateId,
    tokenPriceUsd: req.tokenPriceUsd
  };
}

/**
 * Orchestrates the complete MultiHopper transfer lifecycle:
 * estimate -> create -> prepare -> sign/broadcast/confirm keeperFundingTx FIRST ->
 * sign/broadcast routeInitTxs -> orchestratorInitTx -> sessionInitTxs -> dispersionInitTxs ->
 * final confirm-broadcast -> poll through TRM compliance verification to settlement.
 */
export class TransferOrchestrator {
  private readonly client: MultiHopperClient;
  private readonly signer: SignerAdapter;
  private readonly propagationDelayMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxPrepareAttempts: number;
  private readonly maxPollAttempts: number;
  private readonly onEvent?: (entry: OrchestratorLogEntry) => void;

  constructor(options: OrchestratorOptions) {
    this.client = options.client;
    this.signer = options.signer;
    this.propagationDelayMs = options.propagationDelayMs ?? 3000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.maxPrepareAttempts = options.maxPrepareAttempts ?? 4;
    this.maxPollAttempts = options.maxPollAttempts ?? 60;
    this.onEvent = options.onEvent;
  }

  public async execute(params: ExecuteTransferParams): Promise<ExecuteTransferResult> {
    const logs: OrchestratorLogEntry[] = [];
    let currentState: OrchestratorState = "idle";
    const emit = (state: OrchestratorState, message: string, details?: Record<string, unknown>) => {
      currentState = state;
      const entry: OrchestratorLogEntry = {
        timestamp: new Date().toISOString(),
        state,
        message,
        details
      };
      logs.push(entry);
      this.onEvent?.(entry);
    };

    try {
      let estimate: EstimateResponse | undefined;
      if (params.runPreflightEstimate !== false) {
        emit("estimating", "Running preflight cost and TRM screening estimate");
        estimate = await this.client.estimateTransfer(toEstimateRequest(params.createRequest));
        emit("estimated", `Quoted tier ${estimate.tier} (${estimate.priceSource})`, {
          tier: estimate.tier,
          requiredSolUpFrontLamports: estimate.sol.requiredSolUpFrontLamports,
          screeningFeeLamports: estimate.sol.breakdown.screeningFeeLamports,
          dispersionRentLamports: estimate.sol.breakdown.dispersionRentLamports,
          integratorPercentShare: estimate.integratorPercentShare
        });
      }

      emit("creating", "Creating transfer quote");
      let transfer = await this.client.createTransfer(params.createRequest);
      emit("created", `Created transfer #${transfer.id} (${transfer.status})`, {
        transferId: transfer.id,
        externalId: transfer.externalId,
        recipientReceivesRaw: transfer.recipientReceivesRaw
      });

      const collected: ConfirmBroadcastRequest = {
        routeInitSignatures: []
      };

      let prepareAttempts = 0;
      let confirmedBundle = false;

      while (!confirmedBundle) {
        prepareAttempts++;
        if (prepareAttempts > this.maxPrepareAttempts) {
          throw new Error(`Exceeded maximum prepare attempts (${this.maxPrepareAttempts}) for transfer #${transfer.id}`);
        }

        emit("preparing", `Preparing transaction bundle (attempt ${prepareAttempts}/${this.maxPrepareAttempts})`, {
          transferId: transfer.id,
          attempt: prepareAttempts
        });

        const prepared = await this.client.prepareTransfer(transfer.id);
        transfer = prepared.transfer;
        const bundle = prepared.preparedTxs;

        if (!bundle.resume?.nothingToDo) {
          try {
            await this.signAndBroadcastBundle(transfer.id, bundle, collected, emit);
          } catch (err) {
            // If blockhash expired or RPC dropped a mid-bundle tx, loop back to /prepare
            // unless we already hit maxPrepareAttempts.
            if (prepareAttempts < this.maxPrepareAttempts && !(err instanceof MultiHopperApiError)) {
              emit("preparing", `Mid-bundle RPC interruption; resuming via fresh /prepare`, {
                error: err instanceof Error ? err.message : String(err)
              });
              continue;
            }
            throw err;
          }
        }

        emit("confirming_bundle", "Submitting final confirm-broadcast signatures", {
          transferId: transfer.id,
          routeInitCount: collected.routeInitSignatures.length,
          sessionInitCount: collected.sessionInitSignatures?.length ?? 0,
          dispersionInitCount: collected.dispersionInitSignatures?.length ?? 0
        });

        try {
          const confirmed = await this.client.confirmBroadcast(transfer.id, collected);
          transfer = confirmed.transfer;
          confirmedBundle = true;
        } catch (err) {
          if (err instanceof MultiHopperApiError && err.isMissingDispersion()) {
            emit("preparing", "Received MH_041: multi-destination exit binding incomplete, re-preparing dispersionInitTxs", {
              code: err.code,
              message: err.message
            });
            continue;
          }
          throw err;
        }
      }

      if (params.pollUntilTerminal) {
        emit("polling", "Polling transfer through TRM verification and hop execution", {
          transferId: transfer.id
        });
        transfer = await this.pollUntilSettled(transfer.id, emit);
      }

      const terminalState = this.mapTransferToState(transfer);
      emit(terminalState, `Transfer #${transfer.id} reached state ${terminalState} (${transfer.status})`, {
        status: transfer.status,
        phase: transfer.phase
      });

      return {
        state: currentState,
        estimate,
        transfer,
        signatures: collected,
        prepareAttempts,
        logs
      };
    } catch (err) {
      emit("failed", err instanceof Error ? err.message : String(err), {
        code: err instanceof MultiHopperApiError ? err.code : undefined
      });
      throw err;
    }
  }

  private async signAndBroadcastBundle(
    transferId: number,
    bundle: PreparedTxsBundle,
    collected: ConfirmBroadcastRequest,
    emit: (state: OrchestratorState, message: string, details?: Record<string, unknown>) => void
  ): Promise<void> {
    // 1. keeperFundingTx MUST be signed, broadcast, confirmed, and reported FIRST
    // before any routeInitTx is sent. This prevents double-funding on resume.
    if (bundle.keeperFundingTx) {
      emit("funding_keeper", "Signing and broadcasting keeperFundingTx FIRST");
      const signedKeeper = await this.signer.signVersionedTx(bundle.keeperFundingTx);
      const keeperSig = await this.signer.broadcastAndConfirm(signedKeeper, "keeperFundingTx");
      collected.keeperFundingSignature = keeperSig;

      emit("confirming_keeper", "Recording keeperFundingSignature immediately via confirm-broadcast", {
        keeperFundingSignature: keeperSig
      });
      await this.client.confirmBroadcast(transferId, {
        routeInitSignatures: [],
        keeperFundingSignature: keeperSig
      });
    }

    emit("broadcasting_route", "Signing and broadcasting remaining route bundle in strict order");

    // 2. routeInitTxs in sequence
    if (bundle.routeInitTxs && bundle.routeInitTxs.length > 0) {
      for (let i = 0; i < bundle.routeInitTxs.length; i++) {
        const entry = bundle.routeInitTxs[i];
        if (!entry) continue;
        const signed = await this.signer.signVersionedTx(entry.base64);
        const sig = await this.signer.broadcastAndConfirm(signed, `routeInitTxs[${i}]`);
        collected.routeInitSignatures.push(sig);
        if (i < bundle.routeInitTxs.length - 1) {
          await sleep(this.propagationDelayMs);
        }
      }
      await sleep(this.propagationDelayMs);
    }

    // 3. orchestratorInitTx (Legacy Transaction)
    if (bundle.orchestratorInitTx) {
      const signedOrch = await this.signer.signLegacyTx(bundle.orchestratorInitTx);
      const sig = await this.signer.broadcastAndConfirm(signedOrch, "orchestratorInitTx");
      collected.orchestratorInitSignature = sig;
      await sleep(this.propagationDelayMs);
    }

    // 4. sessionInitTxs
    if (bundle.sessionInitTxs && bundle.sessionInitTxs.length > 0) {
      const sessionSigs = collected.sessionInitSignatures ?? [];
      for (let i = 0; i < bundle.sessionInitTxs.length; i++) {
        const rawTx = bundle.sessionInitTxs[i];
        if (!rawTx) continue;
        const signed = await this.signer.signVersionedTx(rawTx);
        const sig = await this.signer.broadcastAndConfirm(signed, `sessionInitTxs[${i}]`);
        sessionSigs.push(sig);
      }
      collected.sessionInitSignatures = sessionSigs;
    }

    // 5. dispersionInitTxs (Multi-destination transfers only)
    if (bundle.dispersionInitTxs && bundle.dispersionInitTxs.length > 0) {
      const dispersionSigs = collected.dispersionInitSignatures ?? [];
      for (let i = 0; i < bundle.dispersionInitTxs.length; i++) {
        const rawTx = bundle.dispersionInitTxs[i];
        if (!rawTx) continue;
        const signed = await this.signer.signVersionedTx(rawTx);
        const sig = await this.signer.broadcastAndConfirm(signed, `dispersionInitTxs[${i}]`);
        dispersionSigs.push(sig);
      }
      collected.dispersionInitSignatures = dispersionSigs;
    }
  }

  private async pollUntilSettled(
    transferId: number,
    emit: (state: OrchestratorState, message: string, details?: Record<string, unknown>) => void
  ): Promise<Transfer> {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      const transfer = await this.client.getTransfer(transferId);
      if (
        transfer.status === "completed" ||
        transfer.status === "failed" ||
        transfer.status === "expired" ||
        transfer.status === "refunded"
      ) {
        return transfer;
      }

      emit("polling", `Poll ${attempt}: status=${transfer.status}, phase=${transfer.phase ?? "unknown"}`, {
        progress: transfer.progress
      });
      await sleep(this.pollIntervalMs);
    }

    throw new Error(`Polling timed out after ${this.maxPollAttempts} attempts for transfer #${transferId}`);
  }

  private mapTransferToState(transfer: Transfer): OrchestratorState {
    if (transfer.phase === "recoverable") return "recoverable";
    switch (transfer.status) {
      case "completed":
        return "settled";
      case "refunded":
        return "refunded";
      case "expired":
        return "expired";
      case "failed":
        return "failed";
      default:
        return "polling";
    }
  }
}
