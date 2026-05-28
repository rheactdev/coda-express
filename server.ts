import crypto from "crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "dotenv";
import { Client } from "@upstash/workflow";
import { serve } from "@upstash/workflow/express";
import Firecrawl from "@mendable/firecrawl-js";
import { createFireworks } from "@ai-sdk/fireworks";
import { generateObject } from "ai";
import { z, type ZodTypeAny } from "zod";

config();

type SaveBookmarkPayload = {
  url: string;
  docId: string;
  tableId: string;
  codaToken?: string;
};

type WorkflowSaveBookmarkPayload = SaveBookmarkPayload & {
  codaToken: string;
};

type CodaColumn = {
  id: string;
  name: string;
  type?: string;
  description?: string;
  calculated?: boolean;
  display?: boolean;
  formula?: string;
  format?: {
    type?: string;
    isArray?: boolean;
    limit?: number;
    maxItems?: number;
    maxSelectedItems?: number;
    tableId?: string;
    table?: {
      id?: string;
      name?: string;
    };
    options?: Array<{ display?: string; name?: string; value?: string } | string>;
  };
};

type CodaTable = {
  id: string;
  name: string;
  description?: string;
};

type TargetColumn = {
  name: string;
  type: string;
  description: string | null;
  existingOptions: string[];
  allowsMultipleValues: boolean;
  relationTableId?: string;
  relationDisplayColumnName?: string;
};

type ScrapeResult = {
  markdown: string;
  metadata: Record<string, unknown>;
  structuredData?: Record<string, unknown>;
};

const CODA_API_BASE = "https://coda.io/apis/v1";
const WORKFLOW_PATH = "/api/workflow/save-bookmark";
const FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2p6";
const API_KEY = requireEnv("API_KEY");
const MAX_MARKDOWN_CHARS = 18_000;
const MAX_MARKDOWN_CHARS_WITH_STRUCTURED_DATA = 8_000;
const MAX_METADATA_CHARS = 3_000;
const MAX_STRUCTURED_DATA_CHARS = 6_000;
const MAX_COLUMN_DESCRIPTION_CHARS = 240;
const MAX_EXISTING_OPTIONS_IN_PROMPT = 40;
const MAX_EXISTING_OPTION_CHARS = 80;

const app = express();

app.use(express.json({ limit: "1mb" }));

const workflowClient = new Client({
  baseUrl: process.env.QSTASH_URL,
  token: requireEnv("QSTASH_TOKEN"),
});

const firecrawl = new Firecrawl({
  apiKey: requireSecretEnv("FIRECRAWL_API_KEY"),
});

const fireworks = createFireworks({
  apiKey: requireSecretEnv("FIREWORKS_API_KEY"),
});
const fireworksExtractionModel = fireworks(FIREWORKS_MODEL);
Object.defineProperty(fireworksExtractionModel, "supportsStructuredOutputs", {
  value: true,
  configurable: true,
});

app.post("/api/save-bookmark", requireApiKey, async (req: Request, res: Response) => {
  const payload = parseSaveBookmarkPayload(req.body, getBearerToken(req));

  if (!payload.ok) {
    res.status(400).json({ error: payload.error });
    return;
  }

  try {
    const workflowUrl = getWorkflowUrl(req);
    const { workflowRunId } = await workflowClient.trigger({
      url: workflowUrl,
      body: payload.data,
      retries: 0,
      redact: {
        body: true,
      },
    });

    res.status(200).json({ ok: true, workflowRunId });
  } catch (error) {
    logSanitizedError("trigger-workflow", error);
    res.status(500).json({
      ok: false,
      error: "Bookmark was accepted, but the background workflow could not be started.",
    });
  }
});

