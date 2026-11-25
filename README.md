# HopStream Treasury & Agentic Multi-Send (MultiHopper)

HopStream is a production-structured TypeScript SDK, orchestration state machine, CLI, HMAC-SHA256 webhook receiver, and interactive Vite + React dashboard built for the **MultiHopper** Solana routing protocol.

It enables DAOs, AI agents, and payroll operators to execute privacy-first multi-hop SOL and SPL/USDC payouts—supporting up to 20 destinations per multi-destination route (with automatic batch tranche splitting above 20), saved route templates, custom routes, strict `keeperFundingTx`-first transaction sequencing, and TRM compliance/revenue-share telemetry.

## Architecture

```
src/
├── types/multihopper.ts          # Exact MultiHopper API v1 request/response & program IDs
├── client/
│   ├── errors.ts                 # Structured MH_001–MH_091 error wrapper & predicates
│   └── multihopper.ts            # Typed REST client (devnet/mainnet, Idempotency-Key, retry)
├── orchestrator/
│   ├── signer.ts                 # @solana/web3.js VersionedTransaction + Legacy partialSign + MockSigner
│   └── stateMachine.ts           # Strict keeperFundingTx-first orchestrator & resume loop
├── scheduler/
│   └── batchRunner.ts            # Payroll tranche planner (chunks <=20 destinations/route)
├── webhook/
│   ├── verify.ts                 # Constant-time HMAC-SHA256 x-multihopper-signature verifier
│   ├── server.ts                 # HTTP webhook receiver (/webhooks/multihopper, /events, /health)
│   └── cli.ts                    # Standalone webhook listener entrypoint
├── web/                          # Vite + React dashboard (Composer, Templates, Usage, Webhook UI)
├── cli.ts                        # CLI for estimate, send, status, templates, usage, simulate
└── index.ts                      # Public SDK exports
```

## Protocol Flow Enforced

1. **Preflight Estimate (`POST /api/v1/transfers/estimate`)**: Quotes exact on-chain fee tier (`tier_0`–`tier_9`), 0.50% percent fee, 50/50 integrator revenue share (`integratorPercentShare`), TRM screening fee (`sol.breakdown.screeningFeeLamports`), and `requiredSolUpFrontLamports`.
2. **Create Quote (`POST /api/v1/transfers`)**: Locks fee tier and recipient/destination share commitment (`recipientWallet` XOR `destinations` up to 20 wallets).
3. **Prepare Bundle (`POST /api/v1/transfers/:id/prepare`)**: Retrieves unsigned/partially pre-signed transactions (`keeperFundingTx`, `routeInitTxs`, `orchestratorInitTx`, `sessionInitTxs`, `dispersionInitTxs`) and `resume` state.
4. **Broadcast & Confirm `keeperFundingTx` FIRST**: Signs `keeperFundingTx` (`VersionedTransaction`), confirms on Solana, and immediately calls `POST /api/v1/transfers/:id/confirm-broadcast` with `{ routeInitSignatures: [], keeperFundingSignature }` to prevent double-funding on resume.
5. **Broadcast Remaining Bundle in Strict Order**:
   `routeInitTxs[]` -> `orchestratorInitTx` (legacy `Transaction` via `partialSign`) -> `sessionInitTxs[]` -> `dispersionInitTxs[]`, followed by the final `confirm-broadcast` call (handling `MH_041` dispersion re-checks and blockhash expiry `/prepare` resumes).
6. **TRM Compliance & Settlement**: Polls `GET /api/v1/transfers/:id` or receives signed HMAC-SHA256 webhook events until `completed` (all destinations `paid`) or `refunded`.

## Quickstart

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` (never commit secrets):

```bash
cp .env.example .env
```

### 3. Verify offline tests, typecheck, and build

```bash
npx tsc --noEmit
npm test
npm run build
```

### 4. Run the interactive web dashboard

```bash
npm run dev
```

The dashboard starts with an **Offline Simulator** mode (requiring zero API keys) and switches seamlessly to **Live API** mode (`devnet` or `mainnet`).

### 5. Run the CLI

Run an offline end-to-end orchestration simulation:

```bash
npm run build:lib
npm run cli -- simulate
```

Estimate a devnet transfer:

```bash
MH_ENV=devnet MH_API_KEY=mh_test_... npm run cli -- estimate --mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU --amount 100 --decimals 6 --hops 5 --destinations 3
```
