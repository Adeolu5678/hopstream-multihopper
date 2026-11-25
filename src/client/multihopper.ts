import {
  MAX_ARRIVAL_SECONDS,
  MAX_DESTINATIONS_PER_TRANSFER,
  MAX_HOPS,
  MIN_HOPS,
  MIN_WAIT_SECONDS,
  MULTIHOPPER_BASE_URLS,
  type ConfirmBroadcastRequest,
  type ConfirmBroadcastResponse,
  type CreateRouteTemplateRequest,
  type CreateTransferRequest,
  type EstimateRequest,
  type EstimateResponse,
  type HopLibraryQuery,
  type HopLibraryResponse,
  type ListRouteTemplatesResponse,
  type ListTransfersQuery,
  type ListTransfersResponse,
  type ListWebhooksResponse,
  type MultiHopperEnvironment,
  type PrepareTransferResponse,
  type RegisterWebhookRequest,
  type RegisterWebhookResponse,
  type RescueConfirmRequest,
  type RescuePrepareResponse,
  type RouteTemplate,
  type Transfer,
  type UpdateRouteTemplateRequest,
  type UsageQuery,
  type UsageResponse
} from "../types/multihopper.js";
import {
  MultiHopperApiError,
  MultiHopperValidationError,
  type MultiHopperErrorEnvelope
} from "./errors.js";

export type FetchLike = typeof fetch;

export interface MultiHopperClientOptions {
  apiKey: string;
  environment?: MultiHopperEnvironment;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  /**
   * Optional idempotency key generator for deterministic testing.
   * Must return 8-64 characters matching [a-zA-Z0-9._-].
   */
  generateIdempotencyKey?: () => string;
  /**
   * When true, throws if a live key (mh_live_) is paired with devnet.
   */
  strictKeyEnvironmentCheck?: boolean;
}