app.post(
  WORKFLOW_PATH,
  serve<WorkflowSaveBookmarkPayload>(async (context) => {
    const payload = context.requestPayload;

    const input = await context.run("validate-payload", async () => {
      const parsed = parseSaveBookmarkPayload(payload, payload.codaToken);

      if (!parsed.ok) {
        throw new Error("Invalid workflow payload.");
      }

      return parsed.data;
    });

    const scraped = await context.run("scrape", () =>
      runWorkflowStep("scrape", () => scrapeUrl(input.url)),
    );

    const codaSchema = await context.run("fetch-coda-schema", () =>
      runWorkflowStep("fetch-coda-schema", () =>
        fetchCodaSchema(input.docId, input.tableId, input.codaToken),
      ),
    );

    const extracted = await context.run("extract-data", () =>
      runWorkflowStep("extract-data", () => extractData(scraped, codaSchema)),
    );

    await context.run("save-to-coda", () =>
      runWorkflowStep("save-to-coda", () =>
        saveToCoda(input.docId, input.tableId, input.codaToken, extracted, codaSchema.columns),
      ),
    );
  }),
);

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3000);

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default app;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requireSecretEnv(name: string): string {
  return requireEnv(name).replace(/^Bearer\s+/i, "");
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.header("x-api-key");

  if (!apiKey || !constantTimeEquals(apiKey, API_KEY)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function getWorkflowUrl(req: Request): string {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto ?? req.protocol;
  return `${protocol}://${req.get("host")}${WORKFLOW_PATH}`;
}

function parseSaveBookmarkPayload(
  body: unknown,
  codaTokenFromAuth?: string,
): { ok: true; data: WorkflowSaveBookmarkPayload } | { ok: false; error: string } {
  const schema = z.object({
    url: z.string().url(),
    docId: z.string().min(1),
    tableId: z.string().min(1),
    codaToken: z.string().min(1).optional(),
  });

  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, error: "Request must include url, docId, and tableId." };
  }

  const codaToken = codaTokenFromAuth ?? result.data.codaToken;

  if (!codaToken) {
    return { ok: false, error: "Request must include a Coda token in Authorization: Bearer ... or codaToken." };
  }

  const docId = normalizeCodaIdentifier(result.data.docId);
  const tableId = normalizeCodaIdentifier(result.data.tableId);

  return {
    ok: true,
    data: {
      ...result.data,
      docId,
      tableId,
      codaToken: codaToken.replace(/^Bearer\s+/i, "").trim(),
    },
  };
}

function normalizeCodaIdentifier(value: string): string {
  const trimmed = value.trim();

  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPathPart = pathParts.at(-1);
    const hash = url.hash.slice(1);
    return hash || extractTrailingCodaId(lastPathPart) || trimmed;
  } catch {
    return extractTrailingCodaId(trimmed) || trimmed;
  }
}

function extractTrailingCodaId(value: string | undefined): string | undefined {
  return value?.match(/(?:^|_)([A-Za-z]+[-_][A-Za-z0-9_-]+)$/)?.[1];
}

function getBearerToken(req: Request): string | undefined {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

async function runWorkflowStep<T>(stepName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logWorkflowError(stepName, error);
    throw new Error(`Workflow step failed: ${stepName}: ${formatErrorForLog(error)}`);
  }
}

async function scrapeUrl(url: string): Promise<ScrapeResult> {
  const shopifyProduct = await fetchShopifyProduct(url);

  if (shopifyProduct) {
    return {
      markdown: shopifyProductToMarkdown(shopifyProduct),
      metadata: {
        source: "shopify-product-json",
        url,
      },
      structuredData: shopifyProduct,
    };
  }

  const structuredScrapeSchema = getStructuredScrapeSchema(url);
  const scrapeOptions = {
    formats: structuredScrapeSchema
      ? [
          "markdown",
          {
            type: "json",
            prompt: "Extract structured product listing data from this page.",
            schema: structuredScrapeSchema,
          },
        ]
      : ["markdown"],
    onlyMainContent: true,
  };
  const client = firecrawl as unknown as {
    scrape?: (url: string, options: typeof scrapeOptions) => Promise<unknown>;
    scrapeUrl?: (url: string, options: typeof scrapeOptions) => Promise<unknown>;
  };
  const scrape = client.scrape ?? client.scrapeUrl;

  if (!scrape) {
    throw new Error("Installed Firecrawl SDK does not expose a scrape method.");
  }

  const response = await scrape.call(client, url, scrapeOptions);
  const responseRecord = asRecord(response);

  if (responseRecord?.success === false) {
    const error = asString(responseRecord.error) ?? "Unknown Firecrawl scrape error.";
    throw new Error(`Firecrawl scrape failed: ${error}`);
  }

  const markdown = getFirecrawlMarkdown(response);
  if (!markdown) {
    throw new Error("Firecrawl returned no markdown.");
  }

  const metadata = getFirecrawlMetadata(response);
  const structuredData = getFirecrawlJson(response);

  return { markdown, metadata, structuredData };
}

