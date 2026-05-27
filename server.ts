import express, { type Request, type Response } from "express";
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
  formula?: string;
  format?: {
    type?: string;
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
  relationTableId?: string;
};

type ScrapeResult = {
  markdown: string;
  metadata: Record<string, unknown>;
};

const CODA_API_BASE = "https://coda.io/apis/v1";
const WORKFLOW_PATH = "/api/workflow/save-bookmark";
const FIREWORKS_MODEL = "accounts/fireworks/models/kimi-k2p6";

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

app.post("/api/save-bookmark", async (req: Request, res: Response) => {
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
        saveToCoda(input.docId, input.tableId, input.codaToken, extracted),
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
  const scrapeOptions = {
    formats: ["markdown"],
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

  return { markdown, metadata };
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
    const existingOptions = relationTableId
      ? await fetchRelationOptions(docId, relationTableId, codaToken)
      : getStaticOptions(column);

    columns.push({
      name: column.name,
      type,
      description: column.description || null,
      existingOptions,
      relationTableId,
    });
  }

  if (columns.length === 0) {
    throw new Error("No writable Coda columns found.");
  }

  return { table, columns };
}

async function fetchRelationOptions(
  docId: string,
  relationTableId: string,
  codaToken: string,
): Promise<string[]> {
  const rows = await codaFetch<{ items: Array<{ name?: string; values?: Record<string, unknown> }> }>(
    `/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(relationTableId)}/rows?useColumnNames=true&limit=500`,
    codaToken,
  );

  return dedupeStrings(
    (rows.items ?? [])
      .map((row) => row.name ?? firstStringValue(row.values))
      .filter((value): value is string => Boolean(value)),
  );
}

async function extractData(
  scraped: ScrapeResult,
  codaSchema: { table: CodaTable; columns: TargetColumn[] },
): Promise<Record<string, unknown>> {
  const schema = buildExtractionSchema(codaSchema.columns);
  const relationContext = codaSchema.columns
    .filter((column) => column.existingOptions.length > 0)
    .map(
      (column) =>
        `- ${column.name}: ${column.existingOptions.map((option) => JSON.stringify(option)).join(", ")}`,
    )
    .join("\n");

  const { object } = await generateObject({
    model: fireworksExtractionModel,
    schema,
    maxRetries: 0,
    system: [
      "You extract structured data for a Coda table from scraped webpage markdown.",
      "Never hallucinate. If a value for a column is not present in the markdown or metadata, return null.",
      "Use the exact schema keys provided. Do not add extra fields.",
      "For relation columns, first map the context to an existing option string when a reasonable match exists.",
      "Only generate a new fallback string for a relation column if no existing option fits.",
      "Use concise scalar values. Preserve source facts and avoid commentary.",
    ].join("\n"),
    prompt: [
      `Target Coda table: ${codaSchema.table.name}`,
      codaSchema.table.description ? `Table description: ${codaSchema.table.description}` : "",
      "",
      "Target columns:",
      JSON.stringify(codaSchema.columns, null, 2),
      "",
      relationContext ? `Allowed existing relation/options:\n${relationContext}` : "",
      "",
      "Scraped metadata:",
      JSON.stringify(scraped.metadata, null, 2),
      "",
      "Scraped markdown:",
      scraped.markdown,
    ].join("\n"),
  });

  return object as Record<string, unknown>;
}

async function saveToCoda(
  docId: string,
  tableId: string,
  codaToken: string,
  extracted: Record<string, unknown>,
): Promise<{ id?: string; requestId?: string }> {
  const cells = Object.entries(extracted)
    .filter(([, value]) => value !== undefined)
    .map(([column, value]) => ({
      column,
      value,
    }));

  if (cells.length === 0) {
    throw new Error("No extracted cells to save.");
  }

  return codaFetch(`/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}/rows`, codaToken, {
    method: "POST",
    body: JSON.stringify({
      rows: [{ cells }],
      useColumnNames: true,
    }),
  });
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
    return z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .describe(`${description} Return a string for one related item or an array of strings for multiple related items.`);
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
    return z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .describe(`${description} Return a string for one value or an array of strings for multiple values.`);
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

  if (column.existingOptions.length > 0) {
    parts.push(`Existing options: ${column.existingOptions.join(", ")}.`);
  }

  return parts.join(" ");
}

async function codaFetch<T>(
  path: string,
  codaToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${CODA_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${codaToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    const responseDetails = getCodaErrorDetails(responseText);
    throw new Error(
      `Coda API request failed with status ${response.status}${responseDetails ? `: ${responseDetails}` : ""}.`,
    );
  }

  return JSON.parse(responseText) as T;
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

function getRelationTableId(column: CodaColumn): string | undefined {
  const type = normalizeCodaType(column).toLowerCase();
  if (!type.includes("relation") && !column.format?.tableId && !column.format?.table?.id) {
    return undefined;
  }

  return column.format?.tableId ?? column.format?.table?.id;
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
