import { createServer } from "node:http";
import { ZodError } from "zod";
import { createInfraiTransport, InfraiError } from "./infrai_client.js";
import { tenantRequestSchema, TenantLogisticsWorkflow } from "./tenant_workflow.js";

const apiKey = process.env.INFRAI_API_KEY;
const baseDomain = process.env.LOGISTICS_BASE_DOMAIN;
const bucket = process.env.POD_BUCKET ?? "logistics-proof-of-delivery";
const assetOrigin = process.env.ASSET_ORIGIN;

if (!apiKey || !baseDomain || !assetOrigin) {
  throw new Error("Set INFRAI_API_KEY, LOGISTICS_BASE_DOMAIN, and ASSET_ORIGIN");
}

const workflow = new TenantLogisticsWorkflow(
  createInfraiTransport(apiKey),
  baseDomain,
  bucket,
  assetOrigin,
);
await workflow.initialize();

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/events") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "route_not_found" }));
    return;
  }

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = tenantRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result = await workflow.handle(input);
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    const status = error instanceof ZodError
      ? 400
      : error instanceof InfraiError && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    const body = error instanceof ZodError
      ? { error: "invalid_request", issues: error.issues }
      : error instanceof InfraiError
        ? { error: error.code, message: error.message }
        : { error: "request_failed" };
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Logistics event service listening on :${port}`));
