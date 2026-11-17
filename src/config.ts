import type { Config, HandoffConfig, InstallConfig, SeatKind, VendorConfig } from "./types.js";

const SEAT_KINDS: readonly SeatKind[] = ["writing", "read-only", "none"];

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("config is not an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.passes) || raw.passes.length === 0) {
    throw new Error("config.passes is missing");
  }
  const passes = raw.passes.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`config.passes[${index}] is not an object`);
    const pass = entry as Record<string, unknown>;
    if (typeof pass.id !== "string" || pass.id.length === 0 || typeof pass.role !== "string" || typeof pass.seat !== "string") {
      throw new Error(`config.passes[${index}] needs id, role and seat`);
    }
    const seatKind = optionalSeatKind(pass.seat_kind, `config.passes[${index}].seat_kind`);
    const coverage = optionalBoolean(pass.coverage, `config.passes[${index}].coverage`);
    return {
      id: pass.id,
      role: pass.role,
      seat: pass.seat,
      ...(seatKind !== undefined ? { seat_kind: seatKind } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
    };
  });
  if (new Set(passes.map((pass) => pass.id)).size !== passes.length) {
    throw new Error("config.passes must have distinct ids");
  }
  if (typeof raw.retry_cap !== "number" || !Number.isInteger(raw.retry_cap) || raw.retry_cap < 0) {
    throw new Error("config.retry_cap must be a non-negative integer");
  }
  if (!Array.isArray(raw.record_authors) || raw.record_authors.some((login) => typeof login !== "string")) {
    throw new Error("config.record_authors must list the GitHub logins whose comments may carry records");
  }
  if (!raw.vendors || typeof raw.vendors !== "object") throw new Error("config.vendors is missing");
  const vendors: Config["vendors"] = {};
  for (const [name, entry] of Object.entries(raw.vendors as Record<string, unknown>)) {
    vendors[name] = parseVendor(name, entry);
  }
  return {
    passes,
    vendors,
    retry_cap: raw.retry_cap,
    record_authors: raw.record_authors as string[],
    ...(raw.forbidden !== undefined ? { forbidden: stringList(raw.forbidden, "config.forbidden") } : {}),
    ...(raw.installs !== undefined ? { installs: parseInstalls(raw.installs) } : {}),
    ...(raw.handoff !== undefined ? { handoff: parseHandoff(raw.handoff) } : {}),
  };
}

function parseVendor(name: string, value: unknown): VendorConfig {
  if (!value || typeof value !== "object") throw new Error(`config.vendors.${name} is not an object`);
  const raw = value as Record<string, unknown>;
  const readOnly = optionalBoolean(raw.read_only_seat, `config.vendors.${name}.read_only_seat`);
  const binary = optionalString(raw.binary, `config.vendors.${name}.binary`);
  return {
    authors: stringList(raw.authors, `config.vendors.${name}.authors`),
    runtimes: stringList(raw.runtimes, `config.vendors.${name}.runtimes`),
    models: stringMap(raw.models, `config.vendors.${name}.models`),
    efforts: stringMap(raw.efforts, `config.vendors.${name}.efforts`),
    ...(readOnly !== undefined ? { read_only_seat: readOnly } : {}),
    ...(binary !== undefined ? { binary } : {}),
  };
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function optionalSeatKind(value: unknown, label: string): SeatKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !SEAT_KINDS.includes(value as SeatKind)) {
    throw new Error(`${label} must be writing, read-only or none`);
  }
  return value as SeatKind;
}

function parseInstalls(value: unknown): InstallConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("config.installs must list install directories");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`config.installs[${index}] is not an object`);
    const raw = entry as Record<string, unknown>;
    if (typeof raw.dir !== "string" || typeof raw.lockfile !== "string") {
      throw new Error(`config.installs[${index}] needs dir and lockfile`);
    }
    return { dir: raw.dir, lockfile: raw.lockfile };
  });
}

function parseHandoff(value: unknown): HandoffConfig {
  if (!value || typeof value !== "object") throw new Error("config.handoff is not an object");
  const raw = value as Record<string, unknown>;
  const stringField = (key: string) => {
    const field = raw[key];
    if (typeof field !== "string" || field.length === 0) throw new Error(`config.handoff.${key} must be a string`);
    return field;
  };
  return {
    version_file: stringField("version_file"),
    changelog: stringField("changelog"),
    section_heading: stringField("section_heading"),
    tag: stringField("tag"),
    tag_message: stringField("tag_message"),
    merge_message: stringField("merge_message"),
    merge_command: stringField("merge_command"),
    green: stringList(raw.green, "config.handoff.green"),
  };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a list of strings`);
  }
  return value as string[];
}

function stringMap(value: unknown, label: string): Record<string, string[]> {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = stringList(entry, `${label}.${key}`);
  }
  return out;
}

export function vendorForRuntime(config: Config, runtime: string): { name: string; vendor: VendorConfig } | null {
  for (const [name, vendor] of Object.entries(config.vendors)) {
    if (vendor.runtimes.includes(runtime)) return { name, vendor };
  }
  return null;
}
