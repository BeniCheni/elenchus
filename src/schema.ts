import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { SeatRecord } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateLegacy = compile("1.1");
const validateCurrent = compile("1.2");

function compile(version: string): ValidateFunction {
  const file = fileURLToPath(new URL(`../schema/seat-record-${version}.json`, import.meta.url));
  return ajv.compile(JSON.parse(readFileSync(file, "utf8")) as object);
}

export type SchemaResult =
  | { ok: true; record: SeatRecord }
  | { ok: false; reason: string };

export function validateSeatRecord(value: unknown): SchemaResult {
  const version = value && typeof value === "object" && Object.hasOwn(value, "schema_version")
    ? (value as { schema_version: unknown }).schema_version
    : undefined;
  const validate = version === "1.2" ? validateCurrent : validateLegacy;
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