const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9._-]{8,64}$/;
const EXTERNAL_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function defaultIdempotencyKey(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const rand = Math.random().toString(36).slice(2, 12);
  return `mh-${Date.now().toString(36)}-${rand}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertValidIdempotencyKey(key: string): string {
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new MultiHopperValidationError(
      "Idempotency-Key must be 8-64 characters matching [a-zA-Z0-9._-]",
      "Idempotency-Key"
    );
  }
  return key;
}

export function validateApiKeyForEnvironment(
  apiKey: string,
  environment: MultiHopperEnvironment,
  strict = false
): { validFormat: boolean; warning?: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new MultiHopperValidationError("MultiHopper API key is required", "apiKey");
  }
  const isTestKey = trimmed.startsWith("mh_test_");
  const isLiveKey = trimmed.startsWith("mh_live_");

  if (!isTestKey && !isLiveKey) {
    const msg = "API key should start with mh_test_ (devnet/test) or mh_live_ (mainnet)";
    if (strict) throw new MultiHopperValidationError(msg, "apiKey");
    return { validFormat: false, warning: msg };
  }

  if (environment === "devnet" && isLiveKey) {
    const msg = "mh_live_ keys belong to mainnet; devnet expects mh_test_ keys minted on devnet.multihopper.com";
    if (strict) throw new MultiHopperValidationError(msg, "apiKey");
    return { validFormat: true, warning: msg };
  }

  return { validFormat: true };
}

export function validateCreateTransferRequest(req: CreateTransferRequest): void {
  if (!req.tokenMint.trim()) {
    throw new MultiHopperValidationError("tokenMint is required", "tokenMint");
  }
  if (!/^\d+$/.test(req.amountRaw) || BigInt(req.amountRaw) <= 0n) {
    throw new MultiHopperValidationError("amountRaw must be a positive integer string", "amountRaw");
  }
  if (!req.sourceOwner.trim()) {
    throw new MultiHopperValidationError("sourceOwner is required", "sourceOwner");
  }

  const hasRecipient = Boolean(req.recipientWallet && req.recipientWallet.trim().length > 0);
  const hasDestinations = Array.isArray(req.destinations) && req.destinations.length > 0;
  if (hasRecipient === hasDestinations) {
    throw new MultiHopperValidationError(
      "Provide exactly one of recipientWallet or destinations (never both, never neither)",
      "destinations"
    );
  }

  if (hasDestinations && req.destinations) {
    if (req.destinations.length > MAX_DESTINATIONS_PER_TRANSFER) {
      throw new MultiHopperValidationError(
        `destinations supports at most ${MAX_DESTINATIONS_PER_TRANSFER} wallets per transfer`,
        "destinations"
      );
    }

    const seenWallets = new Set<string>();
    let totalShare = 0n;
    for (let i = 0; i < req.destinations.length; i++) {
      const dest = req.destinations[i];
      if (!dest) continue;
      if (!dest.wallet.trim()) {
        throw new MultiHopperValidationError(`destinations[${i}].wallet is required`, "destinations");
      }
      if (seenWallets.has(dest.wallet)) {
        throw new MultiHopperValidationError(
          `Duplicate destination wallet '${dest.wallet}' at destinations[${i}]`,
          "destinations"
        );
      }
      seenWallets.add(dest.wallet);
      if (!/^\d+$/.test(dest.amountRaw) || BigInt(dest.amountRaw) <= 0n) {
        throw new MultiHopperValidationError(
          `destinations[${i}].amountRaw must be a positive integer string`,
          "destinations"
        );
      }
      totalShare += BigInt(dest.amountRaw);
    }

    if (totalShare !== BigInt(req.amountRaw)) {
      throw new MultiHopperValidationError(
        `Destination shares sum (${totalShare.toString()}) must equal amountRaw (${req.amountRaw})`,
        "destinations"
      );
    }
  }

  if (req.externalId !== undefined && !EXTERNAL_ID_PATTERN.test(req.externalId)) {
    throw new MultiHopperValidationError(
      "externalId may only contain alphanumeric characters, '.', '_', and '-'",
      "externalId"
    );
  }

  const usesCustomRoute = req.route !== undefined;
  const usesTemplate = req.routeTemplateId !== undefined;
  if (usesCustomRoute && usesTemplate) {
    throw new MultiHopperValidationError(
      "Cannot specify both route and routeTemplateId",
      "routeTemplateId"
    );
  }
  if ((usesCustomRoute || usesTemplate) && (req.hops !== undefined || req.arrivalSeconds !== undefined)) {
    throw new MultiHopperValidationError(
      "Do not combine hops or arrivalSeconds with route or routeTemplateId",
      "route"
    );
  }

  if (req.hops !== undefined && (req.hops < MIN_HOPS || req.hops > MAX_HOPS)) {
    throw new MultiHopperValidationError(
      `hops must be between ${MIN_HOPS} and ${MAX_HOPS}`,
      "hops"
    );
  }

  if (req.route) {
    const minCustomHops = hasDestinations ? 3 : 2;
    const maxCustomHops = hasDestinations ? 10 : 9;
    if (req.route.hops.length < minCustomHops || req.route.hops.length > maxCustomHops) {
      throw new MultiHopperValidationError(
        `Custom route hops must contain ${minCustomHops}-${maxCustomHops} hops for this transfer mode`,
        "route.hops"
      );
    }
    let totalWait = 0;
    for (let i = 0; i < req.route.hops.length; i++) {
      const hop = req.route.hops[i];
      if (!hop) continue;
      if (!Number.isInteger(hop.waitSeconds) || hop.waitSeconds < MIN_WAIT_SECONDS || hop.waitSeconds > MAX_ARRIVAL_SECONDS) {
        throw new MultiHopperValidationError(
          `route.hops[${i}].waitSeconds must be an integer between ${MIN_WAIT_SECONDS} and ${MAX_ARRIVAL_SECONDS}`,
          "route.hops"
        );
      }
      totalWait += hop.waitSeconds;
    }
    if (totalWait > MAX_ARRIVAL_SECONDS) {
      throw new MultiHopperValidationError(
        `Total route waitSeconds (${totalWait}) exceeds 30-day maximum (${MAX_ARRIVAL_SECONDS})`,
        "route.hops"
      );
    }
  }
}

export class MultiHopperClient {
  public readonly environment: MultiHopperEnvironment;
  public readonly baseUrl: string;
  public readonly keyWarning?: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly generateIdempotencyKey: () => string;

  constructor(options: MultiHopperClientOptions) {
    this.environment = options.environment ?? (options.apiKey.startsWith("mh_live_") ? "mainnet" : "devnet");
    const check = validateApiKeyForEnvironment(
      options.apiKey,
      this.environment,
      options.strictKeyEnvironmentCheck ?? false
    );
    this.keyWarning = check.warning;
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? MULTIHOPPER_BASE_URLS[this.environment]).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 3;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 300;
    this.generateIdempotencyKey = options.generateIdempotencyKey ?? defaultIdempotencyKey;
  }

  private async request<T>(params: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    idempotencyKey?: string;
    requireIdempotency?: boolean;
  }): Promise<T> {
    const url = new URL(`${this.baseUrl}${params.path}`);
    if (params.query) {
      for (const [key, value] of Object.entries(params.query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const isMutation = params.method === "POST" || params.method === "PATCH" || params.method === "DELETE";
    const needsIdempotency = params.requireIdempotency ?? isMutation;
    const stableIdempotencyKey = needsIdempotency
      ? assertValidIdempotencyKey(params.idempotencyKey ?? this.generateIdempotencyKey())
      : undefined;

    let attempt = 0;
    while (true) {
      const headers: Record<string, string> = {
        "x-api-key": this.apiKey
      };
      if (params.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (stableIdempotencyKey) {
        headers["Idempotency-Key"] = stableIdempotencyKey;
      }

      const response = await this.fetchImpl(url.toString(), {
        method: params.method,
        headers,
        body: params.body !== undefined ? JSON.stringify(params.body) : undefined
      });

      const text = await response.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (response.ok) {
        return parsed as T;
      }

      const envelope = (typeof parsed === "object" && parsed !== null ? parsed : {}) as MultiHopperErrorEnvelope;
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      const apiError = new MultiHopperApiError({
        code: envelope.error?.code ?? (response.status === 400 ? "BAD_REQUEST" : "MH_090"),
        message: envelope.error?.message ?? envelope.message ?? `HTTP ${response.status} on ${params.method} ${params.path}`,
        status: response.status,
        requestId: envelope.error?.requestId,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        rawBody: parsed
      });

      if (apiError.isTransient() && attempt < this.maxRetries) {
        attempt++;
        const waitMs =
          apiError.retryAfterSeconds !== undefined
            ? apiError.retryAfterSeconds * 1000
            : this.baseRetryDelayMs * Math.pow(2, attempt - 1);
        await sleep(waitMs);
        continue;
      }

      throw apiError;
    }
  }

  public estimateTransfer(req: EstimateRequest): Promise<EstimateResponse> {
    return this.request<EstimateResponse>({
      method: "POST",
      path: "/transfers/estimate",
      body: req,
      requireIdempotency: false
    });
  }

  public createTransfer(req: CreateTransferRequest, idempotencyKey?: string): Promise<Transfer> {
    validateCreateTransferRequest(req);
    return this.request<Transfer>({
      method: "POST",
      path: "/transfers",
      body: req,
      idempotencyKey
    });
  }

  public prepareTransfer(transferId: number, idempotencyKey?: string): Promise<PrepareTransferResponse> {
    return this.request<PrepareTransferResponse>({
      method: "POST",
      path: `/transfers/${transferId}/prepare`,
      idempotencyKey
    });
  }

  public confirmBroadcast(
    transferId: number,
    body: ConfirmBroadcastRequest,
    idempotencyKey?: string
  ): Promise<ConfirmBroadcastResponse> {
    return this.request<ConfirmBroadcastResponse>({
      method: "POST",
      path: `/transfers/${transferId}/confirm-broadcast`,
      body,
      idempotencyKey
    });
  }

  public getTransfer(transferId: number): Promise<Transfer> {
    return this.request<Transfer>({
      method: "GET",
      path: `/transfers/${transferId}`
    });
  }

  public getTransferByExternalId(externalId: string): Promise<Transfer> {
    return this.request<Transfer>({
      method: "GET",
      path: `/transfers/by-external/${encodeURIComponent(externalId)}`
    });
  }

  public listTransfers(query?: ListTransfersQuery): Promise<ListTransfersResponse> {
    return this.request<ListTransfersResponse>({
      method: "GET",
      path: "/transfers",
      query: query as Record<string, string | number | boolean | undefined>
    });
  }

  public getHopLibrary(query?: HopLibraryQuery): Promise<HopLibraryResponse> {
    return this.request<HopLibraryResponse>({
      method: "GET",
      path: "/hop-library",
      query: query as Record<string, string | number | boolean | undefined>
    });
  }

  public createRouteTemplate(req: CreateRouteTemplateRequest, idempotencyKey?: string): Promise<RouteTemplate> {
    return this.request<RouteTemplate>({
      method: "POST",
      path: "/route-templates",
      body: req,
      idempotencyKey
    });
  }

  public listRouteTemplates(name?: string): Promise<ListRouteTemplatesResponse | RouteTemplate[]> {
    return this.request<ListRouteTemplatesResponse | RouteTemplate[]>({
      method: "GET",
      path: "/route-templates",
      query: name ? { name } : undefined
    });
  }

  public getRouteTemplate(templateId: number): Promise<RouteTemplate> {
    return this.request<RouteTemplate>({
      method: "GET",
      path: `/route-templates/${templateId}`
    });
  }

  public updateRouteTemplate(
    templateId: number,
    req: UpdateRouteTemplateRequest,
    idempotencyKey?: string
  ): Promise<RouteTemplate> {
    return this.request<RouteTemplate>({
      method: "PATCH",
      path: `/route-templates/${templateId}`,
      body: req,
      idempotencyKey
    });
  }

  public deleteRouteTemplate(templateId: number, idempotencyKey?: string): Promise<{ deleted?: boolean }> {
    return this.request<{ deleted?: boolean }>({
      method: "DELETE",
      path: `/route-templates/${templateId}`,
      idempotencyKey
    });
  }

  public getUsage(query?: UsageQuery): Promise<UsageResponse> {
    return this.request<UsageResponse>({
      method: "GET",
      path: "/usage",
      query: query as Record<string, string | number | boolean | undefined>
    });
  }

  public registerWebhook(req: RegisterWebhookRequest, idempotencyKey?: string): Promise<RegisterWebhookResponse> {
    return this.request<RegisterWebhookResponse>({
      method: "POST",
      path: "/webhooks",
      body: req,
      idempotencyKey
    });
  }

  public listWebhooks(): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>({
      method: "GET",
      path: "/webhooks"
    });
  }

  public deleteWebhook(webhookId: number, idempotencyKey?: string): Promise<{ deleted?: boolean }> {
    return this.request<{ deleted?: boolean }>({
      method: "DELETE",
      path: `/webhooks/${webhookId}`,
      idempotencyKey
    });
  }

  public prepareRescue(transferId: number, idempotencyKey?: string): Promise<RescuePrepareResponse> {
    return this.request<RescuePrepareResponse>({
      method: "POST",
      path: `/transfers/${transferId}/rescue/prepare`,
      idempotencyKey
    });
  }

  public confirmRescue(
    transferId: number,
    body: RescueConfirmRequest,
    idempotencyKey?: string
  ): Promise<{ transfer: Transfer }> {
    return this.request<{ transfer: Transfer }>({
      method: "POST",
      path: `/transfers/${transferId}/rescue/confirm`,
      body,
      idempotencyKey
    });
  }
}
