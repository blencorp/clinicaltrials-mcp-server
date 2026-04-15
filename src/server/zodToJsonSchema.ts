import type { z} from "zod";
import { type ZodTypeAny } from "zod";

/**
 * Minimal Zod → JSON Schema converter. Only handles the shapes we actually use
 * in tool inputs (objects, strings, numbers, booleans, enums, arrays, optional).
 * Good enough to drive MCP's tool inputSchema without pulling another dep.
 */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return convert(schema);
}

function convert(schema: ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string; [k: string]: unknown } })._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const sub = convert(v as ZodTypeAny);
        properties[k] = sub;
        if (!isOptional(v as ZodTypeAny)) required.push(k);
      }
      return required.length
        ? { type: "object", properties, required, additionalProperties: false }
        : { type: "object", properties, additionalProperties: false };
    }
    case "ZodString": {
      const checks = (def as { checks?: Array<{ kind: string; value?: number; regex?: RegExp }> }).checks ?? [];
      const out: Record<string, unknown> = { type: "string" };
      for (const c of checks) {
        if (c.kind === "min") out.minLength = c.value;
        if (c.kind === "max") out.maxLength = c.value;
        if (c.kind === "regex" && c.regex) out.pattern = c.regex.source;
      }
      return out;
    }
    case "ZodNumber": {
      const checks = (def as { checks?: Array<{ kind: string; value?: number; inclusive?: boolean }> })
        .checks ?? [];
      const out: Record<string, unknown> = { type: "number" };
      for (const c of checks) {
        if (c.kind === "int") out.type = "integer";
        if (c.kind === "min") out.minimum = c.value;
        if (c.kind === "max") out.maximum = c.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray": {
      const inner = convert((def as unknown as { type: ZodTypeAny }).type);
      return { type: "array", items: inner };
    }
    case "ZodEnum":
      return { type: "string", enum: (def as unknown as { values: string[] }).values };
    case "ZodUnion": {
      const options = (def as unknown as { options: ZodTypeAny[] }).options.map(convert);
      return { anyOf: options };
    }
    case "ZodOptional":
      return convert((def as unknown as { innerType: ZodTypeAny }).innerType);
    case "ZodNullable":
      return {
        anyOf: [
          convert((def as unknown as { innerType: ZodTypeAny }).innerType),
          { type: "null" },
        ],
      };
    case "ZodDefault":
      return convert((def as unknown as { innerType: ZodTypeAny }).innerType);
    case "ZodEffects":
      return convert((def as unknown as { schema: ZodTypeAny }).schema);
    default:
      return {};
  }
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}
