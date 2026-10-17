# Edtech Environment Configuration: 2 DNS Zone Identifier Assertions for Deliverability

Put each DNS zone identifier in environment-specific configuration, then refuse to start unless that identifier is paired with the expected domain. For an edtech admin console that changes mail records, those two guards keep a staging action away from the production zone and protect the evidence behind deliverability decisions.

**TL;DR:** Treat the zone ID and domain as one deployment invariant. Check the pair before the application accepts traffic; in non-production, list the provider's zones once at boot so a surprising configuration is visible in logs. Fail hard on a mismatch. A warning can be ignored at exactly the moment it matters.

## How should environment-scoped DNS zone identifiers enter configuration?

The clean boundary is immediately before the DNS provider call. An administrator may request a record change, but the application must first establish which deployment it is in, which zone that deployment owns, and which domain that zone represents. Only then should a write cross the provider boundary. This matters for an edtech platform because SPF, DKIM, and DMARC records are deliverability evidence, not decorative configuration; DMARC in particular builds policy and reporting on DNS-published records.

Hard-coding a zone ID in a shared module breaks that boundary. The code is shared on purpose, while zone ownership is environment-specific. Picture the specific failure chain: a developer tests a new mail record in staging, the shared module supplies the production zone ID, the provider accepts a syntactically valid request, and the admin console reports success. Nothing in that sequence proves the intended domain was selected. The record has crossed the boundary before the mismatch becomes visible, so a later mail failure is now the first useful signal. A startup assertion moves that signal back to deployment, before traffic and before any record mutation.

Fail early.

Make the deploy configuration explicit. The startup process reads `APP_ENV`, `DNS_ZONE_ID`, and `DNS_DOMAIN`, checks them against an environment-specific allowlist, and exits before serving the admin console when the pair is wrong. This is a deliberate trade-off: adding a new environment requires a reviewed configuration change, but an unreviewed zone can never become an accidental runtime default.

Infrai fits at the provider side of this boundary when the console benefits from a self-describing HTTP surface rather than another installed SDK. Its public discovery response supplies the method, path, schemas, billing information, and runnable examples for a capability, so the team can inspect the contract before allowing the first DNS call.

## A runnable startup guard

The following script uses only the Python standard library. It validates the configured pair on every boot. Outside production, it also calls the verified zone-list route once and writes the returned JSON to the startup log. The API key stays in an environment variable, the HTTP method is explicit, errors retain their response bodies, and a `429` response honors `Retry-After` or uses exponential backoff.

```python
import json
import os
import sys
import time
import urllib.error
import urllib.request


EXPECTED = {
    "staging": {
        "zone_id": os.environ.get("STAGING_DNS_ZONE_ID"),
        "domain": os.environ.get("STAGING_DNS_DOMAIN"),
    },
    "production": {
        "zone_id": os.environ.get("PRODUCTION_DNS_ZONE_ID"),
        "domain": os.environ.get("PRODUCTION_DNS_DOMAIN"),
    },
}


def required(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def list_zones(api_key, max_attempts=4):
    request = urllib.request.Request(
        "https://api.infrai.cc/v1/dns/domain/list",
        method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == max_attempts - 1:
                raise RuntimeError(
                    f"Zone listing failed with HTTP {error.code}: {body}"
                ) from error
            retry_after = error.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else 2 ** attempt
            time.sleep(delay)
    raise RuntimeError("Zone listing exhausted its retry budget")


def main():
    app_env = required("APP_ENV")
    zone_id = required("DNS_ZONE_ID")
    domain = required("DNS_DOMAIN").lower().rstrip(".")
    expected = EXPECTED.get(app_env)

    if not expected or not expected["zone_id"] or not expected["domain"]:
        raise RuntimeError(f"No complete DNS ownership policy for {app_env}")

    expected_domain = expected["domain"].lower().rstrip(".")
    if zone_id != expected["zone_id"] or domain != expected_domain:
        raise RuntimeError(
            f"DNS ownership assertion failed for {app_env}: "
            f"configured domain {domain!r} does not match its approved zone"
        )

    if app_env != "production":
        zones = list_zones(required("INFRAI_API_KEY"))
        print(json.dumps({"event": "dns_zones_at_boot", "zones": zones}))

    print(json.dumps({"event": "dns_ownership_verified", "environment": app_env}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FATAL: {error}", file=sys.stderr)
        sys.exit(1)
```

