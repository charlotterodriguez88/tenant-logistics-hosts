import assert from "node:assert/strict";
import test from "node:test";
import { TenantLogisticsWorkflow } from "../src/tenant_workflow.js";
import type { InfraiTransport } from "../src/infrai_client.js";

test("a proof request provisions the tenant host and returns an idempotent upload", async () => {
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const transport: InfraiTransport = async <T>(path, init) => {
    calls.push({ path, ...init });
    if (path === "/v1/dns/domain/add") return { zone_id: "zone_northline" } as T;
    if (path.startsWith("/v1/storage/object/presign/")) {
      return { url: "https://uploads.example/signed" } as T;
    }
    return { accepted: true } as T;
  };
  const workflow = new TenantLogisticsWorkflow(
    transport,
    "ship.example.com",
    "pod-files",
    "objects.example.net",
  );

  const result = await workflow.handle({
    tenant_id: "northline",
    event: {
      kind: "delivery.proof_requested",
      shipment_id: "SHP-2048",
      occurred_at: "2026-09-26T08:30:00.000Z",
      filename: "receipt.pdf",
      content_type: "application/pdf",
      bytes: 240000,
    },
  });

  assert.equal(result.tenant_host, "northline.ship.example.com");
  assert.equal(result.state, "awaiting_proof");
  assert.equal(calls[1].body?.zone_id, "zone_northline");
  assert.equal(calls[2].body?.idempotency_key, "northline:SHP-2048:receipt.pdf");
  assert.match(calls[2].path, /pod-files\/northline%2FSHP-2048%2Freceipt.pdf$/);
});

test("an exception makes the shipment decision visible without signing a file", async () => {
  const paths: string[] = [];
  const transport: InfraiTransport = async <T>(path) => {
    paths.push(path);
    return (path === "/v1/dns/domain/add" ? { zone_id: "zone_acme" } : {}) as T;
  };
  const workflow = new TenantLogisticsWorkflow(
    transport,
    "ship.example.com",
    "pod-files",
    "objects.example.net",
  );
  const result = await workflow.handle({
    tenant_id: "acme-logistics",
    event: {
      kind: "shipment.exception",
      shipment_id: "SHP-9",
      occurred_at: "2026-09-26T08:30:00.000Z",
      exception_code: "CUSTOMS",
      note: "Broker review requested",
    },
  });

  assert.equal(result.state, "needs_attention");
  assert.equal(paths.some((path) => path.includes("/presign/")), false);
});
