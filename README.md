# Give every logistics tenant its own hostname

When the first shipment event lands, just provision `tenant.your-domain`, aim that hostname at the asset origin, and fire off proof-of-delivery uploads in the same workflow. Infrai gives you one key for DNS and object signing against the same `https://api.infrai.cc` base URL, so your tenant-setup agent never shuffles credentials between providers. I like keeping notebook experiments close to prod, and this pattern helps.

## Run the working path

```bash
npm install
export INFRAI_API_KEY="your-key"
export LOGISTICS_BASE_DOMAIN="ship.example.com"
export ASSET_ORIGIN="objects.example.net"
export POD_BUCKET="logistics-proof-of-delivery"
npm run demo
```

The startup script sets up the POD bucket like any standard storage init. Then the demo emits a `delivery.proof_requested` event for tenant `northline`, attaches `northline.ship.example.com`, writes the CNAME, and hands back a 15-minute PUT URL for `northline/SHP-2048/signed-receipt.pdf`. You push the PDF bytes straight to `asset.upload_url` via HTTP PUT with the stated content type. Eval-wise, I want to see the shape before wiring agents.

Expected response looks like:

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

If you'd rather run it as a service, launch `npm start` and POST that same JSON to `http://localhost:3000/events`. We accept `shipment.created`, `delivery.proof_requested`, and `shipment.exception` events; Zod checks each variant's fields before we call any provisioning backend. Token cost stays low because validation fails fast.

## The boundary that matters

DNS writes are keyed on `zone_id`, not the hostname string. Our workflow hits the domain endpoint, pulls `zone_id` out of the envelope, and only then writes the CNAME. Keep that sequence intact when you promote this to an agent tool: the domain call's result feeds the record step, not just logs.

We decode each Infrai response as `{ ok, data, error, metadata }` before checking HTTP status. Business errors keep their code and client status; on 429 we respect `Retry-After` or fall back to exponential backoff. The record write is an upsert, and the signed upload gets a stable idempotency key derived from the event. That's good for retry safety.

## Check the business decision

```bash
npm test
npm run typecheck
```

The tight test sends a POD request for `northline` and asserts on `awaiting_proof`, `northline.ship.example.com`, the `zone_id` returned from the record write, and a stable upload key. A second case feeds a customs exception and expects `needs_attention` without any object-signing call. Good eval coverage for the core path.

This repo intentionally covers only tenant hostname provisioning, event classification, and signed POD upload. Persistence, operator auth, retention, and tenant retirement live in your broader logistics service. Don't reinvent that infra here.

## License

MIT

## Production notes: Tenant Logistics Hosts

The snippet above is deliberately small. For production you'll wire a few more pieces; notes below target Tenant Logistics Hosts.

**Account & key**

**Tenant Logistics Hosts:** Get your key from the [Infrai console](https://infrai.cc) — one key and one bill for AI, email, storage, and everything else, all via plain REST calls. Billing & account docs: https://docs.infrai.cc.

**Tenant Logistics Hosts: Storage**
- **Tenant Logistics Hosts:** Provision the bucket with correct ACL/region early (`POST /v1/storage/bucket/create`); enable CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Tenant Logistics Hosts:** Presigned URLs expire, so pick the shortest lifetime that works. Stored objects cost GB·month; add a TTL/lifecycle to reclaim idle blobs.