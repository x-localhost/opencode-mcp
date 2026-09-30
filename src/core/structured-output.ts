export type OutputSchemaNode =
  | {
      type: 'object';
      properties: Record<string, OutputSchemaNode>;
      required?: string[];
      additionalProperties: false;
      description?: string;
    }
  | { type: 'array'; items: OutputSchemaNode; maxItems?: number; description?: string }
  | { type: 'string'; enum?: string[]; maxLength?: number; description?: string }
  | { type: 'number' | 'integer'; enum?: number[]; description?: string }
  | { type: 'boolean'; enum?: boolean[]; description?: string }
  | { type: 'null'; description?: string };
export type OutputSchema = Extract<OutputSchemaNode, { type: 'object' }>;

export const OUTPUT_SCHEMA_LIMITS = {
  maxBytes: 16384,
  maxDepth: 12,
  maxNodes: 512,
  maxProperties: 64,
  maxEnum: 64,
  maxDescription: 1000,
  maxLength: 20000,
  maxItems: 1000,
} as const;
export const STRUCTURED_OUTPUT_LIMITS = {
  maxInputBytes: 1048576,
  maxCandidateBytes: 262144,
} as const;

type ValidationResult = { ok: true; schema: OutputSchema } | { ok: false; message: string };
const allowedKeywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'maxLength',
  'maxItems',
]);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, reason: string): ValidationResult {
  return { ok: false, message: `${path}: ${reason}`.slice(0, 300) };
}

