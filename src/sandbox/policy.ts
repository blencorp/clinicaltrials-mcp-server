import { parse } from "acorn";
import { simple as walkSimple } from "acorn-walk";
import { CtGovError } from "../supervisor/errors.js";

/**
 * AST allow-list: reject obvious escape hatches before execution.
 * The sandbox itself is the real boundary — this layer catches mistakes
 * and accidental imports early, and keeps LLM output well-formed.
 */
export interface ParseOptions {
  /** Max source length in chars (default 32 KiB). */
  maxLength?: number;
}

const BLOCKED_IDENTIFIERS = new Set([
  "eval",
  "Function",
  "WebAssembly",
  "require",
  "process",
  "Deno",
  "Bun",
  "__host",
  "__filename",
  "__dirname",
]);

const BLOCKED_PROPERTY_NAMES = new Set([
  "__host",
  "__proto__",
  "constructor",
  "prototype",
]);

const ALLOWED_GLOBALS = new Set([
  "ctgov",
  "console",
  "JSON",
  "Math",
  "Date",
  "Object",
  "Array",
  "Number",
  "String",
  "Boolean",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Symbol",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "parseFloat",
  "parseInt",
  "isFinite",
  "isNaN",
  "undefined",
  "Infinity",
  "NaN",
  "Intl",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
  "structuredClone",
  "globalThis",
  "Array.from",
  "atob",
  "btoa",
]);

export function validateUserCode(source: string, opts: ParseOptions = {}): void {
  const maxLength = opts.maxLength ?? 32 * 1024;
  if (source.length > maxLength) {
    throw new CtGovError(
      "POLICY_VIOLATION",
      `Source too large: ${source.length} > ${maxLength} chars`,
    );
  }

  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (err) {
    throw new CtGovError(
      "POLICY_VIOLATION",
      `Parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  walkSimple(ast, {
    ImportDeclaration() {
      throw new CtGovError("POLICY_VIOLATION", "`import` is not allowed in sandbox code");
    },
    ImportExpression() {
      throw new CtGovError("POLICY_VIOLATION", "dynamic `import()` is not allowed");
    },
    ExportNamedDeclaration() {
      throw new CtGovError("POLICY_VIOLATION", "`export` is not allowed");
    },
    ExportDefaultDeclaration() {
      throw new CtGovError("POLICY_VIOLATION", "`export` is not allowed");
    },
    ExportAllDeclaration() {
      throw new CtGovError("POLICY_VIOLATION", "`export` is not allowed");
    },
    WithStatement() {
      throw new CtGovError("POLICY_VIOLATION", "`with` is not allowed");
    },
    Identifier(node: unknown) {
      const n = node as { name?: string };
      if (n.name && BLOCKED_IDENTIFIERS.has(n.name)) {
        throw new CtGovError(
          "POLICY_VIOLATION",
          `Reference to blocked identifier \`${n.name}\``,
        );
      }
    },
    MetaProperty(node: unknown) {
      const n = node as { meta?: { name?: string }; property?: { name?: string } };
      if (n.meta?.name === "import" && n.property?.name === "meta") {
        throw new CtGovError("POLICY_VIOLATION", "`import.meta` is not allowed");
      }
    },
    NewExpression(node: unknown) {
      const n = node as { callee?: { type?: string; name?: string } };
      if (n.callee?.type === "Identifier" && n.callee.name === "Function") {
        throw new CtGovError("POLICY_VIOLATION", "`new Function()` is not allowed");
      }
    },
    MemberExpression(node: unknown) {
      const n = node as {
        computed?: boolean;
        property?: { type?: string; name?: string; value?: unknown };
      };
      const propertyName = staticPropertyName(n.property);
      if (propertyName && BLOCKED_PROPERTY_NAMES.has(propertyName)) {
        throw new CtGovError(
          "POLICY_VIOLATION",
          `Access to blocked property \`${propertyName}\` is not allowed`,
        );
      }
      if (
        n.computed &&
        n.property?.type === "BinaryExpression"
      ) {
        throw new CtGovError(
          "POLICY_VIOLATION",
          "Computed property expressions are not allowed for sandbox escape safety",
        );
      }
    },
  });
}

export const SANDBOX_ALLOWED_GLOBALS = ALLOWED_GLOBALS;

function staticPropertyName(
  node: { type?: string; name?: string; value?: unknown } | undefined,
): string | null {
  if (!node) return null;
  if (node.type === "Identifier" && node.name) return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}