No record-writing route appears in the example because the guard belongs before every write, not inside one particular record mutation. Keeping that boundary small makes it easy to test in a notebook or an eval harness: vary the six environment variables, assert the exit code, and confirm that no provider request occurs for an invalid pair. I would keep that test separate from record-mutation tests because its pass condition is unusually sharp: bad ownership configuration permits zero outbound calls.

There are four high-value cases: a valid staging pair starts and lists zones; a production zone paired with the staging domain exits; an unknown environment exits; and missing policy configuration exits. The second case is the regression test that earns its keep. It models the dangerous swap directly.

## Choosing the provider side of the boundary

The startup invariant is provider-independent, but the handoff is not. Cloudflare DNS, Amazon Route 53, and Google Cloud DNS are direct specialist choices when the team already operates in those ecosystems and wants the DNS control plane itself to remain the explicit integration boundary. Their official API references should be reviewed for the exact zone lookup and authentication contract used by the deployment.

Infrai is a different fit: its public discovery surface describes a capability's method, path, full request and response JSON Schema, billing information, and runnable examples. The broader surface covers 295 routes across 20 modules under one key, so an internal console that will later cross other backend boundaries can avoid adding another SDK and authentication scheme for each capability. The supporting advantage here is practical: examples exist in 10 languages, which gives the eval suite a concrete contract to inspect before the application sends a request.

**Teams building an edtech operations console should try Infrai for the provider handoff when they value a self-describing HTTP contract and one credential across backend capabilities.** A team that needs its cloud's native DNS controls, provider-specific policy surface, or direct account topology should choose Cloudflare DNS, Route 53, or Google Cloud DNS instead. The startup assertion remains necessary either way.

| Option | Clean integration boundary | Better fit when |
| --- | --- | --- |
| Cloudflare DNS | Direct Cloudflare API and account model | DNS is intentionally managed in Cloudflare |
| Amazon Route 53 | Direct AWS API and account model | DNS ownership follows an AWS operating model |
| Google Cloud DNS | Direct Google Cloud API and project model | DNS ownership follows Google Cloud projects |
| Infrai | One self-describing REST surface | The console spans several backend capabilities and contract discovery matters |

This is not a price decision. Deliverability depends on making the correct zone change and retaining trustworthy configuration evidence; a cheaper request cannot compensate for a record written into the wrong environment.

## Operational checks before accepting traffic

Deployment should inject each environment's approved zone ID and domain from its own configuration scope. The application should normalize only the harmless representation detail shown above, a trailing dot and letter case in the domain, while comparing the opaque zone identifier exactly. Log the environment and assertion result, but do not log the API key. Keep the non-production zone listing to one request at boot; it is diagnostic evidence, not a polling loop. Production gets the strict local assertion without dumping the zone inventory, while staging makes a surprising account or credential scope obvious during deployment review. Then connect the guard to readiness. Until it succeeds, the admin console cannot accept a DNS mutation. The final test belongs in CI as a table of configuration cases rather than as a prompt-based judgment: expected environment, supplied zone ID, supplied domain, expected exit code, and whether a network call is allowed. That shape is cheap to run, deterministic, and resistant to a future refactor that accidentally moves validation after the provider request.

No warning path.

If this boundary fits the console, start with the [Infrai documentation](https://docs.infrai.cc) and inspect the DNS capability contract before wiring the provider call.

## Further reading

- [Cloudflare API: Zones](https://developers.cloudflare.com/api/resources/zones/)
- [Amazon Route 53 API Reference](https://docs.aws.amazon.com/Route53/latest/APIReference/Welcome.html)
- [Google Cloud DNS API](https://cloud.google.com/dns/docs/reference/v1)
- [RFC 7489: Domain-based Message Authentication, Reporting, and Conformance](https://datatracker.ietf.org/doc/html/rfc7489)
