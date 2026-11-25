import React, { useMemo, useState } from "react";
import { MultiHopperApiError, MultiHopperValidationError } from "../client/errors.js";
import { MultiHopperClient, validateCreateTransferRequest } from "../client/multihopper.js";
import {
  formatRawToTokens,
  parseTokenAmountToRaw,
  planPayrollTranches,
  type PayrollRecipient
} from "../scheduler/batchRunner.js";
import {
  COMMON_SOLANA_MINTS,
  MAX_DESTINATIONS_PER_TRANSFER,
  MULTIHOPPER_BASE_URLS,
  MULTIHOPPER_PROGRAMS,
  type CustomHopSpec,
  type EstimateResponse,
  type HopBundleId,
  type HopLibraryResponse,
  type MultiHopperEnvironment,
  type RouteTemplate,
  type Transfer,
  type UsageResponse,
  type WebhookEventType
} from "../types/multihopper.js";
import {
  ALL_WEBHOOK_EVENTS,
  DEMO_HOP_LIBRARY,
  DEMO_ROUTE_TEMPLATES,
  DEMO_USAGE,
  DEMO_WALLETS,
  buildSimulatedTransfer,
  computeHmacSha256HexBrowser,
  simulateEstimate
} from "./simulator.js";

type ActiveTab = "composer" | "templates" | "telemetry" | "webhooks";
type RoutingMode = "auto" | "template" | "custom";

interface PipelineStage {
  id: string;
  title: string;
  detail: string;
  status: "pending" | "active" | "done";
  signature?: string;
}

const INITIAL_PIPELINE: PipelineStage[] = [
  { id: "estimate", title: "1. POST /transfers/estimate", detail: "Fee tier, 50/50 rev-share & TRM budget", status: "pending" },
  { id: "create", title: "2. POST /transfers", detail: "Lock quote & destination share commitment", status: "pending" },
  { id: "prepare", title: "3. POST /transfers/:id/prepare", detail: "Fetch VersionedTransaction + legacy bundles", status: "pending" },
  { id: "keeper", title: "4. keeperFundingTx FIRST -> confirm-broadcast", detail: "Fund keeper & record signature before routeInit", status: "pending" },
  { id: "bundle", title: "5. route -> orchestrator -> session -> dispersion", detail: "Broadcast in strict order + confirm-broadcast", status: "pending" },
  { id: "settle", title: "6. TRM Verify & Destination Payouts", detail: "Poll GET /transfers/:id until settled", status: "pending" }
];

function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(6);
}

