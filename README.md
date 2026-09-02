# eins-places-mcp

MCP-Server, der die Google Places API (New) für den EINS Outreach Bot wrappt. Läuft als Vercel-Node-Function, exposed drei Tools (`places_search`, `place_details`, `places_nearby_grid`), authentifiziert über einen statischen Bearer-Token.

Wird vom Outreach-Bot-Routine (geschedult via claude.ai Routines) als MCP-Connector eingebunden. Der `GOOGLE_PLACES_API_KEY` lebt server-seitig in Vercel, der Remote-Agent sieht ihn nie.

## Architektur

```
claude.ai Routine (Remote-Agent)
        │  HTTPS POST + Bearer
        ▼
Vercel Function /api/mcp  ◀── eins-places-mcp.vercel.app/mcp
        │  X-Goog-Api-Key
        ▼
Google Places API (New)
```

Stateless: pro Request ein frischer MCP-Server plus Transport. Kein Session-State, kein Cross-Request-Leak.

## Tools

| Tool             | Input                       | Output                                                                            |
| ---------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `places_search`  | `query`, `city`             | bis zu 20 Kandidaten: `place_id`, `name`, `formatted_address`, `rating`, Reviews-Count, Typen |
| `place_details`  | `place_id`                  | Volldatensatz: Website, Telefon, Adresse, Öffnungszeiten, Rating + Reviews-Count, Maps-URI |
| `places_nearby_grid` | `points[]` (Kreise), `included_types`, optional `name_gate_tokens`/`gate_exempt_types`/`max_calls`/`min_radius` | EIN Call = ganzer Stadt-Sweep über Nearby Search: dedupte, namens-gefilterte Kandidaten `{place_id, name, formatted_address, primary_type}` + `stats` (Calls, Sättigung, Drops). Server-seitige Schleife: gesättigte Kreise (20 Treffer = Cap) werden quadtree-artig unterteilt, Budget via `max_calls`. Sweep-Logik: `src/grid.ts` (pure, `npm test` = 14 Unit-Tests). |

## Deploy (einmalig)

### 1. GitHub-Repo

```powershell
cd D:\Desktop\eins-places-mcp
git init -b main
git add .
git commit -m "Initial scaffold: MCP server wrapping Google Places (New)"
gh repo create Krambo1/eins-places-mcp --private --source=. --remote=origin --push
```

### 2. Google Places API Key

1. https://console.cloud.google.com/ : Projekt anlegen (oder vorhandenes nehmen).
2. APIs aktivieren: **Places API (New)**. NICHT die alte „Places API".
3. Credentials : API-Key erstellen.
4. Key restricten auf:
   - **Application restriction**: None (oder HTTP referrer mit deiner Vercel-URL).
   - **API restriction**: Places API (New) only.
5. Billing-Account verknüpfen (Places New braucht aktive Abrechnung; $200 Free Tier reicht für Outreach in NRW locker).

### 3. Vercel-Projekt

```powershell
npm install
npx vercel link        # an Vercel-Projekt koppeln (oder neu erstellen)
npx vercel env add GOOGLE_PLACES_API_KEY production
npx vercel env add MCP_BEARER_TOKEN production
npx vercel deploy --prod
```

Für `MCP_BEARER_TOKEN` einen langen Random-String generieren:
```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Output von `vercel deploy --prod` notieren: `https://eins-places-mcp-<hash>.vercel.app`. Den Alias `https://eins-places-mcp.vercel.app` setzen wenn gewünscht.

### 4. Smoke-Test

```powershell
$token = "<dein MCP_BEARER_TOKEN>"
curl.exe -H "Authorization: Bearer $token" https://eins-places-mcp.vercel.app/mcp
```

Erwartung: `{"name":"eins-places-mcp","status":"ok","tools":["places_search","place_details","places_nearby_grid"]}`

Echter MCP-Roundtrip (`tools/list`):
```powershell
curl.exe -X POST `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' `
  https://eins-places-mcp.vercel.app/mcp
