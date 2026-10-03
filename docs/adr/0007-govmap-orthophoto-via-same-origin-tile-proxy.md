# ADR-0007: GovMap orthophoto as an EPSG:3857 layer through a same-origin tile proxy

- Status: Accepted, amended by ADR-0009 (user decision D-1: *Aerial* defaults to the 2022 ITM cache, the proxy off by default);
  superseded by user decision D-7 (2026-09-29): the proxy is deleted. Kept as the record of why the 2025 imagery was not used.
- Date: 2026-09-27

## Context
The assignment requires Leaflet with OpenStreetMap and "Satellite imagery from govmap.gov.il (תצלום אוויר)". Switching layers must be
smooth, and drawn geometry must stay in place. Research (2026-09-27) found:
- GovMap's current orthophoto is served as **EPSG:3857 XYZ** tiles from
  `https://basemaps.govmap.gov.il/tms/orto2025me_update/{z}/{x}/{y}.jpg`. z8-20 covers Tel Aviv; `tms/orto2023me` covers z4-7.
- The CDN requires `Referer: https://www.govmap.gov.il...` (else 401) and a browser-like User-Agent (else 403). Browsers on our
  origin cannot set that Referer.
- GovMap's legacy EPSG:2039 (ITM) cache still exists, with 2022 imagery.
- GovMap's terms require written approval from the Survey of Israel for non-personal or commercial use.

## Decision (as taken on 2026-09-27)
- **Required views.** OSM and GovMap 2025 share EPSG:3857 and the same zoom pyramid, so switching between them is a pure base-layer
  cross-fade: no CRS change, and overlays keep identical pixel positions.
- **"Satellite" layer group**: an Esri World Imagery backdrop (global coverage and fallback), the GovMap orthophoto limited to
  Israel, and optional GovMap Hebrew labels.
- **Tile proxy.** Backend route `GET /api/v1/tiles/govmap/{layer}/{z}/{x}/{y}` with a hard-coded upstream, a layer allowlist and
  Israel-bounds checks, only the required headers, timeouts, a concurrency cap, single-flight requests, caches, a circuit breaker,
  a `Sec-Fetch-Site` guard against hot-linking and per-IP rate limits; the frontend fell back to Esri on tile errors.
- **ITM layer**: see ADR-0009, which made the legacy ITM cache the default *Aerial* source.
- **Legal controls**: the layer behind a feature flag, attribution always shown, no prefetching, and written approval from the
  Survey of Israel (gis@mapi.gov.il) before any public or commercial deployment.

## Consequences
- The proxy presented GovMap's expected Referer to a CDN that checks it deliberately. That was acceptable only for a local
  assessment build with the flag and attribution, and it is why the product owner chose ADR-0009 (D-1) and then removed the proxy
  (D-7).
- It depended on undocumented, versioned layer names (`orto2025me_update`, `labels_and_line_6_2026`).

## Alternatives considered
- **Direct browser tile requests**: fail (401) because of the Referer rule.
- **GovMap WMTS/WMS (GeoServer)**: 403 for the public.
- **Legacy ITM cache as the main satellite layer**: 2022 imagery, an undocumented dataset id and a CRS switch on every toggle. Chosen
  later by ADR-0009.
- **GovMap JS API embed**: sanctioned, but it is GovMap's own map widget, not a Leaflet layer, so it cannot meet the Leaflet
  requirement.