export function App(): React.ReactElement {
  const [environment, setEnvironment] = useState<MultiHopperEnvironment>("devnet");
  const [mode, setMode] = useState<"simulator" | "live">("simulator");
  const [apiKey, setApiKey] = useState<string>("mh_test_demo_sandbox_key");
  const [activeTab, setActiveTab] = useState<ActiveTab>("composer");

  // Composer state
  const [tokenKey, setTokenKey] = useState<"USDC" | "USDC_DEVNET" | "SOL">("USDC_DEVNET");
  const [sourceOwner, setSourceOwner] = useState<string>(DEMO_WALLETS.treasury);
  const [recipients, setRecipients] = useState<PayrollRecipient[]>(DEMO_WALLETS.contributors);
  const [routingMode, setRoutingMode] = useState<RoutingMode>("auto");
  const [hops, setHops] = useState<number>(5);
  const [arrivalSeconds, setArrivalSeconds] = useState<number>(300);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number>(5);
  const [customHops, setCustomHops] = useState<CustomHopSpec[]>([
    { bundle: "cex", waitSeconds: 120 },
    { wallet: "DQTf1yf1YM4B48PqJyQ53SEWGDM6ib4YBV7P3wm2MCxj", waitSeconds: 300 },
    { bundle: "kol", waitSeconds: 600 }
  ]);
  const [externalId, setExternalId] = useState<string>("hopstream-payroll-001");

  // Quote & execution state
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [activeTransfer, setActiveTransfer] = useState<Transfer | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStage[]>(INITIAL_PIPELINE);
  const [logs, setLogs] = useState<string[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  // Templates & Hop Library state
  const [templates, setTemplates] = useState<RouteTemplate[]>(DEMO_ROUTE_TEMPLATES);
  const [hopLibrary, setHopLibrary] = useState<HopLibraryResponse>(DEMO_HOP_LIBRARY);
  const [newTemplateName, setNewTemplateName] = useState<string>("dao-biweekly-payroll");
  const [newTemplateDesc, setNewTemplateDesc] = useState<string>("3-hop privacy pipeline for contributor payouts");

  // Usage state
  const [usage, setUsage] = useState<UsageResponse>(DEMO_USAGE);

  // Webhook inspector state
  const [webhookSecret, setWebhookSecret] = useState<string>("whsec_demo_hopstream_secret_2026");
  const [webhookEvent, setWebhookEvent] = useState<WebhookEventType>("transfer.completed");
  const [webhookPayloadText, setWebhookPayloadText] = useState<string>(
    JSON.stringify(
      {
        id: "evt_019a2f",
        event: "transfer.completed",
        timestamp: "2026-11-25T16:00:00.000Z",
        data: {
          transferId: 1042,
          externalId: "hopstream-payroll-001",
          status: "completed",
          phase: "settled",
          destinationCount: 4
        }
      },
      null,
      2
    )
  );
  const [webhookSignatureInput, setWebhookSignatureInput] = useState<string>("");
  const [webhookVerifyResult, setWebhookVerifyResult] = useState<{ ok: boolean; expected: string } | null>(null);

  const selectedMint = COMMON_SOLANA_MINTS[tokenKey];

  const client = useMemo(() => {
    if (mode !== "live") return null;
    try {
      return new MultiHopperClient({
        apiKey,
        environment
      });
    } catch {
      return null;
    }
  }, [apiKey, environment, mode]);

  const plannedTranches = useMemo(() => {
    try {
      return planPayrollTranches({
        environment,
        tokenMint: selectedMint.mint,
        tokenDecimals: selectedMint.decimals,
        tokenSymbol: selectedMint.symbol,
        sourceOwner,
        recipients,
        hops: routingMode === "auto" ? hops : undefined,
        arrivalSeconds: routingMode === "auto" ? arrivalSeconds : undefined,
        route: routingMode === "custom" ? { hops: customHops } : undefined,
        routeTemplateId: routingMode === "template" ? selectedTemplateId : undefined,
        externalIdPrefix: externalId || "hopstream"
      });
    } catch {
      return [];
    }
  }, [
    arrivalSeconds,
    customHops,
    environment,
    externalId,
    hops,
    recipients,
    routingMode,
    selectedMint,
    selectedTemplateId,
    sourceOwner
  ]);

  const totalBatchTokens = useMemo(() => {
    return recipients
      .reduce((acc, r) => acc + (Number(r.amountTokens) || 0), 0)
      .toFixed(selectedMint.decimals === 9 ? 4 : 2);
  }, [recipients, selectedMint.decimals]);

  const appendLog = (line: string) => {
    setLogs((prev) => [`[${new Date().toISOString().slice(11, 19)}] ${line}`, ...prev]);
  };

  const updateStage = (id: string, patch: Partial<PipelineStage>) => {
    setPipeline((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const handleEstimate = async () => {
    setErrorBanner(null);
    setBusy(true);
    try {
      const primary = plannedTranches[0];
      if (!primary) {
        throw new MultiHopperValidationError("Fix recipient wallets and positive amounts before quoting.");
      }
      validateCreateTransferRequest(primary.request);

      const estReq = {
        tokenMint: primary.request.tokenMint,
        amountRaw: primary.request.amountRaw,
        tokenDecimals: primary.request.tokenDecimals,
        hops: primary.request.hops,
        destinationCount: primary.request.destinations?.length,
        arrivalSeconds: primary.request.arrivalSeconds,
        route: primary.request.route,
        routeTemplateId: primary.request.routeTemplateId
      };

      const res =
        mode === "live" && client
          ? await client.estimateTransfer(estReq)
          : simulateEstimate(estReq, environment, tokenKey === "SOL" ? 160 : 1);

      setEstimate(res);
      updateStage("estimate", {
        status: "done",
        detail: `${res.tier} | rev-share ${formatRawToTokens(res.integratorPercentShare, selectedMint.decimals)} ${selectedMint.symbol}`
      });
      appendLog(
        `Estimated tranche #1 (${recipients.length} destinations): tier=${res.tier}, screening=${res.sol.breakdown.screeningFeeLamports} lamports, upfront=${lamportsToSol(res.sol.requiredSolUpFrontLamports)} SOL`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      appendLog(`Estimate error: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateFullPipeline = async () => {
    setErrorBanner(null);
    setBusy(true);
    setPipeline(INITIAL_PIPELINE);

    try {
      const primary = plannedTranches[0];
      if (!primary) {
        throw new MultiHopperValidationError("Provide at least 1 valid recipient with distinct wallet and positive amount.");
      }
      validateCreateTransferRequest(primary.request);

      // 1. Estimate
      updateStage("estimate", { status: "active" });
      const est = simulateEstimate(
        {
          tokenMint: primary.request.tokenMint,
          amountRaw: primary.request.amountRaw,
          tokenDecimals: primary.request.tokenDecimals,
          hops: primary.request.hops,
          destinationCount: primary.request.destinations?.length,
          arrivalSeconds: primary.request.arrivalSeconds,
          route: primary.request.route,
          routeTemplateId: primary.request.routeTemplateId
        },
        environment,
        tokenKey === "SOL" ? 160 : 1
      );
      setEstimate(est);
      updateStage("estimate", { status: "done", detail: `Quoted ${est.tier} (${est.priceSource})` });
      appendLog(`Stage 1: /transfers/estimate -> ${est.tier}, upfront=${lamportsToSol(est.sol.requiredSolUpFrontLamports)} SOL`);

      await new Promise((r) => setTimeout(r, 250));

      // 2. Create
      updateStage("create", { status: "active" });
      const created = buildSimulatedTransfer(primary.request, est, environment);
      setActiveTransfer(created);
      updateStage("create", { status: "done", detail: `Transfer #${created.id} (${created.status})` });
      appendLog(`Stage 2: POST /transfers -> id=${created.id}, net=${created.recipientReceivesRaw}`);

      await new Promise((r) => setTimeout(r, 250));

      // 3. Prepare
      updateStage("prepare", { status: "active" });
      updateStage("prepare", { status: "done", detail: "keeperFundingTx + routeInitTxs + orchestratorInitTx + sessionInitTxs + dispersionInitTxs" });
      appendLog(`Stage 3: POST /transfers/${created.id}/prepare -> blockhash ready (~60s window)`);

      await new Promise((r) => setTimeout(r, 250));

      // 4. Keeper Funding First
      updateStage("keeper", { status: "active" });
      const keeperSig = "5kEpR9vQmN2zX7yW4bA8cD1eF3gH6jK9mP2rT5vY8zB1";
      updateStage("keeper", { status: "done", signature: keeperSig, detail: "keeperFundingTx confirmed & recorded FIRST" });
      appendLog(`Stage 4: keeperFundingTx confirmed -> confirm-broadcast({ routeInitSignatures: [], keeperFundingSignature })`);

      await new Promise((r) => setTimeout(r, 250));

      // 5. Ordered Route Bundle
      updateStage("bundle", { status: "active" });
      const bundleSig = "2rOuTe7mN1KqQe6aLmQv4bKm3Nv8Qz9rTpWx2aJs8d";
      setActiveTransfer((prev) => (prev ? { ...prev, status: "processing", phase: "executing" } : prev));
      updateStage("bundle", { status: "done", signature: bundleSig, detail: "All bundle groups confirmed on-chain" });
      appendLog(`Stage 5: routeInitTxs -> orchestratorInitTx -> sessionInitTxs -> dispersionInitTxs -> final confirm-broadcast`);

      await new Promise((r) => setTimeout(r, 300));

      // 6. TRM Screening & Destination Settlement
      updateStage("settle", { status: "active" });
      setActiveTransfer((prev) =>
        prev
          ? {
              ...prev,
              status: "completed",
              phase: "settled",
              progress: { hopsCompleted: prev.hops ?? 5, hopsTotal: prev.hops ?? 5 },
              destinations: prev.destinations?.map((d, idx) => ({
                ...d,
                status: "paid",
                payoutSignature: `pay${idx + 1}KpQr3z7nKpQr3z4mGxFn7m`,
                paidAt: new Date().toISOString()
              }))
            }
          : prev
      );
      updateStage("settle", { status: "done", detail: "TRM verified; all destination payouts completed" });
      appendLog(`Stage 6: TRM compliance verified -> transfer.completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorBanner(msg);
      appendLog(`Pipeline error: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const handleLoadLiveResources = async () => {
    if (!client) {
      setErrorBanner("Switch to Live API mode and provide a valid mh_test_ or mh_live_ API key.");
      return;
    }
    setBusy(true);
    setErrorBanner(null);
    try {
      const [tplRes, usageRes] = await Promise.all([
        client.listRouteTemplates(),
        client.getUsage()
      ]);
      setTemplates(Array.isArray(tplRes) ? tplRes : tplRes.items);
      setUsage(usageRes);
      try {
        const libRes = await client.getHopLibrary();
        setHopLibrary(libRes);
      } catch (libErr) {
        if (libErr instanceof MultiHopperApiError && libErr.isDevnetLibraryUnavailable()) {
          appendLog("GET /hop-library returned MH_019 (expected on devnet; library only served on mainnet).");
        } else {
          throw libErr;
        }
      }
      appendLog("Synced live Route Templates and Usage telemetry from MultiHopper API.");
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTemplate = async () => {
    setErrorBanner(null);
    if (!newTemplateName.trim()) {
      setErrorBanner("Template name is required.");
      return;
    }
    if (mode === "live" && client) {
      try {
        const created = await client.createRouteTemplate({
          name: newTemplateName.trim(),
          description: newTemplateDesc.trim() || null,
          route: { hops: customHops }
        });
        setTemplates((prev) => [created, ...prev]);
        appendLog(`Created live route template #${created.id} (${created.name}).`);
      } catch (err) {
        setErrorBanner(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const totalWait = customHops.reduce((acc, h) => acc + h.waitSeconds, 0);
    const localTpl: RouteTemplate = {
      id: Math.floor(10 + Math.random() * 89),
      name: newTemplateName.trim(),
      description: newTemplateDesc.trim() || null,
      route: { hops: customHops },
      arrivalSeconds: totalWait,
      usableFor: { recipientWallet: true, destinations: true },
      problems: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setTemplates((prev) => [localTpl, ...prev]);
    appendLog(`Saved simulated route template '${localTpl.name}' (arrival ${totalWait}s).`);
  };

  const handleSignAndVerifyWebhook = async () => {
    const expected = await computeHmacSha256HexBrowser(webhookPayloadText, webhookSecret);
    const sigToCheck = webhookSignatureInput.trim() || expected;
    if (!webhookSignatureInput.trim()) {
      setWebhookSignatureInput(expected);
    }
    setWebhookVerifyResult({
      ok: sigToCheck.toLowerCase() === expected.toLowerCase(),
      expected
    });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1 className="brand-title">HopStream Treasury &amp; Agentic Multi-Send</h1>
          <p className="brand-subtitle">
            MultiHopper v1 Protocol Orchestrator · Base URL{" "}
            <span className="mono">{MULTIHOPPER_BASE_URLS[environment]}</span> · Core{" "}
            <span className="mono">{MULTIHOPPER_PROGRAMS.core.slice(0, 8)}...</span>
          </p>
        </div>

        <div className="controls-bar">
          <div className="pill-toggle" role="group" aria-label="Execution Mode">
            <button
              type="button"
              className={mode === "simulator" ? "active" : ""}
              onClick={() => setMode("simulator")}
            >
              Offline Simulator
            </button>
            <button
              type="button"
              className={mode === "live" ? "active" : ""}
              onClick={() => setMode("live")}
            >
              Live API
            </button>
          </div>

          <div className="pill-toggle" role="group" aria-label="Solana Cluster">
            <button
              type="button"
              className={environment === "devnet" ? "active" : ""}
              onClick={() => setEnvironment("devnet")}
            >
              Devnet (mh_test_)
            </button>
            <button
              type="button"
              className={environment === "mainnet" ? "active" : ""}
              onClick={() => setEnvironment("mainnet")}
            >
              Mainnet (mh_live_)
            </button>
          </div>

          {mode === "live" && (
            <input
              type="password"
              className="input mono"
              style={{ width: 220 }}
              placeholder={environment === "devnet" ? "mh_test_..." : "mh_live_..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </div>
      </header>

      {environment === "mainnet" ? (
        <div className="alert alert-warn">
          <strong>Mainnet TRM Compliance Gate Active:</strong> Every screened wallet (sourceOwner, hops, destinations)
          incurs 0.002 SOL upfront inside <span className="mono">orchestratorInitTx</span> (non-refundable). Mainnet{" "}
          <span className="mono">mh_live_</span> access also requires meeting MultiHopper&apos;s onboarding criteria.
        </div>
      ) : (
        <div className="alert">
          <strong>Devnet Mode Active:</strong> Use <span className="mono">mh_test_</span> keys from{" "}
          <span className="mono">devnet.multihopper.com/developer/dashboard</span>. Note: <span className="mono">GET /hop-library</span>{" "}
          and <span className="mono">bundle</span> hops return <span className="mono">MH_019</span> on devnet — supply explicit wallet addresses when running live on devnet.
        </div>
      )}

      {errorBanner && <div className="alert alert-err">{errorBanner}</div>}

      <nav className="nav-tabs">
        <button
          type="button"
          className={`nav-tab ${activeTab === "composer" ? "active" : ""}`}
          onClick={() => setActiveTab("composer")}
        >
          Multi-Send Composer &amp; Sequencer
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "templates" ? "active" : ""}`}
          onClick={() => setActiveTab("templates")}
        >
          Route Templates &amp; Hop Library
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "telemetry" ? "active" : ""}`}
          onClick={() => setActiveTab("telemetry")}
        >
          Usage &amp; 50/50 Revenue Share
        </button>
        <button
          type="button"
          className={`nav-tab ${activeTab === "webhooks" ? "active" : ""}`}
          onClick={() => setActiveTab("webhooks")}
        >
          HMAC Webhook Verifier
        </button>
      </nav>

      {activeTab === "composer" && (
        <div className="grid-2">
          <div className="card">
            <h2>Treasury Multi-Destination Batch ({recipients.length}/{MAX_DESTINATIONS_PER_TRANSFER} per tranche)</h2>

            <div className="field-row">
              <div className="field">
                <label>Token Asset</label>
                <select
                  className="select"
                  value={tokenKey}
                  onChange={(e) => setTokenKey(e.target.value as "USDC" | "USDC_DEVNET" | "SOL")}
                >
                  <option value="USDC_DEVNET">USDC (Devnet)</option>
                  <option value="USDC">USDC (Mainnet)</option>
                  <option value="SOL">Native SOL</option>
                </select>
              </div>
              <div className="field">
                <label>External Idempotency ID</label>
                <input
                  className="input mono"
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Routing Strategy</label>
                <select
                  className="select"
                  value={routingMode}
                  onChange={(e) => setRoutingMode(e.target.value as RoutingMode)}
                >
                  <option value="auto">Auto Hops (3–10)</option>
                  <option value="template">Saved Route Template</option>
                  <option value="custom">Custom Route Hops</option>
                </select>
              </div>
            </div>

            <div className="field" style={{ marginBottom: 12 }}>
              <label>Source Owner Wallet (Signer &amp; Fee Payer)</label>
              <input
                className="input mono"
                value={sourceOwner}
                onChange={(e) => setSourceOwner(e.target.value)}
              />
            </div>

            {routingMode === "auto" && (
              <div className="field-row">
                <div className="field">
                  <label>Abstraction Hops (3–10)</label>
                  <input
                    type="number"
                    min={3}
                    max={10}
                    className="input"
                    value={hops}
                    onChange={(e) => setHops(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Arrival Window (seconds, 60–2592000)</label>
                  <input
                    type="number"
                    min={60}
                    max={2592000}
                    className="input"
                    value={arrivalSeconds}
                    onChange={(e) => setArrivalSeconds(Number(e.target.value))}
                  />
                </div>
              </div>
            )}

            {routingMode === "template" && (
              <div className="field" style={{ marginBottom: 12 }}>
                <label>Route Template ID</label>
                <select
                  className="select"
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(Number(e.target.value))}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      #{t.id} — {t.name} ({t.route.hops.length} hops, {t.arrivalSeconds}s)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {routingMode === "custom" && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>Custom Route Hops (min wait 20s)</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setCustomHops((prev) => [...prev, { bundle: "mix", waitSeconds: 180 }])
                    }
                  >
                    + Add Hop
                  </button>
                </div>
                {customHops.map((h, idx) => (
                  <div key={idx} className="field-row" style={{ marginBottom: 8 }}>
                    <div className="field">
                      <select
                        className="select"
                        value={"bundle" in h ? `bundle:${h.bundle}` : "wallet"}
                        onChange={(e) => {
                          const val = e.target.value;
                          setCustomHops((prev) =>
                            prev.map((item, i) => {
                              if (i !== idx) return item;
                              if (val.startsWith("bundle:")) {
                                return {
                                  bundle: val.replace("bundle:", "") as HopBundleId,
                                  waitSeconds: item.waitSeconds
                                };
                              }
                              return {
                                wallet: "DQTf1yf1YM4B48PqJyQ53SEWGDM6ib4YBV7P3wm2MCxj",
                                waitSeconds: item.waitSeconds
                              };
                            })
                          );
                        }}
                      >
                        <option value="bundle:cex">Bundle: CEX</option>
                        <option value="bundle:dex">Bundle: DEX</option>
                        <option value="bundle:exchanges">Bundle: Exchanges</option>
                        <option value="bundle:kol">Bundle: KOL</option>
                        <option value="bundle:contracts">Bundle: Contracts (middle only)</option>
                        <option value="bundle:mix">Bundle: Mix</option>
                        <option value="wallet">Named Wallet</option>
                      </select>
                    </div>
                    {"wallet" in h && (
                      <div className="field">
                        <input
                          className="input mono"
                          value={h.wallet}
                          onChange={(e) => {
                            const w = e.target.value;
                            setCustomHops((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { wallet: w, waitSeconds: item.waitSeconds } : item
                              )
                            );
                          }}
                        />
                      </div>
                    )}
                    <div className="field">
                      <input
                        type="number"
                        min={20}
                        className="input"
                        value={h.waitSeconds}
                        onChange={(e) => {
                          const waitSeconds = Number(e.target.value);
                          setCustomHops((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, waitSeconds } : item))
                          );
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "14px 0 8px" }}>
              <strong>
                Destinations — Total {totalBatchTokens} {selectedMint.symbol} ({plannedTranches.length} tranche)
              </strong>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setRecipients((prev) => [
                    ...prev,
                    {
                      label: `Recipient ${prev.length + 1}`,
                      wallet: "",
                      amountTokens: "100"
                    }
                  ])
                }
              >
                + Add Recipient
              </button>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Solana Wallet</th>
                  <th style={{ width: 110 }}>Amount ({selectedMint.symbol})</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {recipients.map((r, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        className="input"
                        style={{ width: "100%" }}
                        value={r.label ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRecipients((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, label: val } : item))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="input mono"
                        style={{ width: "100%" }}
                        placeholder="Solana pubkey"
                        value={r.wallet}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRecipients((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, wallet: val } : item))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="input mono"
                        style={{ width: "100%" }}
                        value={r.amountTokens}
                        onChange={(e) => {
                          const val = e.target.value;
                          setRecipients((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, amountTokens: val } : item))
                          );
                        }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={recipients.length <= 1}
                        onClick={() => setRecipients((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        Del
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={handleEstimate}>
                Quote Fees &amp; TRM Screening
              </button>
              <button
                type="button"
                className="btn btn-emerald"
                disabled={busy || mode === "live"}
                title={mode === "live" ? "Use CLI with SOLANA_PRIVATE_KEY for live tx signing" : ""}
                onClick={handleSimulateFullPipeline}
              >
                Run Simulated Multi-Hop Pipeline
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="card">
              <h2>Fee Quote &amp; Revenue Share</h2>
              {!estimate ? (
                <p className="muted">
                  Click <strong>Quote Fees &amp; TRM Screening</strong> to inspect tier selection, SOL upfront rent,
                  TRM compliance fee, and 50/50 integrator revenue share.
                </p>
              ) : (
                <div className="grid-3">
                  <div>
                    <div className="muted">Fee Tier</div>
                    <div className="kpi-value">{estimate.tier}</div>
                    <div className="muted">{estimate.percentFeeBps / 100}% ({estimate.priceSource})</div>
                  </div>
                  <div>
                    <div className="muted">Your 50% Share</div>
                    <div className="kpi-value" style={{ color: "var(--emerald)" }}>
                      {formatRawToTokens(estimate.integratorPercentShare, selectedMint.decimals)} {selectedMint.symbol}
                    </div>
                    <div className="muted">Atomic on-chain payout</div>
                  </div>
                  <div>
                    <div className="muted">Upfront SOL Budget</div>
                    <div className="kpi-value">{lamportsToSol(estimate.sol.requiredSolUpFrontLamports)}</div>
                    <div className="muted">
                      TRM: {lamportsToSol(estimate.sol.breakdown.screeningFeeLamports)} · Refundable:{" "}
                      {lamportsToSol(estimate.sol.refundableLamports)}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <h2>Strict Sequencing State Machine</h2>
              <div className="pipeline-list">
                {pipeline.map((stage) => (
                  <div key={stage.id} className={`pipeline-step ${stage.status}`}>
                    <div>
                      <div style={{ fontWeight: 600 }}>{stage.title}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {stage.detail}
                      </div>
                      {stage.signature && (
                        <div className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>
                          sig: {stage.signature}
                        </div>
                      )}
                    </div>
                    <span
                      className={`badge ${
                        stage.status === "done"
                          ? "badge-ok"
                          : stage.status === "active"
                            ? "badge-info"
                            : "badge-warn"
                      }`}
                    >
                      {stage.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {activeTransfer && activeTransfer.destinations && (
              <div className="card">
                <h3>
                  Transfer #{activeTransfer.id} Payouts{" "}
                  <span className="badge badge-ok">{activeTransfer.status}</span>
                </h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Wallet</th>
                      <th>Net Raw</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeTransfer.destinations.map((d) => (
                      <tr key={d.wallet}>
                        <td className="mono">{d.wallet.slice(0, 10)}...</td>
                        <td className="mono">{d.amountRaw}</td>
                        <td>
                          <span className={`badge ${d.status === "paid" ? "badge-ok" : "badge-warn"}`}>
                            {d.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="card">
              <h3>Execution Telemetry Log</h3>
              <div className="log-box">
                {logs.length === 0 ? (
                  <div className="muted">No events recorded yet.</div>
                ) : (
                  logs.map((line, i) => <div key={i}>{line}</div>)
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "templates" && (
        <div className="grid-2">
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Saved Route Templates ({templates.length}/100)</h2>
              {mode === "live" && (
                <button type="button" className="btn" onClick={handleLoadLiveResources} disabled={busy}>
                  Sync from Live API
                </button>
              )}
            </div>

            <div className="field-row">
              <div className="field">
                <label>Template Name</label>
                <input
                  className="input"
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Description</label>
                <input
                  className="input"
                  value={newTemplateDesc}
                  onChange={(e) => setNewTemplateDesc(e.target.value)}
                />
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={handleSaveTemplate} style={{ marginBottom: 16 }}>
              Save Current Custom Route as Template
            </button>

            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Hops / Arrival</th>
                  <th>Usable For</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">#{t.id}</td>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="muted">{t.description}</div>
                    </td>
                    <td className="mono">
                      {t.route.hops.length} hops / {t.arrivalSeconds}s
                    </td>
                    <td>
                      <span className="badge badge-ok">
                        {t.usableFor.destinations ? "single + multi-dest" : "single"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Vetted Hop Library ({hopLibrary.bundles.length} bundles)</h2>
            <p className="muted">
              Available on mainnet (<span className="mono">GET /api/v1/hop-library</span>). Returns{" "}
              <span className="mono">MH_019</span> on devnet.
            </p>
            <div className="grid-3" style={{ marginBottom: 14 }}>
              {hopLibrary.bundles.map((b) => (
                <div key={b.id} className="pipeline-step">
                  <div>
                    <div className="mono" style={{ fontWeight: 700 }}>{b.id}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{b.categories.join(", ")}</div>
                  </div>
                  <span className="badge badge-info">{b.available}</span>
                </div>
              ))}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Category</th>
                  <th>Address</th>
                  <th>Can End Route</th>
                </tr>
              </thead>
              <tbody>
                {hopLibrary.wallets.map((w) => (
                  <tr key={w.address}>
                    <td>{w.label}</td>
                    <td><span className="badge badge-info">{w.category}</span></td>
                    <td className="mono">{w.address.slice(0, 12)}...</td>
                    <td>{w.canEndRoute ? "yes" : "middle only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "telemetry" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>Integrator Usage &amp; Atomic Revenue Share</h2>
            {mode === "live" && (
              <button type="button" className="btn" onClick={handleLoadLiveResources} disabled={busy}>
                Refresh Live /usage
              </button>
            )}
          </div>
          <div className="grid-3" style={{ marginBottom: 16 }}>
            <div className="pipeline-step">
              <div>
                <div className="muted">Total / Completed Transfers</div>
                <div className="kpi-value">
                  {usage.completedTransfers} / {usage.totalTransfers}
                </div>
              </div>
              <span className="badge badge-ok">{usage.failedTransfers} failed</span>
            </div>
            <div className="pipeline-step">
              <div>
                <div className="muted">SOL Revenue Share Earned</div>
                <div className="kpi-value">{lamportsToSol(usage.totalFlatFeeEarned)} SOL</div>
              </div>
              <span className="badge badge-info">{usage.totalPayouts} payouts</span>
            </div>
            <div className="pipeline-step">
              <div>
                <div className="muted">USDC Percent Share Earned</div>
                <div className="kpi-value" style={{ color: "var(--emerald)" }}>
                  {usage.tokenFeesEarned[0]
                    ? formatRawToTokens(usage.tokenFeesEarned[0].amountRaw, usage.tokenFeesEarned[0].tokenDecimals)
                    : "0"}{" "}
                  USDC
                </div>
              </div>
              <span className="badge badge-info">{usage.isTestMode ? "test mode" : "live mode"}</span>
            </div>
          </div>
          <p className="muted">
            MultiHopper splits the 0.50% percent fee 50/50 atomically inside route creation directly to your
            registered rewards wallet (which must hold rent-exempt minimum SOL).
          </p>
        </div>
      )}

      {activeTab === "webhooks" && (
        <div className="grid-2">
          <div className="card">
            <h2>HMAC-SHA256 Webhook Inspector</h2>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Webhook Secret (whsec_...)</label>
              <input
                className="input mono"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Event Type</label>
              <select
                className="select mono"
                value={webhookEvent}
                onChange={(e) => {
                  const ev = e.target.value as WebhookEventType;
                  setWebhookEvent(ev);
                  setWebhookPayloadText(
                    JSON.stringify(
                      {
                        id: "evt_019a2f",
                        event: ev,
                        timestamp: new Date().toISOString(),
                        data: { transferId: 1042, status: "processing" }
                      },
                      null,
                      2
                    )
                  );
                }}
              >
                {ALL_WEBHOOK_EVENTS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>Raw JSON Payload</label>
              <textarea
                rows={9}
                className="textarea mono"
                value={webhookPayloadText}
                onChange={(e) => setWebhookPayloadText(e.target.value)}
              />
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label>x-multihopper-signature Header (leave empty to auto-sign)</label>
              <input
                className="input mono"
                placeholder="64-char hex HMAC-SHA256"
                value={webhookSignatureInput}
                onChange={(e) => setWebhookSignatureInput(e.target.value)}
              />
            </div>
            <button type="button" className="btn btn-primary" onClick={handleSignAndVerifyWebhook}>
              Sign &amp; Verify Signature
            </button>
          </div>

          <div className="card">
            <h2>Verification Output</h2>
            {!webhookVerifyResult ? (
              <p className="muted">
                Test <span className="mono">x-multihopper-signature</span> verification against raw request bytes.
              </p>
            ) : (
              <div>
                <div className={`alert ${webhookVerifyResult.ok ? "" : "alert-err"}`}>
                  <strong>Status:</strong>{" "}
                  {webhookVerifyResult.ok ? "VALID HMAC-SHA256 SIGNATURE" : "SIGNATURE MISMATCH"}
                </div>
                <div className="field">
                  <label>Expected HMAC-SHA256 Digest</label>
                  <div className="log-box">{webhookVerifyResult.expected}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
