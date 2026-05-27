# Coda Express Web Clipper Backend

Express backend for a web-clipping workflow that saves arbitrary product/page data into user-selected Coda tables.

The core trick is that the Coda table schema is not known ahead of time. The extension or Pack sends a URL plus a Coda doc/table target, and the backend fetches that table's columns at runtime, builds a matching Zod schema dynamically, asks Fireworks AI to extract structured data from Firecrawl output, then writes the row to Coda.

## Architecture

```text
Browser extension / Coda Pack
  POST /api/save-bookmark
    { url, docId, tableId }
    Authorization: Bearer <user Coda token>
    x-api-key: <backend API key>

Express publisher
  validates payload
  triggers Upstash Workflow
  returns immediately

Upstash Workflow worker
  scrape -> Firecrawl
  fetch-coda-schema -> Coda columns and relation rows
  extract-data -> Fireworks via Vercel AI SDK
  save-to-coda -> Coda rows API
```

## Stack

- Node.js + Express
- TypeScript
- Upstash Workflow / QStash for durable execution
- Firecrawl for scraping
- Vercel AI SDK with the Fireworks provider
- Fireworks model: `accounts/fireworks/models/kimi-k2p6`
- Coda API for schema lookup and row insertion
- Zod for dynamic runtime extraction schemas

## Endpoints

### `POST /api/save-bookmark`

Publisher endpoint used by the browser extension or Coda Pack.

Headers:

```http
Authorization: Bearer <user-coda-api-token>
x-api-key: <backend-api-key>
Content-Type: application/json
```

Body:

```json
{
  "url": "https://www.amazon.com/dp/B0G6YDKYM8",
  "docId": "abc123",
  "tableId": "grid-xyz"
}
```

Compatibility fallback: `codaToken` may still be provided in the JSON body, but the preferred path is the `Authorization` header so a Coda Pack can store the token securely.

Response:

```json
{
  "ok": true,
  "workflowRunId": "wfr_..."
}
```

### `POST /api/workflow/save-bookmark`

Upstash Workflow worker endpoint. Do not call this directly from the client or Pack.

## Environment Variables

See [.env.example](./.env.example).

```env
PORT=3000
API_KEY=
FIREWORKS_API_KEY=
FIRECRAWL_API_KEY=
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
```

### `API_KEY`

Shared secret required by `/api/save-bookmark` in the `x-api-key` header.

### `FIREWORKS_API_KEY`

Fireworks API key used by the AI SDK Fireworks provider.

### `FIRECRAWL_API_KEY`

Firecrawl API key used for page scraping.

### `QSTASH_*`

Upstash Workflow/QStash config. The signing keys are used by `@upstash/workflow/express` to verify workflow requests.

## Local Development

Install dependencies:

```bash
pnpm install
```

Create a local env file:

```bash
cp .env.example .env
```

Run the server:

```bash
pnpm run dev
```

Type-check:

```bash
pnpm run build
```

The local server listens on `PORT`, defaulting to `3000`.

## Vercel Deployment

This repo includes [vercel.json](./vercel.json) so Vercel uses `server.ts` as the single serverless entrypoint instead of the legacy Express generator `app.js`.

Required Vercel env vars:

- `API_KEY`
- `FIREWORKS_API_KEY`
- `FIRECRAWL_API_KEY`
- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

After changing backend code, redeploy before testing new workflow runs. Existing Upstash workflow runs can still reflect old deployed code.

## Coda Pack Contract

The matching Coda Pack should:

- Use Coda Pack auth to connect a Coda account in Pack settings.
- Store the user's Coda token securely.
- Send that token as `Authorization: Bearer ...`.
- Send the backend shared secret as `x-api-key`.
- Send only `url`, `docId`, and `tableId` in the JSON body.

The prompt for building that Pack lives at [agents/coda.md](./agents/coda.md).

## Dynamic Coda Schema Handling

The workflow calls:

```text
GET /v1/docs/{docId}/tables/{tableId}
GET /v1/docs/{docId}/tables/{tableId}/columns
```

It builds a target column list with:

- `name`
- `type`
- `description`
- `existingOptions`
- relation table metadata when available

For relation columns, it fetches existing rows from the related table so the model can map page context to existing tags before inventing new ones.

## AI Extraction

The backend builds a Zod object schema dynamically from the selected Coda columns.

Examples:

- Text-like columns -> `string | null`
- Numeric columns -> `number | null`
- Boolean columns -> `boolean | null`
- Date/time columns -> ISO-ish `string | null`
- Relation/select/person-like columns -> `string | string[] | null`

The AI prompt instructs the model:

- Do not hallucinate.
- Return `null` if a value is not present.
- Use exact schema keys.
- For relation columns, prefer existing relation values.

The model is hardcoded in code:

```ts
const FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2p6";
```

## Firecrawl Scraping

Generic sites use Markdown.

Amazon and Etsy use Firecrawl's JSON format plus Markdown:

```ts
formats: [
  "markdown",
  {
    type: "json",
    prompt: "Extract structured product listing data from this page.",
    schema: structuredScrapeSchema,
  },
]
```

Amazon fields include:

- title
- price
- currency
- availability
- rating
- review count
- brand
- ASIN
- model number
- item model number
- product image
- image URLs
- features

Etsy fields include:

- title
- price
- currency
- shop name
- shop URL
- rating
- review count
- availability
- listing ID
- product image
- image URLs
- description
- variations
- materials

## Save-To-Coda Normalization

Coda row cell values must be:

```ts
boolean | number | string | Array<boolean | number | string>
```

The backend normalizes extracted values before saving:

- `undefined` and `null` cells are omitted.
- Objects are reduced to common scalar fields like `name`, `display`, `value`, `label`, `url`, `href`, or `text`.
- Remaining objects are JSON-stringified.
- Relation/tag arrays are allowed.

Amazon URL columns are shortened before saving:

```text
https://www.amazon.com/.../dp/B0G6YDKYM8/ref=...
```

becomes:

```text
https://www.amazon.com/dp/B0G6YDKYM8
```

## Logging

Workflow errors are logged with detailed serialized error objects for debugging.

Only current `process.env` values are redacted from logs. This means page content, AI output, Coda API response details, and outgoing row payloads may appear in logs if an error occurs.

## Troubleshooting

### Vercel picks `app.js` instead of `server.ts`

Make sure [vercel.json](./vercel.json) is deployed. Without it, Vercel may detect multiple entrypoints and pick the old Express generator app.

### Firecrawl says `json format must be an object`

Firecrawl SDK `4.25.0` expects object-form JSON formats:

```ts
{ type: "json", prompt, schema }
```

not plain `"json"`.

### AI SDK says `responseFormat` is unsupported

The Fireworks provider is OpenAI-compatible but the model needs structured outputs. The backend sets:

```ts
Object.defineProperty(fireworksExtractionModel, "supportsStructuredOutputs", {
  value: true,
  configurable: true,
});
```

### Coda rejects `Invalid "value" field in a cell`

Coda does not accept `null` cell values or object cell values. The backend now omits nulls and coerces objects before posting rows.

### SKU is missing on Amazon

The prompt includes SKU-like aliases:

- SKU
- Model Number
- Item Model Number
- Product Code
- Part Number
- Style Number
- ASIN

For Amazon, it prefers Model Number / Item Model Number when present and falls back to ASIN.

## Repository Notes

This project started from an Express generator template, so legacy files like `app.js`, `bin/www`, `routes/`, and `views/` still exist. The active backend is [server.ts](./server.ts).

## Useful Commands

```bash
pnpm run dev
pnpm run build
pnpm start
```
