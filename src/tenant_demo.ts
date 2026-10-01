import { createInfraiTransport } from "./infrai_client.js";
import { tenantRequestSchema, TenantLogisticsWorkflow } from "./tenant_workflow.js";

const apiKey = process.env.INFRAI_API_KEY;
const baseDomain = process.env.LOGISTICS_BASE_DOMAIN;
const assetOrigin = process.env.ASSET_ORIGIN;
if (!apiKey || !baseDomain || !assetOrigin) {
  throw new Error("Set INFRAI_API_KEY, LOGISTICS_BASE_DOMAIN, and ASSET_ORIGIN");
}

const workflow = new TenantLogisticsWorkflow(
  createInfraiTransport(apiKey),
  baseDomain,
  process.env.POD_BUCKET ?? "logistics-proof-of-delivery",
  assetOrigin,
);
await workflow.initialize();

const input = tenantRequestSchema.parse({
  tenant_id: "northline",
  event: {
    kind: "delivery.proof_requested",
    shipment_id: "SHP-2048",
    occurred_at: "2026-09-26T08:30:00.000Z",
    filename: "signed-receipt.pdf",
    content_type: "application/pdf",
    bytes: 240000,
  },
});

console.log(JSON.stringify(await workflow.handle(input), null, 2));
