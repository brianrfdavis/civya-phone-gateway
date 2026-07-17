import { createHash } from "node:crypto";
import { z } from "zod";

const countyRecordSchema = z.object({
  externalRecordId: z.string().min(1).max(200),
  recordType: z.enum(["property_tax_case", "notice", "plan_status", "case_status"]),
  parcelId: z.string().min(1).max(80),
  taxYear: z.number().int().min(1900).max(2200),
  effectiveAt: z.string().datetime(),
  retracted: z.boolean().default(false),
  fields: z.record(z.string(), z.unknown()),
});

const countyBatchSchema = z.object({
  tenantSlug: z.string().regex(/^[a-z0-9-]+$/),
  sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/),
  externalBatchId: z.string().min(1).max(200),
  schemaVersion: z.string().min(1).max(80),
  sourceGeneratedAt: z.string().datetime(),
  declaredRecordCount: z.number().int().nonnegative(),
  declaredControlTotal: z.string().regex(/^[0-9a-f]{64}$/),
  records: z.array(countyRecordSchema).max(200_000),
});

export type CountySourceRecord = z.infer<typeof countyRecordSchema>;
export type CountySourceBatch = z.infer<typeof countyBatchSchema>;

export interface ValidatedCountyBatch {
  batch: CountySourceBatch;
  computedControlTotal: string;
  recordCount: number;
  disposition: "accepted";
}

export class CountyBatchValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CountyBatchValidationError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
}

export function computeCountyBatchControlTotal(records: readonly CountySourceRecord[]): string {
  const canonical = records
    .map((record) => canonicalize(record))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateCountyBatch(input: unknown): ValidatedCountyBatch {
  const parsed = countyBatchSchema.safeParse(input);
  if (!parsed.success) {
    throw new CountyBatchValidationError("county_batch_schema_invalid", "County batch does not match the versioned contract.");
  }
  const batch = parsed.data;
  if (batch.declaredRecordCount !== batch.records.length) {
    throw new CountyBatchValidationError(
      "county_batch_count_mismatch",
      "Declared and received County record counts do not match.",
    );
  }
  const keys = new Set<string>();
  for (const record of batch.records) {
    const key = `${record.recordType}:${record.externalRecordId}`;
    if (keys.has(key)) {
      throw new CountyBatchValidationError("county_batch_duplicate_record", "County batch contains a duplicate record identifier.");
    }
    keys.add(key);
  }
  const computedControlTotal = computeCountyBatchControlTotal(batch.records);
  if (computedControlTotal !== batch.declaredControlTotal) {
    throw new CountyBatchValidationError(
      "county_batch_control_total_mismatch",
      "County batch control total does not match the received records.",
    );
  }
  return { batch, computedControlTotal, recordCount: batch.records.length, disposition: "accepted" };
}
