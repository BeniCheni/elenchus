import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { SeatRecord } from "./types.js";

const schemaPath = fileURLToPath(new URL("../schema/seat-record-1.1.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate: ValidateFunction = ajv.compile(schema);

export type SchemaResult =
  | { ok: true; record: SeatRecord }
  | { ok: false; reason: string };

export function validateSeatRecord(value: unknown): SchemaResult {
  if (validate(value)) return { ok: true, record: value as SeatRecord };
  return { ok: false, reason: formatErrors(validate.errors) };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "schema validation failed";
  return errors
    .map((error) => {
      const where = error.instancePath || "/";
      return `${where} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}
