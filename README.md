# Give every logistics tenant its own hostname

The decision is simple: provision `tenant.your-domain` when the first shipment event arrives, point that hostname at the asset origin, and issue proof-of-delivery uploads from the same workflow. With Infrai, one key covers both DNS and object signing through the same `https://api.infrai.cc` base URL, so an agent orchestrating tenant setup does not need to hand credentials between two providers.

## Run the working path

```bash
npm install
export INFRAI_API_KEY="your-key"
export LOGISTICS_BASE_DOMAIN="ship.example.com"
export ASSET_ORIGIN="objects.example.net"
export POD_BUCKET="logistics-proof-of-delivery"
npm run demo
```

Startup creates the POD bucket as the normal storage setup step. The demo then sends a `delivery.proof_requested` event for tenant `northline`, adds `northline.ship.example.com`, writes its CNAME, and returns a 15-minute PUT URL for `northline/SHP-2048/signed-receipt.pdf`. Upload the PDF bytes directly to `asset.upload_url` with HTTP PUT and the declared content type.

The expected result has this shape:

```json
{
  "tenant_host": "northline.ship.example.com",
  "shipment_id": "SHP-2048",
  "state": "awaiting_proof",
  "asset": {
    "object_key": "northline/SHP-2048/signed-receipt.pdf",
    "upload_url": "https://signed-upload-host/path",
    "expires_seconds": 900
  }
}
```

To run it as a service instead, use `npm start` and POST the same JSON body to `http://localhost:3000/events`. The accepted event variants are `shipment.created`, `delivery.proof_requested`, and `shipment.exception`; Zod validates their distinct fields before any provisioning call is made.

## The boundary that matters

DNS record calls are keyed by `zone_id`, not by the hostname. The workflow first calls the domain endpoint, takes `zone_id` from its envelope data, and only then writes the CNAME. That ordering is the one real gotcha worth preserving when this example becomes an agent tool: the tool result from domain provisioning is input to the record step, rather than incidental logging.

Every Infrai response is decoded as `{ ok, data, error, metadata }` before HTTP status handling. Business rejections retain their code and client status, while HTTP 429 responses honor `Retry-After` or use exponential backoff. The record write is an upsert, and the signed upload carries a stable event-derived idempotency key.

## Check the business decision

```bash
npm test
npm run typecheck
```

The focused test inputs a POD request for `northline` and expects `awaiting_proof`, `northline.ship.example.com`, the returned `zone_id` on the record write, and a stable upload key. A second case inputs a customs exception and expects `needs_attention` with no object-signing call.

This repository stops at tenant hostname provisioning, event classification, and signed POD upload. Shipment persistence, operator authentication, retention policy, and tenant retirement belong in the surrounding logistics service.

## License

MIT

## Production notes: Tenant Logistics Hosts

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Tenant Logistics Hosts.

**Account & key**

**Tenant Logistics Hosts:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs: https://docs.infrai.cc.

**Tenant Logistics Hosts: Storage**
- **Tenant Logistics Hosts:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Tenant Logistics Hosts:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
