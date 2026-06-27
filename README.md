# Coda Express Web Clipper Backend

Express backend for a web-clipping workflow that saves arbitrary product/page data into user-selected Coda tables.

The core trick is that the Coda table schema is not known ahead of time. The browser extension sends a URL plus a Coda doc/table target, and the backend fetches that table's columns at runtime, builds a matching Zod schema dynamically, asks Fireworks AI to extract structured data from Firecrawl output, then writes the row to Coda.

## Architecture

```text
Browser extension
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
- Fireworks model: configurable with `FIREWORKS_MODEL`
- Coda API for schema lookup and row insertion
- Zod for dynamic runtime extraction schemas

## Endpoints

### `GET /api/docs`

Interactive Swagger UI generated from the OpenAPI document.

### `GET /api/openapi.json`

Raw OpenAPI 3.0 document for API clients, documentation tooling, and contract checks.

### `POST /api/save-bookmark`

Publisher endpoint used by the browser extension.

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

Compatibility fallback: `codaToken` may still be provided in the JSON body, but the preferred path is the `Authorization` header.

Response:

```json
{
  "ok": true,
  "workflowRunId": "wfr_..."
}
```

### `POST /api/workflow/save-bookmark`

Upstash Workflow worker endpoint. Do not call this directly from the client.

## Environment Variables

See [.env.example](./.env.example).

```env
PORT=3000
API_KEY=
FIREWORKS_API_KEY=
FIREWORKS_MODEL=accounts/fireworks/models/gpt-oss-20b
FIRECRAWL_API_KEY=
B2_KEY_ID=
B2_KEY_SECRET=
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
B2_BUCKET_NAME=
QSTASH_URL=
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
```

### `API_KEY`

Shared secret required by `/api/save-bookmark` in the `x-api-key` header.

### `FIREWORKS_API_KEY`

Fireworks API key used by the AI SDK Fireworks provider.

### `FIREWORKS_MODEL`

Optional Fireworks model id used for AI extraction. Defaults to `accounts/fireworks/models/gpt-oss-20b`.

### `FIRECRAWL_API_KEY`

Firecrawl API key used for page scraping.

### `B2_KEY_ID`, `B2_KEY_SECRET`, `B2_ENDPOINT`, `B2_BUCKET_NAME`

Optional Backblaze B2 S3-compatible config used to mirror saved image cells into a public B2 bucket before saving rows to Coda. If any of these are missing, image mirroring is disabled and original image URLs are saved.

`B2_ENDPOINT` should include the protocol, for example:

```env
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
```

If the protocol is omitted, the backend normalizes it to `https://`. The bucket must be public because Coda hotlinks the generated B2 URLs.

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

Open the generated API docs:

```text
http://localhost:3000/api/docs
```

Type-check:

```bash
pnpm run build
```

The local server listens on `PORT`, defaulting to `3000`.

## Vercel Deployment

Vercel deploys this backend through its captured Node server support. The active entrypoint is [server.ts](./server.ts), which starts the Express app with `app.listen(...)`.

Required Vercel env vars:

- `API_KEY`
- `FIREWORKS_API_KEY`
- `FIRECRAWL_API_KEY`
- `B2_KEY_ID` (optional; enables image mirroring)
- `B2_KEY_SECRET` (optional; enables image mirroring)
- `B2_ENDPOINT` (optional; enables image mirroring)
- `B2_BUCKET_NAME` (optional; enables image mirroring)
- `QSTASH_URL`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

After changing backend code, redeploy before testing new workflow runs. Existing Upstash workflow runs can still reflect old deployed code.

## Browser Extension

The matching browser extension lives here:

[rheactdev/coda-express-extension](https://github.com/rheactdev/coda-express-extension)

The extension should:

- Let the user configure this backend's deployed base URL.
- Let the user configure or retrieve a Coda API token securely.
- Send the Coda token as `Authorization: Bearer ...`.
- Send the backend shared secret as `x-api-key`.
- Send only `url`, `docId`, and `tableId` in the JSON body.

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

The model can be set with `FIREWORKS_MODEL`:

```env
FIREWORKS_MODEL=accounts/fireworks/models/gpt-oss-20b
```

### Token Budget Controls

The extraction prompt is intentionally compact:

- JSON blocks are minified instead of pretty-printed.
- Full Coda column objects are reduced to only name, type, description, multi-value support, and capped existing options.
- Relation/select options are capped with `MAX_EXISTING_OPTIONS_IN_PROMPT`.
- Markdown is truncated with `MAX_MARKDOWN_CHARS`.
- When Firecrawl structured product data is available, markdown is truncated more aggressively with `MAX_MARKDOWN_CHARS_WITH_STRUCTURED_DATA`.
- Metadata and structured data are separately bounded.

The current constants live near the top of [server.ts](./server.ts):

```ts
MAX_MARKDOWN_CHARS
MAX_MARKDOWN_CHARS_WITH_STRUCTURED_DATA
MAX_METADATA_CHARS
MAX_STRUCTURED_DATA_CHARS
MAX_COLUMN_DESCRIPTION_CHARS
MAX_EXISTING_OPTIONS_IN_PROMPT
MAX_EXISTING_OPTION_CHARS
```

## Firecrawl Scraping

Shopify product pages use a fast path before Firecrawl. If the URL looks like:

```text
https://store.com/products/product-handle
```

the backend first tries:

```text
https://store.com/products/product-handle.js
```

When that public Shopify product JSON endpoint works, the workflow uses it directly as structured product data and avoids Firecrawl for that page.

Generic non-Shopify sites use Markdown.

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

## B2 Image Mirroring

When the B2 env vars are configured, the workflow mirrors image URLs that are actually being saved into image-like Coda columns before inserting the row. Image-like columns are Coda image columns or columns named like cover/image/photo/thumbnail/picture.

The save flow checks for duplicate bookmark URLs before mirroring images, so duplicate rows do not upload anything to B2. New image uploads use Backblaze B2's S3-compatible API with multipart upload and a fixed 200 MB per-image cap. Uploaded objects are stored under:

```text
coda-bookmarker/images/{sha256(sourceUrl)}.{ext}
```

The generated public URL uses the configured endpoint and bucket:

```text
{B2_ENDPOINT}/{B2_BUCKET_NAME}/coda-bookmarker/images/{hash}.{ext}
```

If download, validation, or upload fails, the row still saves with the original source image URL and the workflow logs a warning.

## Logging

Workflow errors are logged with detailed serialized error objects for debugging.

Only current `process.env` values are redacted from logs. This means page content, AI output, Coda API response details, and outgoing row payloads may appear in logs if an error occurs.

## Troubleshooting

### Vercel returns a platform `NOT_FOUND`

Make sure the deployment is using Vercel's captured Node server support from [server.ts](./server.ts). This repo intentionally does not use a `vercel.json` `builds` override, because that can bypass the captured-server detection path.

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

This project started from an Express generator template, so legacy folders like `routes/` and `views/` still exist. The active backend is [server.ts](./server.ts).

## Useful Commands

```bash
pnpm run dev
pnpm run build
pnpm start
```