const AmazonProductSchema = z.object({
  title: z.string().nullable(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  availability: z.string().nullable(),
  rating: z.string().nullable(),
  reviewCount: z.string().nullable(),
  brand: z.string().nullable(),
  asin: z.string().nullable(),
  modelNumber: z.string().nullable(),
  itemModelNumber: z.string().nullable(),
  productImage: z.string().nullable(),
  imageUrls: z.array(z.string()).nullable(),
  features: z.array(z.string()).nullable(),
});

const EtsyListingSchema = z.object({
  title: z.string().nullable(),
  price: z.string().nullable(),
  currency: z.string().nullable(),
  shopName: z.string().nullable(),
  shopUrl: z.string().nullable(),
  rating: z.string().nullable(),
  reviewCount: z.string().nullable(),
  availability: z.string().nullable(),
  listingId: z.string().nullable(),
  productImage: z.string().nullable(),
  imageUrls: z.array(z.string()).nullable(),
  description: z.string().nullable(),
  variations: z.array(z.string()).nullable(),
  materials: z.array(z.string()).nullable(),
});

type ShopifyProductData = {
  title: string | null;
  vendor: string | null;
  productType: string | null;
  handle: string | null;
  description: string | null;
  price: number | null;
  compareAtPrice: number | null;
  currency: string | null;
  availability: string | null;
  sku: string | null;
  productImage: string | null;
  imageUrls: string[];
  variants: Array<{
    title: string | null;
    sku: string | null;
    price: number | null;
    compareAtPrice: number | null;
    available: boolean | null;
  }>;
  tags: string[];
};

async function fetchShopifyProduct(url: string): Promise<ShopifyProductData | undefined> {
  const productJsonUrl = getShopifyProductJsonUrl(url);
  if (!productJsonUrl) {
    return undefined;
  }

  try {
    const response = await fetch(productJsonUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const product = asRecord(await response.json());
    if (!product?.title) {
      return undefined;
    }

    return normalizeShopifyProduct(product);
  } catch {
    return undefined;
  }
}

function getShopifyProductJsonUrl(value: string): string | undefined {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    return undefined;
  }

  const match = parsedUrl.pathname.match(/^(.*\/products\/[^/?#]+)(?:\/)?$/);
  if (!match) {
    return undefined;
  }

  return `${parsedUrl.origin}${match[1]}.js`;
}

function normalizeShopifyProduct(product: Record<string, unknown>): ShopifyProductData {
  const variants = asArrayOfRecords(product.variants);
  const imageUrls = getShopifyImageUrls(product);
  const firstVariant = variants[0];
  const selectedVariant = variants.find((variant) => variant.available === true) ?? firstVariant;
  const tags = Array.isArray(product.tags)
    ? product.tags.filter((tag): tag is string => typeof tag === "string")
    : typeof product.tags === "string"
      ? product.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      : [];

  return {
    title: asString(product.title) ?? null,
    vendor: asString(product.vendor) ?? null,
    productType: asString(product.type) ?? null,
    handle: asString(product.handle) ?? null,
    description: stripHtml(asString(product.description) ?? asString(product.content) ?? "") || null,
    price: toShopifyPrice(selectedVariant?.price ?? product.price),
    compareAtPrice: toShopifyPrice(selectedVariant?.compare_at_price ?? product.compare_at_price),
    currency: asString(product.currency) ?? null,
    availability: selectedVariant?.available === true ? "in stock" : selectedVariant?.available === false ? "out of stock" : null,
    sku: asString(selectedVariant?.sku) ?? null,
    productImage: imageUrls[0] ?? null,
    imageUrls,
    variants: variants.map((variant) => ({
      title: asString(variant.title) ?? null,
      sku: asString(variant.sku) ?? null,
      price: toShopifyPrice(variant.price),
      compareAtPrice: toShopifyPrice(variant.compare_at_price),
      available: typeof variant.available === "boolean" ? variant.available : null,
    })),
    tags,
  };
}

function shopifyProductToMarkdown(product: ShopifyProductData): string {
  return [
    `Title: ${product.title ?? ""}`,
    `Vendor: ${product.vendor ?? ""}`,
    `Product type: ${product.productType ?? ""}`,
    `Price: ${product.price ?? ""}`,
    `Compare at price: ${product.compareAtPrice ?? ""}`,
    `Availability: ${product.availability ?? ""}`,
    `SKU: ${product.sku ?? ""}`,
    `Image: ${product.productImage ?? ""}`,
    `Tags: ${product.tags.join(", ")}`,
    "",
    product.description ?? "",
  ].join("\n");
}

function asArrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record): record is Record<string, unknown> => Boolean(record)) : [];
}

function toShopifyPrice(value: unknown): number | null {
  if (typeof value === "number") {
    return value > 999 ? value / 100 : value;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? (numericValue > 999 ? numericValue / 100 : numericValue) : null;
  }

  return null;
}

function getShopifyImageUrls(product: Record<string, unknown>): string[] {
  const variants = asArrayOfRecords(product.variants);
  const imageCandidates = [
    product.featured_image,
    asRecord(product.featured_media)?.preview_image,
    ...asUnknownArray(product.images),
    ...asUnknownArray(product.media),
    ...variants.map((variant) => variant.featured_image ?? variant.image),
  ];

  return dedupeStrings(
    imageCandidates
      .flatMap(extractShopifyImageUrls)
      .map(normalizeShopifyImageUrl)
      .filter((url): url is string => Boolean(url)),
  );
}

function extractShopifyImageUrls(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(extractShopifyImageUrls);
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  return [
    record.src,
    record.url,
    record.preview_image,
    record.featured_image,
    record.image,
    record.original_src,
  ].flatMap(extractShopifyImageUrls);
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeShopifyImageUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return undefined;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function getStructuredScrapeSchema(url: string): typeof AmazonProductSchema | typeof EtsyListingSchema | undefined {
  if (isAmazonUrl(url)) {
    return AmazonProductSchema;
  }

  if (isEtsyUrl(url)) {
    return EtsyListingSchema;
  }

  return undefined;
}

function isAmazonUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
    return hostname === "amazon.com" || hostname.endsWith(".amazon.com");
  } catch {
    return false;
  }
}

function isEtsyUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
    return hostname === "etsy.com" || hostname.endsWith(".etsy.com");
  } catch {
    return false;
  }
}

async function fetchCodaSchema(
  docId: string,
  tableId: string,
  codaToken: string,
): Promise<{ table: CodaTable; columns: TargetColumn[] }> {
  const encodedDocId = encodeURIComponent(docId);
  const encodedTableId = encodeURIComponent(tableId);
  const [table, columnsResponse] = await Promise.all([
    codaFetch<CodaTable>(`/docs/${encodedDocId}/tables/${encodedTableId}`, codaToken),
    codaFetch<{ items: CodaColumn[] }>(`/docs/${encodedDocId}/tables/${encodedTableId}/columns`, codaToken),
  ]);

  const columns: TargetColumn[] = [];

  for (const column of columnsResponse.items ?? []) {
    if (isWritableColumn(column) === false) {
      continue;
    }

    const type = normalizeCodaType(column);
    const relationTableId = getRelationTableId(column);
    const relationMetadata = relationTableId
      ? await fetchRelationMetadata(docId, relationTableId, codaToken)
      : undefined;
    const existingOptions = relationMetadata?.existingOptions ?? getStaticOptions(column);

    columns.push({
      name: column.name,
      type,
      description: column.description || null,
      existingOptions,
      allowsMultipleValues: allowsMultipleValues(column),
      relationTableId,
      relationDisplayColumnName: relationMetadata?.displayColumnName,
    });
  }

  if (columns.length === 0) {
    throw new Error("No writable Coda columns found.");
  }

  return { table, columns };
}

async function fetchRelationMetadata(
  docId: string,
  relationTableId: string,
  codaToken: string,
): Promise<{ existingOptions: string[]; displayColumnName: string }> {
  const encodedDocId = encodeURIComponent(docId);
  const encodedTableId = encodeURIComponent(relationTableId);
  const [columns, rows] = await Promise.all([
    codaFetch<{ items: CodaColumn[] }>(`/docs/${encodedDocId}/tables/${encodedTableId}/columns`, codaToken),
    codaFetch<{ items: Array<{ name?: string; values?: Record<string, unknown> }> }>(
      `/docs/${encodedDocId}/tables/${encodedTableId}/rows?useColumnNames=true&limit=500`,
      codaToken,
    ),
  ]);

  return {
    existingOptions: dedupeStrings(
      (rows.items ?? [])
        .map((row) => row.name ?? firstStringValue(row.values))
        .filter((value): value is string => Boolean(value)),
    ),
    displayColumnName: getRelationDisplayColumnName(columns.items ?? []),
  };
}

async function extractData(
  scraped: ScrapeResult,
  codaSchema: { table: CodaTable; columns: TargetColumn[] },
): Promise<Record<string, unknown>> {
  const schema = buildExtractionSchema(codaSchema.columns);
  const hasStructuredData = Boolean(scraped.structuredData);
  const markdownBudget = hasStructuredData ? MAX_MARKDOWN_CHARS_WITH_STRUCTURED_DATA : MAX_MARKDOWN_CHARS;

  const { object } = await generateObject({
    model: fireworksExtractionModel,
    schema,
    maxRetries: 0,
    system: [
      "Extract JSON for a Coda table from scraped page data.",
      "Use exact keys only. If absent, return null.",
      "Prefer structured product data over markdown.",
      "For relation/select fields, use the column name and description to decide what belongs.",
      "For multi-select fields, include all values that are useful for browsing/filtering later.",
      "For single-select fields, choose the one value that is most useful for browsing/filtering later.",
      "Use existing options when they fit. Create a concise new value when none fit.",
      "Be concise. No commentary.",
    ].join("\n"),
    prompt: [
      `table=${codaSchema.table.name}`,
      codaSchema.table.description ? `tableDescription=${truncateString(codaSchema.table.description, 300)}` : "",
      `columns=${stringifyBounded(getPromptColumns(codaSchema.columns), MAX_METADATA_CHARS)}`,
      `metadata=${stringifyBounded(scraped.metadata, MAX_METADATA_CHARS)}`,
      scraped.structuredData
        ? `structuredProductData=${stringifyBounded(scraped.structuredData, MAX_STRUCTURED_DATA_CHARS)}`
        : "",
      `markdown=${truncateString(scraped.markdown, markdownBudget)}`,
    ].join("\n"),
  });

  return object as Record<string, unknown>;
}

