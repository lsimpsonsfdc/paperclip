import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue, type ZodSchema } from "zod";
import { unprocessable } from "../errors.js";

type UnrecognizedKeysIssue = Extract<ZodIssue, { code: "unrecognized_keys" }>;

function isTopLevelUnrecognizedKeysIssue(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys" && issue.path.length === 0;
}

// Common field names callers reach for that don't match the schema's actual
// key. Checked before falling back to edit distance, since some renames
// (body -> description) are semantically related but not textually close.
const FIELD_ALIASES: Record<string, string> = {
  body: "description",
  content: "description",
  desc: "description",
  text: "description",
  parentIssueId: "parentId",
  parent_id: "parentId",
  parentID: "parentId",
  assignee: "assigneeAgentId",
  assigneeId: "assigneeAgentId",
  labels: "labelIds",
  label: "labelIds",
  blockedBy: "blockedByIssueIds",
  blockedIds: "blockedByIssueIds",
};

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

interface ZodObjectLike {
  _def: { typeName: string; schema?: unknown; innerType?: unknown };
  shape: Record<string, unknown>;
}

function isZodObjectLike(value: unknown): value is ZodObjectLike {
  return typeof value === "object" && value !== null && "_def" in value;
}

// Schemas passed to validate() are frequently ZodEffects wrapping a ZodObject
// (z.preprocess / .superRefine chains), so unwrap those layers to find the
// object whose keys we can suggest from.
function findObjectSchema(schema: unknown, seen = new Set<unknown>()): ZodObjectLike | null {
  if (!isZodObjectLike(schema) || seen.has(schema)) return null;
  seen.add(schema);
  if (schema._def.typeName === "ZodObject") return schema;
  if (schema._def.schema) return findObjectSchema(schema._def.schema, seen);
  if (schema._def.innerType) return findObjectSchema(schema._def.innerType, seen);
  return null;
}

function suggestNearestField(unknownKey: string, knownKeys: string[]): string | null {
  const alias = FIELD_ALIASES[unknownKey];
  if (alias && knownKeys.includes(alias)) return alias;

  let best: { key: string; distance: number } | null = null;
  for (const knownKey of knownKeys) {
    const distance = levenshtein(unknownKey, knownKey);
    if (!best || distance < best.distance) best = { key: knownKey, distance };
  }
  if (!best) return null;
  const threshold = Math.max(2, Math.ceil(Math.max(unknownKey.length, best.key.length) * 0.4));
  return best.distance <= threshold ? best.key : null;
}

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        // Only top-level unrecognized keys get the 422 + suggestion treatment.
        // Nested strict-schema violations (e.g. inside `metadata`) keep the
        // existing generic 400 Zod validation error response.
        const unrecognizedIssues = err.issues.filter(isTopLevelUnrecognizedKeysIssue);
        if (unrecognizedIssues.length > 0) {
          const knownKeys = Object.keys(findObjectSchema(schema)?.shape ?? {});
          const unknownFields = unrecognizedIssues.flatMap((issue) =>
            issue.keys.map((field) => {
              const suggestedField = suggestNearestField(field, knownKeys);
              return { field, ...(suggestedField ? { suggestedField } : {}) };
            }));
          next(unprocessable(
            `Unrecognized field(s): ${unknownFields.map((f) => f.field).join(", ")}`,
            { code: "unrecognized_fields", unknownFields },
          ));
          return;
        }
      }
      next(err);
    }
  };
}
