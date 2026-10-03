# ADR-0009: Default aerial layer = GovMap 2022 ITM cache (user decision D-1)

- Status: Accepted - product-owner decision D-1 (2026-09-27), amending ADR-0007. Since user decision D-7 (2026-09-29) deleted the
  2025 tile proxy, this is the only GovMap path.
- Date: 2026-09-27

## Context
ADR-0007 made GovMap's 2025 EPSG:3857 orthophoto the *Aerial* view. That layer was served through our backend proxy, which sent
`Referer: https://www.govmap.gov.il/` to a CDN that checks the header on purpose. GovMap's terms need written approval from the Survey
of Israel for non-personal use.

GovMap still publishes its legacy orthophoto cache in Israel TM Grid (EPSG:2039):
- URL pattern `https://cdn.govmap.gov.il/LPD0BBK2022/L{LL}/R{row}/C{col}.jpg`, imagery from about 2022;
- it needs no Referer, and plain `<img>` tiles load from any origin;
- verified live at L5-L10 over Tel Aviv.

The assignment lists "Handle coordinate transformations between different map projections" and "Maintain drawing accuracy when
switching between satellite and regular views" as graded technical challenges.

## Decision
- **Default Aerial.** *Aerial* activates `govmap-itm` (the 2022 ITM cache) in every build; the browser loads the tiles directly.
  `VITE_ENABLE_ITM_LAYER` defaults to `true` and acts as a kill switch (with `false`, *Aerial* shows Esri World Imagery).
- **Cross-CRS switch.** The required Map <-> Aerial switch is a real EPSG:3857 <-> EPSG:2039 switch (SPEC section 8.4):
  - stacked Leaflet maps with a cross-fade;
  - center carried through WGS84 lat/lng;
  - zoom mapped through the ground-resolution formula, with the round-trip rule;
  - geometry kept in stores as WGS84 and reprojected by proj4leaflet.
- **No proxy.** The 2025 Web-Mercator proxy was first kept off by default; D-7 deleted it, so GovMap's Referer is never sent.
- **Legal caveat.** Attribution `תצלום אוויר © GovMap / המרכז למיפוי ישראל` is always shown and nothing is prefetched. A public or
  commercial deployment needs written approval from the Survey of Israel (gis@mapi.gov.il) first, or the kill switch (Esri only), or
  GovMap's official JS API with a domain token.

## Consequences
- **Pros:**
  - No header spoofing and no tile traffic through our backend.
  - The graded projection-transformation challenge is exercised on every Map <-> Aerial toggle.
- **Cons:**
  - Imagery is from about 2022, not 2025.
  - The Aerial view covers Israel only, with no global backdrop in the ITM map; the coverage notice explains this.
  - Native zoom stops at L10 (~ 0.33 m/px); L11-L12 overzoom.
  - We depend on an undocumented dataset id (`LPD0BBK2022`, in `frontend/src/map/itm.ts`); a recorded live probe is pending.
- **Tests:**
  - E2E Map -> Aerial -> Map mid-draw (`e2e/tests/layer-switch.spec.ts`): centre, points and area unchanged.
  - Unit vectors for proj4, tile URLs and the zoom <-> level mapping (`itm.test.ts`, `crs.test.ts`).
