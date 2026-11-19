import type { Config, FindingFlow, GateConfig, HandoffConfig, InstallConfig, SeatKind, VendorConfig } from "./types.js";

const SEAT_KINDS: readonly SeatKind[] = ["writing", "read-only", "none"];

export function parseConfig(value: unknown): Config {
  const unknownKeys: string[] = [];
  const raw = fields(value, "config", unknownKeys, [
    "passes", "vendors", "retry_cap", "record_authors", "forbidden", "installs", "handoff", "finding_flow", "escalate_to", "gate",
  ]);
  if (!Array.isArray(raw.passes) || raw.passes.length === 0) {
    throw new Error("config.passes is missing");
  }
  const passes = raw.passes.map((entry, index) => {
    const pass = fields(entry, `config.passes[${index}]`, unknownKeys, ["id", "role", "seat", "seat_kind", "coverage"]);
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
  const vendors = Object.fromEntries(Object.entries(object(raw.vendors, "config.vendors"))
    .map(([name, entry]) => [name, parseVendor(name, entry, unknownKeys)]));
  const passIds = passes.map(({ id }) => id);
  const escalation = optionalString(raw.escalate_to, "config.escalate_to");
  const config: Config = {
    passes,
    vendors,
    retry_cap: raw.retry_cap,
    record_authors: raw.record_authors as string[],
    ...(raw.forbidden !== undefined ? { forbidden: stringList(raw.forbidden, "config.forbidden") } : {}),
    ...(raw.installs !== undefined ? { installs: parseInstalls(raw.installs, unknownKeys) } : {}),
    ...(raw.handoff !== undefined ? { handoff: parseHandoff(raw.handoff, unknownKeys) } : {}),
    ...(raw.finding_flow !== undefined ? { finding_flow: parseFindingFlow(raw.finding_flow, passIds, unknownKeys) } : {}),
    ...(escalation !== undefined ? { escalate_to: escalation } : {}),
    ...(raw.gate !== undefined ? { gate: parseGate(raw.gate, passIds, unknownKeys) } : {}),
  };
  if (unknownKeys.length) config.unknownKeys = unknownKeys;
  return config;
}

function parseFindingFlow(value: unknown, passIds: string[], unknownKeys: string[]): FindingFlow {
  const label = "config.finding_flow";
  const raw = fields(value, label, unknownKeys, ["opens", "carries", "ruling"]);
  const opens = configuredPass(raw.opens, `${label}.opens`, passIds);
  const carries = stringList(raw.carries, `${label}.carries`)
    .map((id) => configuredPass(id, `${label}.carries`, passIds));
  const ordered = [opens, ...carries];
  const ruling = raw.ruling === undefined ? undefined : configuredPass(raw.ruling, `${label}.ruling`, passIds);
  if (ruling !== undefined) ordered.push(ruling);
  if (ordered.some((id, i) => i > 0 && passIds.indexOf(id) <= passIds.indexOf(ordered[i - 1]!))) {
    throw new Error(`${label} passes must follow config.passes order`);
  }
  return { opens, carries, ...(ruling !== undefined ? { ruling } : {}) };
}

function parseGate(value: unknown, passIds: string[], unknownKeys: string[]): GateConfig {
  const label = "config.gate";
  const raw = fields(value, label, unknownKeys, ["context", "app_id", "required_checks", "blocking_unverified", "allowed_changes"]);
  const context = nonemptyString(raw.context, `${label}.context`);
  const appId = raw.app_id === undefined ? undefined : positiveId(raw.app_id, `${label}.app_id`);
  if (!Array.isArray(raw.required_checks)) throw new Error(`${label}.required_checks must be an array`);
  const requiredChecks = raw.required_checks.map((entry, index) => {
    const field = `${label}.required_checks[${index}]`;
    const check = fields(entry, field, unknownKeys, ["name", "app_id"]);
    return {
      name: nonemptyString(check.name, `${field}.name`),
      ...(check.app_id !== undefined ? { app_id: positiveId(check.app_id, `${field}.app_id`) } : {}),
    };
  });
  const blockingUnverified = stringList(raw.blocking_unverified, `${label}.blocking_unverified`).map((rule) => {
    if (rule !== "coverage" && rule !== "route") throw new Error(`${label}.blocking_unverified has unknown rule ${rule}`);
    return rule;
  });
  const changes = raw.allowed_changes === undefined
    ? undefined
    : parseAllowedChanges(raw.allowed_changes, passIds, unknownKeys);
  return {
    context,
    ...(appId !== undefined ? { app_id: appId } : {}),
    required_checks: requiredChecks,
    blocking_unverified: blockingUnverified,
    ...(changes ? { allowed_changes: changes } : {}),
  };
}

function parseAllowedChanges(value: unknown, passIds: string[], unknownKeys: string[]): NonNullable<GateConfig["allowed_changes"]> {
  const label = "config.gate.allowed_changes";
  const raw = fields(value, label, unknownKeys, ["paths", "reread_pass", "version_only"]);
  const version = raw.version_only === undefined ? undefined : fields(raw.version_only, `${label}.version_only`, unknownKeys, ["file", "tests", "pattern"]);
  const pattern = optionalString(version?.pattern, `${label}.version_only.pattern`);
  if (pattern !== undefined) {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`${label}.version_only.pattern must be a regular expression`);
    }
  }
  return {
    paths: stringList(raw.paths, `${label}.paths`),
    reread_pass: configuredPass(raw.reread_pass, `${label}.reread_pass`, passIds),
    ...(version ? { version_only: {
      file: nonemptyString(version.file, `${label}.version_only.file`),
      tests: stringList(version.tests, `${label}.version_only.tests`),
      ...(pattern === undefined ? {} : { pattern }),
    } } : {}),
  };
}