function getPromptColumns(columns: TargetColumn[]) {
  return columns.map((column) => ({
    name: column.name,
    type: column.type,
    description: column.description ? truncateString(column.description, MAX_COLUMN_DESCRIPTION_CHARS) : null,
    multiple: column.allowsMultipleValues,
    options: getPromptExistingOptions(column.existingOptions),
  }));
}

function getPromptExistingOptions(options: string[]): string[] {
  return options
    .slice(0, MAX_EXISTING_OPTIONS_IN_PROMPT)
    .map((option) => truncateString(option, MAX_EXISTING_OPTION_CHARS));
}

function comparableTokenSet(value: string): Set<string> {
  return new Set(normalizeComparableText(value).split(" ").filter(Boolean).map(singularizeToken));
}

function singularizeToken(value: string): string {
  if (value.endsWith("ies") && value.length > 4) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith("s") && value.length > 3) {
    return value.slice(0, -1);
  }

  return value;
}

function stringifyBounded(value: unknown, maxChars: number): string {
  return truncateString(JSON.stringify(value), maxChars);
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

async function saveToCoda(
  docId: string,
  tableId: string,
  codaToken: string,
  extracted: Record<string, unknown>,
  columns: TargetColumn[],
): Promise<{ id?: string; requestId?: string }> {
  await ensureRelationRowsExist(docId, codaToken, extracted, columns);

  const columnMap = new Map(columns.map((column) => [column.name, column]));
  const cells = Object.entries(extracted)
    .map(([column, value]) => ({
      column,
      value: toCodaCellValue(value, columnMap.get(column) ?? column),
    }))
    .filter(
      (cell): cell is { column: string; value: Exclude<CodaCellValue, null> } =>
        cell.value !== undefined && cell.value !== null,
    );

  if (cells.length === 0) {
    throw new Error("No extracted cells to save.");
  }

  const body = {
    rows: [{ cells }],
    useColumnNames: true,
  };

  console.info(`Coda save payload ${formatErrorForLog(body)}`);

  return codaFetch(`/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}/rows`, codaToken, {
    method: "POST",
    body: JSON.stringify(body),
    logContext: {
      codaRowPayload: body,
    },
  });
}

type CodaScalarValue = boolean | number | string;
type CodaCellValue = CodaScalarValue | CodaScalarValue[] | null;

async function ensureRelationRowsExist(
  docId: string,
  codaToken: string,
  extracted: Record<string, unknown>,
  columns: TargetColumn[],
): Promise<void> {
  for (const column of columns) {
    if (!column.relationTableId || !column.relationDisplayColumnName) {
      continue;
    }

    const rawValue = extracted[column.name];
    const values = getRelationStringValues(rawValue)
      .map((value) => normalizeExtractedStringValue(value, column))
      .filter((value) => shouldCreateRelationOption(value, column.existingOptions));

    if (values.length === 0) {
      continue;
    }

    await createRelationRows(docId, codaToken, column, dedupeStrings(values));
  }
}

function getRelationStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  }

  return [];
}

function shouldCreateRelationOption(value: string, existingOptions: string[]): boolean {
  return !findCoveringExistingOption(value, existingOptions);
}

async function createRelationRows(
  docId: string,
  codaToken: string,
  column: TargetColumn,
  values: string[],
): Promise<void> {
  const body = {
    rows: values.map((value) => ({
      cells: [
        {
          column: column.relationDisplayColumnName,
          value,
        },
      ],
    })),
    useColumnNames: true,
  };

  console.info(`Coda relation row payload ${formatErrorForLog({ relationColumn: column.name, relationTableId: column.relationTableId, body })}`);

  const response = await codaFetch<{ requestId?: string }>(
    `/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(column.relationTableId!)}/rows`,
    codaToken,
    {
      method: "POST",
      body: JSON.stringify(body),
      logContext: {
        codaRelationRowPayload: body,
      },
    },
  );

  if (response.requestId) {
    await waitForCodaMutation(codaToken, response.requestId);
  }

  column.existingOptions.push(...values);
}

