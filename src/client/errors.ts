import type { MultiHopperErrorCode } from "../types/multihopper.js";

export interface MultiHopperErrorEnvelope {
  error?: {
    code?: MultiHopperErrorCode;
    message?: string;
    requestId?: string;
  };
  message?: string;
}

export class MultiHopperApiError extends Error {
  public readonly code: MultiHopperErrorCode;
  public readonly status: number;
  public readonly requestId?: string;
  public readonly retryAfterSeconds?: number;
  public readonly rawBody?: unknown;

  constructor(params: {
    code: MultiHopperErrorCode;
    message: string;
    status: number;
    requestId?: string;
    retryAfterSeconds?: number;
    rawBody?: unknown;
  }) {
    super(`[${params.code}] (${params.status}) ${params.message}`);
    this.name = "MultiHopperApiError";
    this.code = params.code;
    this.status = params.status;
    this.requestId = params.requestId;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.rawBody = params.rawBody;
  }

  public isRateLimited(): boolean {
    return this.status === 429 || this.code === "MH_004";
  }

  public isTransient(): boolean {
    return (
      this.isRateLimited() ||
      this.status === 500 ||
      this.status === 503 ||
      this.code === "MH_090" ||
      this.code === "MH_091"
    );
  }

  public isStaleQuote(): boolean {
    return this.code === "MH_040";
  }

  public isMissingDispersion(): boolean {
    return this.code === "MH_041";
  }

  public isDevnetLibraryUnavailable(): boolean {
    return this.code === "MH_019";
  }
}

export class MultiHopperValidationError extends Error {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "MultiHopperValidationError";
    this.field = field;
  }
}
