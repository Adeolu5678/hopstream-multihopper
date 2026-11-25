import { startWebhookServer } from "./server.js";

async function main(): Promise<void> {
  const secret = process.env.MH_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("MH_WEBHOOK_SECRET environment variable is required");
  }
  const port = Number(process.env.WEBHOOK_PORT ?? 8787);
  const host = process.env.WEBHOOK_HOST ?? "127.0.0.1";

  const handle = await startWebhookServer({
    secret,
    port,
    host,
    onEvent: (payload) => {
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          event: payload.event,
          data: payload.data
        })
      );
    }
  });

  console.log(`HopStream webhook server ready at ${handle.url}/webhooks/multihopper`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
