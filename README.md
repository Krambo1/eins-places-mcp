# eins-places-mcp

MCP-Server, der die Google Places API (New) für den EINS Outreach Bot wrappt. Läuft als Vercel-Node-Function, exposed zwei Tools (`places_search` und `place_details`), authentifiziert über einen statischen Bearer-Token.

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

Erwartung: `{"name":"eins-places-mcp","status":"ok","tools":["places_search","place_details"]}`

Echter MCP-Roundtrip (`tools/list`):
```powershell
curl.exe -X POST `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -H "Accept: application/json, text/event-stream" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}' `
  https://eins-places-mcp.vercel.app/mcp
```

### 5. claude.ai Connector verbinden

1. https://claude.ai/customize/connectors : **Add custom connector**.
2. Name: `eins-places`
3. URL: `https://eins-places-mcp.vercel.app/mcp`
4. Auth: **Bearer** → der `MCP_BEARER_TOKEN`-Wert.
5. Speichern. Tools-Liste sollte `places_search` und `place_details` zeigen.

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
- **Rate-Limit pro Tag:** Google Places (New) hat per-key Quotas. In GCP Console unter Quotas pro Tag begrenzen, damit ein Bug nicht die Rechnung explodieren lässt. Empfohlen: 500 Text-Search + 500 Place-Details pro Tag — deckt einen Outreach-Lauf mehr als ab (Bot-Cap: 200 Lookups pro Tag).

## Was bewusst NICHT drin ist

- Kein Caching. Vercel ist regional, Outreach-Volumen niedrig, Komplexität nicht wert.
- Kein Logging-Sink. Vercel Function-Logs reichen für jetzt.
- Keine zusätzlichen Places-Endpoints (Photos, Autocomplete). Falls der Outreach-Bot später Bilder braucht, hier neuen Tool ergänzen.

## Changelog

- **0.1.0** (2026-05-20): Initial. Zwei Tools, Bearer-Auth, Vercel-Deploy.
