# HopStream Submission & Onboarding Guide

This guide covers end-to-end testing on MultiHopper Devnet, transitioning to Mainnet production, and validating the HopStream deliverable for the MultiHopper Build & Route Challenge.

## 1. Environment Matrix

MultiHopper runs two completely isolated deployments. API keys, route templates, and transfers from one environment do not exist in the other:

| Environment | Base URL | Developer Dashboard | API Key Prefix | Solana Cluster |
| - | - | - | - | - |
| Devnet (Testing) | `https://devnet.multihopper.com/api/v1` | `https://devnet.multihopper.com/developer/dashboard` | `mh_test_...` | `devnet` |
| Mainnet (Production) | `https://multihopper.com/api/v1` | `https://multihopper.com/developer/dashboard` | `mh_live_...` | `mainnet-beta` |

## 2. Devnet Testing Workflow (`mh_test_...`)

1. Mint a test API key (`mh_test_...`) from `https://devnet.multihopper.com/developer/dashboard`.
2. Fund your `sourceOwner` wallet with devnet SOL (for upfront rent, transaction fees, and protocol flat fees) and devnet SPL tokens if testing SPL routes.
3. Ensure your **registered rewards wallet** holds at least the Solana rent-exempt minimum for an empty account (`getMinimumBalanceForRentExemption(0)`), otherwise `/prepare` returns `MH_091` because small atomic revenue-share credits cannot initialize a brand-new account.
4. Note the **Devnet Hop Library rule (`MH_019`)**: `GET /api/v1/hop-library` and `{ "bundle": ... }` custom hops are not served on devnet. When testing custom routes on devnet, supply explicit `{ "wallet": "<address>", "waitSeconds": <seconds> }` entries or use auto-routing (`hops` + `arrivalSeconds`).
5. Run the CLI or dashboard in `devnet` mode:
   - `POST /api/v1/transfers/estimate`
   - `POST /api/v1/transfers`
   - `POST /api/v1/transfers/:id/prepare`
   - Sign + confirm `keeperFundingTx` first -> immediate `confirm-broadcast`
   - Sign + confirm remaining bundle -> final `confirm-broadcast`

## 3. Mainnet Onboarding & $100k Volume Requirement (`mh_live_...`)

Before promoting HopStream from devnet to production (`https://multihopper.com/api/v1` with `mh_live_...`):

1. **Mainnet Volume & Revenue Share Threshold ($100k Rule)**:
   - Integrators must achieve or commit to the **$100,000+ USD mainnet routing volume requirement** (per MultiHopper mainnet onboarding / Build & Route Challenge qualification criteria) to unlock full mainnet `mh_live_...` production integration status and ongoing **0.25% / 50-50 integrator revenue share** (`integratorPercentShare`, half of the 0.50% protocol percent fee paid atomically on-chain to your rewards wallet).
   - Monitor live cumulative volume and fee credits via `GET /api/v1/usage` (`totalVolumeRaw`, `totalFlatFeeEarned`, `tokenFeesEarned`, `totalPayouts`).
2. **TRM Compliance Screening Budget (Mainnet Gate Active)**:
   - On mainnet, MultiHopper's keeper screens `sourceOwner`, every intermediate hop, the final recipient, and every multi-destination payout wallet on-chain before funds move.
   - `/prepare` charges **0.002 SOL per screened wallet** inside `orchestratorInitTx` (and a second screen for payouts executing more than ~6 hours after route start).
   - Always pass `arrivalSeconds` and `destinationCount` to `POST /api/v1/transfers/estimate` and verify `sourceOwner` holds `sol.requiredSolUpFrontLamports` plus the transfer principal. The screening fee is non-refundable even if a wallet is flagged (`status: "refunded"`).
3. **Webhook Secret Management**:
   - Register your HTTPS endpoint via `POST /api/v1/webhooks` and store the returned `whsec_...` secret (shown once) in `MH_WEBHOOK_SECRET`.
   - Always verify `x-multihopper-signature` against raw request bytes with constant-time comparison (`src/webhook/verify.ts`).

## 4. Offline Verification Checklist

Run these deterministic checks before submitting:

```bash
npm install
npx tsc --noEmit
npm test
npm run build
```

All four commands must exit with code `0`, and all repository files must retain Unix LF (`\n`) line endings.