```

### 5. Als MCP-Server registrieren (CLI, NICHT die claude.ai-Weboberfläche)

**Der Weg über https://claude.ai/customize/connectors funktioniert bei diesem Server nicht und kann nicht funktionieren.** Dieser Server kennt nur einen statischen Bearer-Token. Auf einen Request ohne Token antwortet er `401` mit `WWW-Authenticate: Bearer`; die Weboberfläche liest das als "hier gibt es OAuth", versucht daraufhin eine Dynamic Client Registration und bricht ab mit *"Registrierung beim Anmeldedienst von eins-places fehlgeschlagen"* (beobachtet 2026-07-05 und erneut 2026-07-26). Das ist kein Fehler im Server und keine Frage der Reihenfolge: Trennen und neu verbinden hilft nicht, weil es dieselbe OAuth-Registrierung erneut auslöst.

Registrierung stattdessen per Claude-Code-CLI, das den Header direkt setzt und OAuth komplett umgeht:

```bash
claude mcp add --transport http eins-places https://eins-places-mcp.vercel.app/mcp --header "Authorization: Bearer <MCP_BEARER_TOKEN>" -s user
```

Den Token-Wert exakt übernehmen, inklusive abschließendem `=` (base64-Padding). Ein abgeschnittenes `=` führt zu einem stillen 401 statt einer Fehlermeldung. Danach `claude mcp list` → `eins-places … ✔ Connected`; die Tools heißen `mcp__eins-places__places_search`, `…__place_details`, `…__places_nearby_grid`.

**Neue Tools nach einem Deploy brauchen KEINE Neuregistrierung.** Die Tools-Liste kommt bei jedem Verbindungsaufbau frisch per `tools/list` vom Server. Nach `vercel deploy --prod` genügt eine neue Claude-Code-Sitzung. Ob der Server ein Tool schon ausliefert, prüft dieser Aufruf (ohne Registrierung anzufassen):

```bash
curl -s -X POST -H "Authorization: Bearer <MCP_BEARER_TOKEN>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://eins-places-mcp.vercel.app/mcp
```

Falls der Server je in der claude.ai-Weboberfläche oder in Cloud-Routinen gebraucht wird, gibt es genau zwei Wege: echtes OAuth im Server implementieren (Metadata-Discovery + Client Registration) oder eine OAuth Client ID von einem vorgeschalteten Dienst eintragen. Für den Outreach-Bot ist beides unnötig, der läuft lokal in Claude Code.

Der Connector ist damit auch in `/schedule`-Routines als `mcp_connections`-Eintrag verfügbar.

## Lokale Entwicklung

```powershell
npm install
$env:GOOGLE_PLACES_API_KEY = "<key>"
$env:MCP_BEARER_TOKEN = "local-dev-token"
npm run dev    # vercel dev auf http://localhost:3000
```

Type-Check:
```powershell
npm run typecheck
```

## Sicherheit

- **Bearer-Token ist die einzige Auth-Schicht.** Wenn das Token leakt, rotieren: neuen Wert in Vercel ENV, in claude.ai Connector aktualisieren, redeploy nicht nötig (ENV-Änderung reicht).
- **Places-Key niemals an den Client geben.** Der lebt nur in Vercel-ENV und verlässt den Server nicht.
- **Rate-Limit pro Tag:** Google Places (New) hat per-key Quotas. In GCP Console unter Quotas pro Tag begrenzen, damit ein Bug nicht die Rechnung explodieren lässt. Empfohlen: 500 Text-Search + 500 Place-Details + 500 Nearby-Search pro Tag — deckt einen Outreach-Lauf mehr als ab (Bot-Cap: 200 Lookups pro Tag; Nearby-Grid: ≤120 Calls pro Tool-Call, Planner budgetiert ≤80 pro Stadt). Die Nearby-FieldMask ist bewusst schmal (kein Rating) und bleibt damit im günstigeren Pro-SKU.

## Was bewusst NICHT drin ist

- Kein Caching. Vercel ist regional, Outreach-Volumen niedrig, Komplexität nicht wert.
- Kein Logging-Sink. Vercel Function-Logs reichen für jetzt.
- Keine zusätzlichen Places-Endpoints (Photos, Autocomplete). Falls der Outreach-Bot später Bilder braucht, hier neuen Tool ergänzen.

## Changelog

- **0.2.0** (2026-07-25): `places_nearby_grid` (Outreach v3 Step 4): server-seitiger Stadt-Sweep über Nearby Search mit Sättigungs-Subdivision, place_id-Dedupe, param-getriebenem Namens-Gate und Call-Budget. Neu: `src/grid.ts` + 14 Unit-Tests (`npm test`, tsx). Nutzt der Outreach-Bot via SKILL.md §4c.4b (ADR-010 im Skill-Repo).
- **0.1.0** (2026-05-20): Initial. Zwei Tools, Bearer-Auth, Vercel-Deploy.