function fields(value: unknown, label: string, unknownKeys: string[], known: string[]): Record<string, unknown> {
  const raw = object(value, label);
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) unknownKeys.push(`${label}.${key}`);
  }
  return raw;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (parsed === undefined) throw new Error(`${label} must be a string`);
  return parsed;
}

function positiveId(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function configuredPass(value: unknown, label: string, passIds: string[]): string {
  if (typeof value !== "string" || !passIds.includes(value)) throw new Error(`${label} must name a configured pass`);
  return value;
}

function parseVendor(name: string, value: unknown, unknownKeys: string[]): VendorConfig {
  const raw = fields(value, `config.vendors.${name}`, unknownKeys, ["authors", "runtimes", "models", "efforts", "read_only_seat", "binary"]);
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

function parseInstalls(value: unknown, unknownKeys: string[]): InstallConfig[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("config.installs must list install directories");
  return value.map((entry, index) => {
    const raw = fields(entry, `config.installs[${index}]`, unknownKeys, ["dir", "lockfile"]);
    if (typeof raw.dir !== "string" || typeof raw.lockfile !== "string") {
      throw new Error(`config.installs[${index}] needs dir and lockfile`);
    }
    return { dir: raw.dir, lockfile: raw.lockfile };
  });
}

function parseHandoff(value: unknown, unknownKeys: string[]): HandoffConfig {
  const raw = fields(value, "config.handoff", unknownKeys, [
    "version_file", "changelog", "section_heading", "tag", "tag_message", "merge_message", "merge_command", "green",
  ]);
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
  return Object.fromEntries(Object.entries(object(value, label))
    .map(([key, entry]) => [key, stringList(entry, `${label}.${key}`)]));
}

export function vendorForRuntime(config: Config, runtime: string): { name: string; vendor: VendorConfig } | null {
  for (const [name, vendor] of Object.entries(config.vendors)) {
    if (vendor.runtimes.includes(runtime)) return { name, vendor };
  }
  return null;
}
