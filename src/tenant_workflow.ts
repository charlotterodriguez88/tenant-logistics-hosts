import { z } from "zod";
import { InfraiError, type InfraiTransport } from "./infrai_client.js";

export const logisticsEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shipment.created"),
    shipment_id: z.string().min(1),
    occurred_at: z.string().datetime(),
    destination_country: z.string().length(2),
  }),
  z.object({
    kind: z.literal("delivery.proof_requested"),
    shipment_id: z.string().min(1),
    occurred_at: z.string().datetime(),
    filename: z.string().min(1).max(180),
    content_type: z.enum(["image/jpeg", "image/png", "application/pdf"]),
    bytes: z.number().int().positive().max(10_000_000),
  }),
  z.object({
    kind: z.literal("shipment.exception"),
    shipment_id: z.string().min(1),
    occurred_at: z.string().datetime(),
    exception_code: z.enum(["ADDRESS", "CUSTOMS", "DAMAGED", "DELAYED"]),
    note: z.string().max(500),
  }),
]);

export type LogisticsEvent = z.infer<typeof logisticsEventSchema>;

export const tenantRequestSchema = z.object({
  tenant_id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/),
  event: logisticsEventSchema,
});

export type TenantRequest = z.infer<typeof tenantRequestSchema>;

type DomainData = { zone_id: string };
type PresignData = { url: string; method?: string; headers?: Record<string, string> };

export type WorkflowResult = {
  tenant_host: string;
  shipment_id: string;
  state: "registered" | "awaiting_proof" | "needs_attention";
  asset?: { object_key: string; upload_url: string; expires_seconds: number };
};

export class TenantLogisticsWorkflow {
  private readonly request: InfraiTransport;
  private readonly baseDomain: string;
  private readonly bucket: string;
  private readonly assetOrigin: string;

  constructor(
    request: InfraiTransport,
    baseDomain: string,
    bucket: string,
    assetOrigin: string,
  ) {
    this.request = request;
    this.baseDomain = baseDomain;
    this.bucket = bucket;
    this.assetOrigin = assetOrigin;
  }

  async initialize(): Promise<void> {
    try {
      await this.request("/v1/storage/bucket/create", {
        method: "POST",
        body: { name: this.bucket },
      });
    } catch (error) {
      if (!(error instanceof InfraiError && error.status === 409)) throw error;
    }
  }

  async handle(input: TenantRequest): Promise<WorkflowResult> {
    const tenantHost = `${input.tenant_id}.${this.baseDomain}`;
    let domain: DomainData;
    try {
      domain = await this.request<DomainData>("/v1/dns/domain/add", {
        method: "POST",
        body: {
          domain: tenantHost,
          metadata: { tenant_id: input.tenant_id },
        },
      });
    } catch (error) {
      if (!(error instanceof InfraiError && error.status === 409)) throw error;
      domain = await this.request<DomainData>(
        `/v1/dns/domain/get?domain=${encodeURIComponent(tenantHost)}`,
        { method: "GET" },
      );
    }

    // DNS record operations are zone-scoped; the domain response supplies the key.
    await this.request("/v1/dns/record/upsert", {
      method: "PUT",
      body: {
        zone_id: domain.zone_id,
        record_type: "CNAME",
        name: tenantHost,
        content: this.assetOrigin,
        ttl: 300,
        proxied: true,
        metadata: { tenant_id: input.tenant_id },
      },
    });

    if (input.event.kind === "delivery.proof_requested") {
      const objectKey = `${input.tenant_id}/${input.event.shipment_id}/${input.event.filename}`;
      const path = `/v1/storage/object/presign/${encodeURIComponent(this.bucket)}/${encodeURIComponent(objectKey)}`;
      const signed = await this.request<PresignData>(path, {
        method: "POST",
        body: {
          op: "put",
          expires_seconds: 900,
          content_type: input.event.content_type,
          max_bytes: input.event.bytes,
          idempotency_key: `${input.tenant_id}:${input.event.shipment_id}:${input.event.filename}`,
        },
      });
      return {
        tenant_host: tenantHost,
        shipment_id: input.event.shipment_id,
        state: "awaiting_proof",
        asset: { object_key: objectKey, upload_url: signed.url, expires_seconds: 900 },
      };
    }

    return {
      tenant_host: tenantHost,
      shipment_id: input.event.shipment_id,
      state: input.event.kind === "shipment.exception" ? "needs_attention" : "registered",
    };
  }
}