function toCodaCellValue(value: unknown, column?: TargetColumn | string): CodaCellValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return normalizeExtractedStringValue(value, column);
  }

  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const values = value
      .map(toCodaScalarValue)
      .filter((item): item is CodaScalarValue => item !== undefined);

    if (typeof column !== "string" && column?.allowsMultipleValues === false) {
      const selectedValue = values[0];
      return typeof selectedValue === "string"
        ? normalizeExtractedStringValue(selectedValue, column)
        : selectedValue;
    }

    return values.map((item) => (typeof item === "string" ? normalizeExtractedStringValue(item, column) : item));
  }

  const scalar = toCodaScalarValue(value);
  return typeof scalar === "string" ? normalizeExtractedStringValue(scalar, column) : scalar ?? JSON.stringify(value);
}

function toCodaScalarValue(value: unknown): CodaScalarValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate =
      record.name ??
      record.display ??
      record.value ??
      record.label ??
      record.url ??
      record.href ??
      record.text;

    if (typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean") {
      return candidate;
    }

    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeCodaStringValue(value: string, columnName?: string): string {
  if (columnName && isUrlColumnName(columnName)) {
    return normalizeUrlValue(value);
  }

  return value;
}

function normalizeExtractedStringValue(value: string, column?: TargetColumn | string): string {
  const columnName = typeof column === "string" ? column : column?.name;
  const normalizedValue = normalizeCodaStringValue(value, columnName);

  if (!column || typeof column === "string" || !isMultiValueType(column)) {
    return normalizedValue;
  }

  return findCoveringExistingOption(normalizedValue, column.existingOptions) ?? normalizedValue;
}

function findCoveringExistingOption(value: string, existingOptions: string[]): string | undefined {
  const normalizedValue = normalizeComparableText(value);
  if (!normalizedValue) {
    return undefined;
  }

  const exactMatch = existingOptions.find((option) => normalizeComparableText(option) === normalizedValue);
  if (exactMatch) {
    return exactMatch;
  }

  return existingOptions.find((option) => {
    const normalizedOption = normalizeComparableText(option);
    return normalizedOption !== normalizedValue && containsAllTokens(normalizedOption, normalizedValue);
  });
}

function containsAllTokens(container: string, contained: string): boolean {
  const containerTokens = comparableTokenSet(container);
  return [...comparableTokenSet(contained)].every((token) => containerTokens.has(token));
}

function isUrlColumnName(columnName: string): boolean {
  const normalizedName = columnName.toLowerCase();
  return /\b(url|link|href|source)\b/.test(normalizedName);
}

function normalizeUrlValue(value: string): string {
  return normalizeAmazonUrl(value) ?? value;
}

function normalizeAmazonUrl(value: string): string | undefined {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    return undefined;
  }

  const hostname = parsedUrl.hostname.replace(/^www\./i, "").toLowerCase();
  if (hostname !== "amazon.com" && !hostname.endsWith(".amazon.com")) {
    return undefined;
  }

  const asin =
    parsedUrl.pathname.match(/\/(?:dp|gp\/product|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1] ??
    parsedUrl.searchParams.get("asin") ??
    parsedUrl.searchParams.get("pd_rd_i");

  if (!asin) {
    return undefined;
  }

  return `https://www.amazon.com/dp/${asin.toUpperCase()}`;
}

function buildExtractionSchema(columns: TargetColumn[]) {
  const shape: Record<string, ZodTypeAny> = {};

  for (const column of columns) {
    shape[column.name] = mapCodaTypeToZod(column);
  }

  return z.object(shape).strict();
}