function copyNode(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): OutputSchemaNode | ValidationResult {
  if (!isPlainObject(value)) return fail(path, 'expected a schema object');
  state.nodes++;
  if (state.nodes > OUTPUT_SCHEMA_LIMITS.maxNodes) return fail(path, 'schema exceeds 512 nodes');
  if (depth > OUTPUT_SCHEMA_LIMITS.maxDepth) return fail(path, 'schema exceeds depth 12');
  for (const key of Object.keys(value)) {
    if (!allowedKeywords.has(key)) {
      return fail(`${path}.${key}`, `unsupported keyword ${JSON.stringify(key)}`);
    }
  }
  if (!Object.hasOwn(value, 'type') || typeof value.type !== 'string' || !types.has(value.type)) {
    return fail(`${path}.type`, 'expected one supported type string');
  }
  const type = value.type;
  const applicable: Record<string, string[]> = {
    object: ['properties', 'required', 'additionalProperties'],
    array: ['items', 'maxItems'],
    string: ['enum', 'maxLength'],
    number: ['enum'],
    integer: ['enum'],
    boolean: ['enum'],
    null: ['enum'],
  };
  for (const key of Object.keys(value)) {
    if (!['type', 'description', ...applicable[type]!].includes(key)) {
      return fail(`${path}.${key}`, `keyword is not allowed for type ${type}`);
    }
  }

  const out: Record<string, unknown> = { type };
  if (Object.hasOwn(value, 'description')) {
    if (
      typeof value.description !== 'string' ||
      value.description.length > OUTPUT_SCHEMA_LIMITS.maxDescription
    ) {
      return fail(`${path}.description`, 'expected a string of at most 1000 characters');
    }
    out.description = value.description;
  }
  if (type === 'object') {
    if (!Object.hasOwn(value, 'additionalProperties') || value.additionalProperties !== false) {
      return fail(`${path}.additionalProperties`, 'must be false');
    }
    if (!Object.hasOwn(value, 'properties') || !isPlainObject(value.properties)) {
      return fail(`${path}.properties`, 'expected an object');
    }
    const names = Object.keys(value.properties);
    if (names.length > OUTPUT_SCHEMA_LIMITS.maxProperties) {
      return fail(`${path}.properties`, 'exceeds 64 properties');
    }
    const properties: Record<string, OutputSchemaNode> = {};
    for (const name of names) {
      if (name.length === 0) {
        return fail(`${path}.properties`, 'property names must be non-empty strings');
      }
      const child = copyNode(value.properties[name], `${path}.properties.${name}`, depth + 1, state);
      if (isValidationResult(child)) return child;
      Object.defineProperty(properties, name, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    out.properties = properties;
    out.additionalProperties = false;
    if (Object.hasOwn(value, 'required')) {
      if (
        !Array.isArray(value.required) ||
        !value.required.every((entry) => typeof entry === 'string')
      ) {
        return fail(`${path}.required`, 'expected an array of property names');
      }
      const required = value.required as string[];
      const seen = new Set<string>();
      for (const name of required) {
        if (seen.has(name)) {
          return fail(`${path}.required`, `duplicate property ${JSON.stringify(name)}`);
        }
        if (!Object.hasOwn(properties, name)) {
          return fail(`${path}.required`, `unknown property ${JSON.stringify(name)}`);
        }
        seen.add(name);
      }
      out.required = [...required];
    }
  } else if (type === 'array') {
    if (!Object.hasOwn(value, 'items')) return fail(`${path}.items`, 'is required');
    const child = copyNode(value.items, `${path}.items`, depth + 1, state);
    if (isValidationResult(child)) return child;
    out.items = child;
    if (Object.hasOwn(value, 'maxItems')) {
      if (
        !Number.isInteger(value.maxItems) ||
        (value.maxItems as number) < 0 ||
        (value.maxItems as number) > OUTPUT_SCHEMA_LIMITS.maxItems
      ) {
        return fail(`${path}.maxItems`, 'expected an integer from 0 to 1000');
      }
      out.maxItems = value.maxItems;
    }
  }
  if (type === 'string' && Object.hasOwn(value, 'maxLength')) {
    if (
      !Number.isInteger(value.maxLength) ||
      (value.maxLength as number) < 0 ||
      (value.maxLength as number) > OUTPUT_SCHEMA_LIMITS.maxLength
    ) {
      return fail(`${path}.maxLength`, 'expected an integer from 0 to 20000');
    }
    out.maxLength = value.maxLength;
  }
  if (Object.hasOwn(value, 'enum')) {
    const enumeration = value.enum;
    if (
      !Array.isArray(enumeration) ||
      enumeration.length === 0 ||
      enumeration.length > OUTPUT_SCHEMA_LIMITS.maxEnum
    ) {
      return fail(`${path}.enum`, 'expected 1 to 64 unique values');
    }
    const seen: unknown[] = [];
    for (const entry of enumeration) {
      const matches =
        type === 'string'
          ? typeof entry === 'string'
          : type === 'boolean'
            ? typeof entry === 'boolean'
            : type === 'integer'
              ? typeof entry === 'number' && Number.isInteger(entry)
              : type === 'number'
                ? typeof entry === 'number' && Number.isFinite(entry)
                : type === 'null'
                  ? entry === null
                  : false;
      if (!matches || seen.some((prior) => prior === entry)) {
        return fail(`${path}.enum`, 'values must be unique scalars matching the declared type');
      }
      seen.push(entry);
    }
    out.enum = [...enumeration];
  }
  return out as unknown as OutputSchemaNode;
}

function isValidationResult(value: OutputSchemaNode | ValidationResult): value is ValidationResult {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'ok');
}

/** Validate an untrusted schema and return a detached, keyword-checked copy. */
export function validateOutputSchema(schema: unknown): ValidationResult {
  if (!isPlainObject(schema)) return fail('$', 'expected a plain object');
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return fail('$', 'schema is not serializable');
  }
  if (typeof serialized !== 'string') return fail('$', 'schema is not serializable');
  if (Buffer.byteLength(serialized, 'utf8') > OUTPUT_SCHEMA_LIMITS.maxBytes) {
    return fail('$', 'schema exceeds 16384 UTF-8 bytes');
  }
  const state = { nodes: 0 };
  const result = copyNode(schema, '$', 1, state);
  if (isValidationResult(result)) return result;
  if (result.type !== 'object') return fail('$.type', 'root schema must be an object');
  return { ok: true, schema: result as OutputSchema };
}

/** Build the deterministic turn-local instruction for structured output. */
export function buildStructuredOutputInstruction(schema: OutputSchema): string {
  const instruction =
    'When you have finished the task, your final message must contain exactly one fenced code block ' +
    'whose info string is ```json, containing a single JSON object that conforms to the schema below. ' +
    'Do not include any other ```json blocks in the final message. Prose outside the block is allowed.' +
    '\n\nSchema:\n';
  return instruction + JSON.stringify(schema);
}

export type StructuredOutputErrorCode =
  | 'JSON_MISSING'
  | 'JSON_AMBIGUOUS'
  | 'JSON_PARSE_ERROR'
  | 'SCHEMA_MISMATCH'
  | 'OUTPUT_TOO_LARGE';
export type StructuredOutputEvaluation =
  | { status: 'valid'; value: Record<string, unknown>; serialized: string }
  | { status: 'missing' | 'invalid'; error: { code: StructuredOutputErrorCode; message: string } };

function evaluationError(
  status: 'missing' | 'invalid',
  code: StructuredOutputErrorCode,
  message: string,
): StructuredOutputEvaluation {
  return { status, error: { code, message: message.slice(0, 300) } };
}

function jsonPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

function mismatch(
  value: unknown,
  node: OutputSchemaNode,
  path: string,
): string | undefined {
  const actual =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (node.type === 'object') {
    if (!isPlainObject(value)) return `${path}: expected object, got ${actual}`;
    for (const required of node.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        return `${jsonPath(path, required)}: required property is missing`;
      }
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(node.properties, key)) {
        return `${jsonPath(path, key)}: additional property is not allowed`;
      }
      const error = mismatch(value[key], node.properties[key]!, jsonPath(path, key));
      if (error) return error;
    }
    return undefined;
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return `${path}: expected array, got ${actual}`;
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      return `${path}: expected at most ${node.maxItems} items`;
    }
    for (let i = 0; i < value.length; i++) {
      const error = mismatch(value[i], node.items, jsonPath(path, i));
      if (error) return error;
    }
    return undefined;
  }
  const matches =
    node.type === 'null'
      ? value === null
      : node.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : node.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === node.type;
  if (!matches) {
    return `${path}: expected ${node.type}, got ${actual}`;
  }
  const allowed: readonly unknown[] | undefined = 'enum' in node ? node.enum : undefined;
  if (allowed && !allowed.some((entry) => entry === value)) {
    return `${path}: value is not in enum`;
  }
  if (
    node.type === 'string' &&
    node.maxLength !== undefined &&
    (value as string).length > node.maxLength
  ) {
    return `${path}: expected at most ${node.maxLength} characters`;
  }
  return undefined;
}

/** Extract, parse, and validate the final answer's one structured JSON object. */
export function evaluateStructuredOutput(
  finalText: string | undefined,
  schema: OutputSchema,
): StructuredOutputEvaluation {
  if (finalText === undefined || finalText.trim() === '') {
    return evaluationError('missing', 'JSON_MISSING', 'No JSON object was found');
  }
  if (Buffer.byteLength(finalText, 'utf8') > STRUCTURED_OUTPUT_LIMITS.maxInputBytes) {
    return evaluationError('invalid', 'OUTPUT_TOO_LARGE', 'Final answer exceeds 1 MiB');
  }
  const trimmed = finalText.trim();
  let candidate: string | undefined;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidate = trimmed;
  else {
    const lines = trimmed.split(/\r?\n/);
    let fence: '`' | '~' | undefined;
    let jsonFence = false;
    let body: string[] = [];
    const blocks: string[] = [];
    let unclosedJson = false;
    for (const line of lines) {
      const left = line.trimStart();
      if (fence === undefined && left.startsWith('```')) {
        const info = left.slice(3);
        fence = '`';
        jsonFence = /^json\s*$/i.test(info);
        body = [];
      } else if (fence === undefined && left.startsWith('~~~')) {
        fence = '~';
        body = [];
      } else if (fence === '`' && line.trim() === '```') {
        if (jsonFence) blocks.push(body.join('\n'));
        fence = undefined;
        jsonFence = false;
        body = [];
      } else if (fence === '~' && /^~~~\s*$/.test(line.trim())) {
        fence = undefined;
        body = [];
      } else if (fence === '`' && jsonFence) {
        body.push(line);
      }
    }
    if (fence === '`' && jsonFence) unclosedJson = true;
    if (blocks.length > 1) {
      return evaluationError('invalid', 'JSON_AMBIGUOUS', 'More than one JSON code block was found');
    }
    if (unclosedJson) {
      return evaluationError('invalid', 'JSON_PARSE_ERROR', 'JSON code block is unclosed');
    }
    if (blocks.length === 1) candidate = blocks[0];
  }
  if (candidate === undefined) {
    return evaluationError('missing', 'JSON_MISSING', 'No JSON object was found');
  }
  if (Buffer.byteLength(candidate, 'utf8') > STRUCTURED_OUTPUT_LIMITS.maxCandidateBytes) {
    return evaluationError('invalid', 'OUTPUT_TOO_LARGE', 'JSON candidate exceeds 256 KiB');
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    return evaluationError('invalid', 'JSON_PARSE_ERROR', 'JSON candidate could not be parsed');
  }
  if (!isPlainObject(value)) {
    return evaluationError('invalid', 'SCHEMA_MISMATCH', '$: expected object root');
  }
  const error = mismatch(value, schema, '$');
  if (error) {
    return evaluationError('invalid', 'SCHEMA_MISMATCH', error);
  }
  return { status: 'valid', value, serialized: JSON.stringify(value) };
}
