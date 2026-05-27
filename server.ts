import express, { type Request, type Response } from "express";
import { Client } from "@upstash/workflow";
import { serve } from "@upstash/workflow/express";
import Firecrawl from "@mendable/firecrawl-js";
import { generateObject } from "ai";
import { z, type ZodTypeAny } from "zod";

type SaveBookmarkPayload = {
  url: string;
  docId: string;
  tableId: string;
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
const MODEL = "moonshotai/Kimi-K2.6";

const app = express();

app.use(express.json({ limit: "1mb" }));

const workflowClient = new Client({
  baseUrl: process.env.QSTASH_URL,
  token: requireEnv("QSTASH_TOKEN"),
});

const firecrawl = new Firecrawl({
  apiKey: requireEnv("FIRECRAWL_API_KEY"),
});

app.post("/api/save-bookmark", async (req: Request, res: Response) => {
  const payload = parseSaveBookmarkPayload(req.body);

  if (!payload.ok) {
    res.status(400).json({ error: payload.error });
    return;
  }

  try {
    const workflowUrl = getWorkflowUrl(req);
    const { workflowRunId } = await workflowClient.trigger({
      url: workflowUrl,
      body: payload.data,
      retries: 3,
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
  serve<SaveBookmarkPayload>(async (context) => {
    const payload = context.requestPayload;
    const parsed = parseSaveBookmarkPayload(payload);

    if (!parsed.ok) {
      throw new Error("Invalid workflow payload.");
    }

    const input = parsed.data;

    const scraped = await runWorkflowStep("scrape", () =>
      context.run("scrape", async () => scrapeUrl(input.url)),
    );

    const codaSchema = await runWorkflowStep("fetch-coda-schema", () =>
      context.run("fetch-coda-schema", async () =>
        fetchCodaSchema(input.docId, input.tableId, input.codaToken),
      ),
    );

    const extracted = await runWorkflowStep("extract-data", () =>
      context.run("extract-data", async () => extractData(scraped, codaSchema)),
    );

    await runWorkflowStep("save-to-coda", () =>
      context.run("save-to-coda", async () =>
        saveToCoda(input.docId, input.tableId, input.codaToken, extracted),
      ),
    );
  }),
);

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getWorkflowUrl(req: Request): string {
  const configuredBaseUrl = process.env.UPSTASH_WORKFLOW_URL ?? process.env.PUBLIC_BASE_URL;

  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/$/, "")}${WORKFLOW_PATH}`;
  }

  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto ?? req.protocol;
  return `${protocol}://${req.get("host")}${WORKFLOW_PATH}`;
}

function parseSaveBookmarkPayload(
  body: unknown,
): { ok: true; data: SaveBookmarkPayload } | { ok: false; error: string } {
  const schema = z.object({
    url: z.string().url(),
    docId: z.string().min(1),
    tableId: z.string().min(1),
    codaToken: z.string().min(1),
  });

  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, error: "Request must include url, docId, tableId, and codaToken." };
  }

  return { ok: true, data: result.data };
}

async function runWorkflowStep<T>(stepName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logSanitizedError(stepName, error);
    throw new Error(`Workflow step failed: ${stepName}`);
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

  const markdown = getFirecrawlMarkdown(response);
  if (!markdown) {
    throw new Error("Firecrawl returned no markdown.");
  }

  const metadata = getFirecrawlMetadata(response);

  if (process.env.NODE_ENV === "development") {
    console.log("Firecrawl scrape metadata", metadata);
  }

  return { markdown, metadata };
}

async function fetchCodaSchema(
  docId: string,
  tableId: string,
  codaToken: string,
): Promise<{ table: CodaTable; columns: TargetColumn[] }> {
  const [table, columnsResponse] = await Promise.all([
    codaFetch<CodaTable>(`/docs/${docId}/tables/${tableId}`, codaToken),
    codaFetch<{ items: CodaColumn[] }>(`/docs/${docId}/tables/${tableId}/columns`, codaToken),
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
    `/docs/${docId}/tables/${relationTableId}/rows?useColumnNames=true&limit=500`,
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
    model: MODEL,
    schema,
    providerOptions: {
      gateway: {
        zeroDataRetention: true,
      },
    },
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

  if (process.env.NODE_ENV === "development") {
    console.log("AI extraction result", object);
  }

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

  return codaFetch(`/docs/${docId}/tables/${tableId}/rows`, codaToken, {
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
    return z.string().nullable().describe(description);
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
    return z.string().nullable().describe(description);
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

  if (!response.ok) {
    throw new Error(`Coda API request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
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
  if (process.env.NODE_ENV === "development" && error instanceof Error) {
    console.error(`Workflow failure in step "${step}". ${error.message}`);
    return;
  }

  console.error(`Workflow failure in step "${step}".`);
}