function mapCodaTypeToZod(column: TargetColumn): ZodTypeAny {
  const type = column.type.toLowerCase();
  const description = buildColumnDescription(column);

  if (type.includes("relation") || column.relationTableId) {
    if (column.allowsMultipleValues === false) {
      return z
        .string()
        .nullable()
        .describe(`${description} Return exactly one related item. Use the column name, description, and existing options to choose the value that is most useful for someone browsing or filtering the table later. Use an existing option when it fits; create a concise new value when no existing option fits.`);
    }

    return z
      .array(z.string())
      .nullable()
      .describe(`${description} Return all semantically relevant related items for this multi-select relation. Use the column name, description, and existing options to choose values that are useful for someone browsing or filtering the table later. Use existing options when they fit; create concise new values when no existing options fit.`);
  }

  if (type.includes("number") || type.includes("numeric") || type.includes("currency") || type.includes("percent")) {
    return z.number().nullable().describe(description);
  }

  if (type.includes("checkbox") || type.includes("boolean")) {
    return z.boolean().nullable().describe(description);
  }

  if (type.includes("date") || type.includes("time")) {
    return z.string().nullable().describe(`${description} Return ISO-8601 strings when possible.`);
  }

  if (type.includes("select") || type.includes("lookup") || type.includes("person")) {
    if (column.allowsMultipleValues === false) {
      return z
        .string()
        .nullable()
        .describe(`${description} Return exactly one value. Use the column name, description, and existing options to choose the value that is most useful for someone browsing or filtering the table later.`);
    }

    return z
      .array(z.string())
      .nullable()
      .describe(`${description} Return all semantically relevant values for this multi-select field, based on the column name and description.`);
  }

  if (type.includes("image") || type.includes("url") || type.includes("link")) {
    return z.string().url().nullable().or(z.string().nullable()).describe(description);
  }

  return z.string().nullable().describe(description);
}

function buildColumnDescription(column: TargetColumn): string {
  const parts = [`Coda type: ${column.type}.`];

  if (column.description) {
    parts.push(column.description);
  }

  const extractionHint = getColumnExtractionHint(column.name);
  if (extractionHint) {
    parts.push(extractionHint);
  }

  if (isMultiValueType(column) && column.allowsMultipleValues === false) {
    parts.push("This column accepts only one value. If multiple values fit, choose the one that best matches this column's name and description and will be most useful for browsing or filtering later.");
  }

  if (isMultiValueType(column) && column.allowsMultipleValues) {
    parts.push("This column accepts multiple values. Include every semantically relevant value based on this column's name and description that will be useful for browsing or filtering later.");
  }

  return parts.join(" ");
}

function getColumnExtractionHint(columnName: string): string | undefined {
  const normalizedName = columnName.toLowerCase();

  if (/\b(sku|model|model number|item number|product code|part number|asin)\b/.test(normalizedName)) {
    return [
      "For SKU-like fields, use the product identifier shown on the page.",
      "Accept labels such as SKU, Model Number, Model, Item Number, Item Model Number, Product Code, Part Number, Style Number, or ASIN.",
      "On Amazon pages, prefer Model Number or Item Model Number when present; otherwise use ASIN.",
    ].join(" ");
  }

  return undefined;
}

