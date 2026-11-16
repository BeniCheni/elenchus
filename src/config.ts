import type { Config, VendorConfig } from "./types.js";

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object") throw new Error("config is not an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.passes) || raw.passes.length === 0) {
    throw new Error("config.passes is missing");
  }
  const passes = raw.passes.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`config.passes[${index}] is not an object`);
    const pass = entry as Record<string, unknown>;
    if (typeof pass.id !== "string" || typeof pass.role !== "string" || typeof pass.seat !== "string") {
      throw new Error(`config.passes[${index}] needs id, role and seat`);
    }
    return { id: pass.id, role: pass.role, seat: pass.seat };
  });
  if (typeof raw.retry_cap !== "number" || !Number.isInteger(raw.retry_cap) || raw.retry_cap < 0) {
    throw new Error("config.retry_cap must be a non-negative integer");
  }
  if (!raw.vendors || typeof raw.vendors !== "object") throw new Error("config.vendors is missing");
  const vendors: Config["vendors"] = {};
  for (const [name, entry] of Object.entries(raw.vendors as Record<string, unknown>)) {
    vendors[name] = parseVendor(name, entry);
  }
  return { passes, vendors, retry_cap: raw.retry_cap };
}

function parseVendor(name: string, value: unknown): VendorConfig {
  if (!value || typeof value !== "object") throw new Error(`config.vendors.${name} is not an object`);
  const raw = value as Record<string, unknown>;
  return {
    authors: stringList(raw.authors, `config.vendors.${name}.authors`),
    runtimes: stringList(raw.runtimes, `config.vendors.${name}.runtimes`),
    models: stringMap(raw.models, `config.vendors.${name}.models`),
    efforts: stringMap(raw.efforts, `config.vendors.${name}.efforts`),
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