async function codaFetch<T>(
  path: string,
  codaToken: string,
  init: CodaFetchInit = {},
): Promise<T> {
  const { logContext, ...fetchInit } = init;
  const response = await fetch(`${CODA_API_BASE}${path}`, {
    ...fetchInit,
    headers: {
      Authorization: `Bearer ${codaToken}`,
      "Content-Type": "application/json",
      ...(fetchInit.headers ?? {}),
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    const responseDetails = getCodaErrorDetails(responseText);
    const contextDetails = logContext ? ` Context: ${formatErrorForLog(logContext)}` : "";
    throw new Error(
      `Coda API request failed with status ${response.status}${responseDetails ? `: ${responseDetails}` : ""}.${contextDetails}`,
    );
  }

  return (responseText ? JSON.parse(responseText) : {}) as T;
}

type CodaFetchInit = RequestInit & {
  logContext?: unknown;
};

async function waitForCodaMutation(codaToken: string, requestId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await codaFetch<Record<string, unknown>>(
      `/mutationStatus/${encodeURIComponent(requestId)}`,
      codaToken,
    );

    if (isCodaMutationComplete(status)) {
      return;
    }

    if (isCodaMutationFailed(status)) {
      throw new Error(`Coda mutation failed: ${formatErrorForLog(status)}`);
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for Coda mutation ${requestId}.`);
}

function isCodaMutationComplete(status: Record<string, unknown>): boolean {
  return (
    status.completed === true ||
    status.done === true ||
    status.status === "complete" ||
    status.status === "completed" ||
    status.status === "succeeded" ||
    status.state === "complete" ||
    status.state === "completed" ||
    status.state === "succeeded"
  );
}

function isCodaMutationFailed(status: Record<string, unknown>): boolean {
  return (
    status.status === "failed" ||
    status.status === "error" ||
    status.state === "failed" ||
    status.state === "error" ||
    Boolean(status.error)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWritableColumn(column: CodaColumn): boolean {
  if (column.calculated) {
    return false;
  }

  if (column.formula) {
    return false;
  }

  return Boolean(column.name);
}

function normalizeCodaType(column: CodaColumn): string {
  return column.format?.type ?? column.type ?? "Text";
}

function allowsMultipleValues(column: CodaColumn): boolean {
  const format = column.format;

  if (typeof format?.isArray === "boolean") {
    return format.isArray;
  }

  const configuredLimit = format?.maxSelectedItems ?? format?.maxItems ?? format?.limit;
  if (configuredLimit === 1) {
    return false;
  }

  return true;
}

function isMultiValueType(column: TargetColumn): boolean {
  const type = column.type.toLowerCase();
  return (
    type.includes("relation") ||
    type.includes("select") ||
    type.includes("lookup") ||
    type.includes("person") ||
    Boolean(column.relationTableId)
  );
}

function getRelationTableId(column: CodaColumn): string | undefined {
  const type = normalizeCodaType(column).toLowerCase();
  if (!type.includes("relation") && !column.format?.tableId && !column.format?.table?.id) {
    return undefined;
  }

  return column.format?.tableId ?? column.format?.table?.id;
}

function getRelationDisplayColumnName(columns: CodaColumn[]): string {
  const displayColumn = columns.find((column) => column.display && isWritableColumn(column));
  if (displayColumn) {
    return displayColumn.name;
  }

  const nameColumn = columns.find((column) => /^name$/i.test(column.name) && isWritableColumn(column));
  if (nameColumn) {
    return nameColumn.name;
  }

  const firstWritableColumn = columns.find(isWritableColumn);
  if (!firstWritableColumn) {
    throw new Error("Relation table has no writable display column.");
  }

  return firstWritableColumn.name;
}

function getStaticOptions(column: CodaColumn): string[] {
  const options = column.format?.options ?? [];
  return dedupeStrings(
    options
      .map((option) => {
        if (typeof option === "string") {
          return option;
        }
        return option.display ?? option.name ?? option.value;
      })
      .filter((value): value is string => Boolean(value)),
  );
}

function firstStringValue(values: Record<string, unknown> | undefined): string | undefined {
  if (!values) {
    return undefined;
  }

  for (const value of Object.values(values)) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getFirecrawlMarkdown(response: unknown): string {
  const data = getNestedRecord(response, "data");
  const topLevel = asRecord(response);

  return (
    asString(topLevel?.markdown) ??
    asString(data?.markdown) ??
    asString(topLevel?.content) ??
    asString(data?.content) ??
    ""
  );
}

function getFirecrawlMetadata(response: unknown): Record<string, unknown> {
  const data = getNestedRecord(response, "data");
  const topLevel = asRecord(response);
  const metadata = asRecord(topLevel?.metadata) ?? asRecord(data?.metadata);

  return metadata ?? {};
}

function getFirecrawlJson(response: unknown): Record<string, unknown> | undefined {
  const data = getNestedRecord(response, "data");
  const topLevel = asRecord(response);
  const json = topLevel?.json ?? data?.json;

  if (typeof json === "string") {
    try {
      return asRecord(JSON.parse(json));
    } catch {
      return undefined;
    }
  }

  return asRecord(json);
}

function getCodaErrorDetails(responseText: string): string {
  if (!responseText) {
    return "";
  }

  try {
    const parsed = JSON.parse(responseText) as unknown;
    const record = asRecord(parsed);
    return asString(record?.message) ?? asString(record?.error) ?? "";
  } catch {
    return responseText.slice(0, 250);
  }
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function logSanitizedError(step: string, error: unknown): void {
  logWorkflowError(step, error);
}

function logWorkflowError(step: string, error: unknown): void {
  console.error(`Workflow failure in step "${step}". ${formatErrorForLog(error)}`);
}

function formatErrorForLog(error: unknown): string {
  return redactEnvValues(stringifyForLog(serializeError(error)));
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    for (const key of Object.getOwnPropertyNames(error)) {
      if (!(key in serialized)) {
        serialized[key] = (error as unknown as Record<string, unknown>)[key];
      }
    }

    if ("cause" in error) {
      serialized.cause = serializeError(error.cause);
    }

    return serialized;
  }

  return error;
}

function redactEnvValues(value: string): string {
  let redacted = value;

  for (const [name, rawEnvValue] of Object.entries(process.env)) {
    if (!rawEnvValue || rawEnvValue.length < 8) {
      continue;
    }

    redacted = redacted.replaceAll(rawEnvValue, `[redacted env:${name}]`);
  }

  return redacted;
}

function stringifyForLog(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(
    value,
    (_key, nestedValue) => {
      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }

      if (nestedValue && typeof nestedValue === "object") {
        if (seen.has(nestedValue)) {
          return "[Circular]";
        }
        seen.add(nestedValue);
      }

      return nestedValue;
    },
    2,
  );
}
