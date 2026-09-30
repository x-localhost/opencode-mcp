import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTPUT_SCHEMA_LIMITS,
  buildStructuredOutputInstruction,
  evaluateStructuredOutput,
  validateOutputSchema,
  type OutputSchema,
} from '../../src/core/structured-output.ts';

const schema: OutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files', 'testsPassed', 'count'],
  properties: {
    summary: { type: 'string', maxLength: 100 },
    files: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'status'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['added', 'changed'] },
        },
      },
    },
    testsPassed: { type: 'boolean' },
    count: { type: 'integer' },
    optional: { type: 'null' },
  },
};

function rejected(candidate: unknown): string {
  const result = validateOutputSchema(candidate);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected schema rejection');
  assert.ok(result.message.length <= 300);
  return result.message;
}

function assertSchemaMismatch(text: string): void {
  const result = evaluateStructuredOutput(text, schema);
  assert.equal(result.status, 'invalid');
  if (result.status === 'invalid') {
    assert.equal(result.error.code, 'SCHEMA_MISMATCH');
  }
}

test('accepts a realistic report schema', () => {
  assert.deepEqual(validateOutputSchema(schema), { ok: true, schema });
  assert.equal(validateOutputSchema({
    type: 'object', additionalProperties: false,
    properties: { value: { type: 'null', enum: [null] } },
  }).ok, true);
  assert.equal(validateOutputSchema({
    type: 'object', additionalProperties: false,
    properties: { ['x'.repeat(300)]: { type: 'string' } },
  }).ok, true);
  rejected({ type: 'object', additionalProperties: false,
    properties: { value: { type: 'null', enum: [] } } });
  rejected({ type: 'object', additionalProperties: false,
    properties: { value: { type: 'null', enum: [null, null] } } });
  rejected({ type: 'object', additionalProperties: false,
    properties: { value: { type: 'null', enum: [false] } } });
});

test('rejects malformed schemas and reports bounded paths', () => {
  rejected({ type: 'string' });
  rejected({ type: 'object', properties: {} });
  rejected({ type: 'object', properties: {}, additionalProperties: true });
  for (const key of ['pattern', '$ref', 'anyOf']) {
    rejected({ type: 'object', properties: {}, additionalProperties: false, [key]: {} });
  }
  rejected({ type: ['object'], properties: {}, additionalProperties: false });
  rejected({
    type: 'object',
    properties: { a: { type: 'string' } },
    required: ['b'],
    additionalProperties: false,
  });
  rejected({ type: 'object', properties: {}, required: ['a', 'a'], additionalProperties: false });
  rejected({ type: 'string', enum: [1] });
  rejected({ type: 'string', enum: Array.from({ length: 65 }, (_, i) => String(i)) });
  rejected({ type: 'string', maxLength: 20001 });
  rejected({
    type: 'object',
    properties: Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'null' }]),
    ),
    additionalProperties: false,
  });

  let deep: unknown = { type: 'null' };
  for (let i = 0; i < 12; i++) {
    deep = { type: 'array', items: deep };
  }
  rejected({ type: 'object', properties: { x: deep }, additionalProperties: false });

  const many: Record<string, unknown> = {};
  for (let i = 0; i < 256; i++) {
    many[`p${i}`] = { type: 'object', properties: {}, additionalProperties: false };
  }
  rejected({ type: 'object', properties: many, additionalProperties: false });
  rejected({
    type: 'object',
    properties: {
      x: {
        type: 'string',
        description: 'x'.repeat(OUTPUT_SCHEMA_LIMITS.maxDescription + 1),
      },
    },
    additionalProperties: false,
  });
  rejected({ type: 'object', properties: {}, additionalProperties: false, items: { type: 'null' } });
  rejected({
    type: 'object',
    properties: { x: { type: 'string', items: { type: 'null' } } },
    additionalProperties: false,
  });
});

test('enforces exact node and byte boundaries, and safely accepts __proto__', () => {
  rejected({
    type: 'object',
    properties: { x: { type: 'string', description: 'é'.repeat(9000) } },
    additionalProperties: false,
  });
  function nodeSchema(count: number): unknown {
    let remaining = count - 1;
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 64 && remaining > 0; i++) {
      const chainLength = Math.min(remaining, 8);
      let child: unknown = { type: 'null' };
      for (let j = 1; j < chainLength; j++) child = { type: 'array', items: child };
      properties[`p${i}`] = child;
      remaining -= chainLength;
    }
    if (remaining !== 0) throw new Error('node fixture exceeds property bound');
    return { type: 'object', properties, additionalProperties: false };
  }
  assert.equal(validateOutputSchema(nodeSchema(512)).ok, true);
  rejected(nodeSchema(513));

  let atDepth12: unknown = { type: 'null' };
  for (let i = 0; i < 10; i++) atDepth12 = { type: 'array', items: atDepth12 };
  assert.equal(validateOutputSchema({ type: 'object', properties: { x: atDepth12 },
    additionalProperties: false }).ok, true);
  rejected({ type: 'object', properties: { x: { type: 'array', items: atDepth12 } },
    additionalProperties: false });
  const properties64 = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [`p${i}`, { type: 'null' }]),
  );
  assert.equal(validateOutputSchema({ type: 'object', additionalProperties: false,
    properties: properties64 }).ok, true);
  rejected({ type: 'object', additionalProperties: false,
    properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { type: 'null' }])) });

  const byteSchema = (nameLength: number): unknown => ({ type: 'object',
    properties: { ['x'.repeat(nameLength)]: { type: 'null' } }, additionalProperties: false });
  const byteBase = JSON.stringify(byteSchema(0)).length;
  assert.equal(validateOutputSchema(byteSchema(16384 - byteBase)).ok, true);
  rejected(byteSchema(16385 - byteBase));

  const proto = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}',
  ) as unknown;
  assert.equal(validateOutputSchema(proto).ok, true);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('builds a deterministic bounded instruction containing compact schema', () => {
  const first = buildStructuredOutputInstruction(schema);
  assert.equal(first, buildStructuredOutputInstruction(schema));
  assert.ok(first.includes('```json'));
  assert.ok(first.includes(JSON.stringify(schema)));
  assert.ok(first.slice(0, first.indexOf(JSON.stringify(schema))).length <= 1024);
});

test('evaluates bare JSON and one fenced JSON block', () => {
  const expected = {
    summary: 'ok',
    files: [{ path: 'a', status: 'added' }],
    testsPassed: true,
    count: 1,
  };
  const textCases = [
    JSON.stringify(expected),
    `Result\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\nDone`,
    `\`\`\`JSON\r\n${JSON.stringify(expected)}\r\n\`\`\``,
  ];
  for (const text of textCases) {
    const result = evaluateStructuredOutput(text, schema);
    assert.equal(result.status, 'valid');
    if (result.status === 'valid') assert.deepEqual(result.value, expected);
  }
});

test('extracts one JSON fence and ignores other fenced content', () => {
  const json = '{"summary":"brace } inside","files":[],"testsPassed":true,"count":0}';
  const text = [
    '```md',
    '```json',
    json,
    '```',
    '```',
    '```ts',
    'const x = 1',
    '```',
    '```json',
    json,
    '```',
  ].join('\n');
  assert.equal(evaluateStructuredOutput(text, schema).status, 'valid');

  const ambiguousText = `\`\`\`json\n${json}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``;
  const ambiguous = evaluateStructuredOutput(ambiguousText, schema);
  assert.equal(ambiguous.status, 'invalid');
  if (ambiguous.status === 'invalid') {
    assert.equal(ambiguous.error.code, 'JSON_AMBIGUOUS');
  }

  const unclosed = evaluateStructuredOutput(`\`\`\`json\n${json}`, schema);
  assert.equal(unclosed.status, 'invalid');
  if (unclosed.status === 'invalid') {
    assert.equal(unclosed.error.code, 'JSON_PARSE_ERROR');
  }
});

test('ignores JSON fences inside tilde fenced blocks', () => {
  const json = '{"summary":"ok","files":[],"testsPassed":true,"count":0}';
  const text = `~~~md\n\`\`\`json\n${json}\n\`\`\`\n~~~\n\`\`\`json\n${json}\n\`\`\``;
  const result = evaluateStructuredOutput(text, schema);
  assert.equal(result.status, 'valid');
});

test('keeps braces and fence markers inside JSON string values', () => {
  const json = '{"summary":"a } b { ```","files":[],"testsPassed":true,"count":0}';
  const result = evaluateStructuredOutput(`\`\`\`json\n${json}\n\`\`\``, schema);
  assert.equal(result.status, 'valid');
  if (result.status === 'valid') {
    assert.equal(result.value.summary, 'a } b { ```');
  }
});

test('reports missing, parsing, root, and schema mismatches with paths', () => {
  for (const input of [undefined, '', '  ', 'no json']) {
    assert.equal(evaluateStructuredOutput(input, schema).status, 'missing');
  }
  for (const input of ['{bad}', '{ bad }', '```json\n{bad\n```']) {
    const result = evaluateStructuredOutput(input, schema);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.error.code, 'JSON_PARSE_ERROR');
    }
  }

  const arrayRoot = evaluateStructuredOutput('```json\n[]\n```', schema);
  assert.equal(arrayRoot.status, 'invalid');
  if (arrayRoot.status === 'invalid') {
    assert.equal(arrayRoot.error.code, 'SCHEMA_MISMATCH');
  }
  const missing = evaluateStructuredOutput(
    '{"summary":"x","files":[],"testsPassed":true}',
    schema,
  );
  assert.equal(missing.status, 'invalid');
  if (missing.status === 'invalid') assert.match(missing.error.message, /\$\.count/);

  assertSchemaMismatch('{"summary":"x","files":[],"testsPassed":true,"count":0,"extra":1}');
  assertSchemaMismatch(
    '{"summary":"x","files":[{"path":"a","status":"bad"}],"testsPassed":true,"count":0}',
  );
  assertSchemaMismatch('{"summary":"x","files":[],"testsPassed":true,"count":1.5}');
  assertSchemaMismatch(
    '{"summary":"'.concat('x'.repeat(101), '","files":[],"testsPassed":true,"count":0}'),
  );
  assertSchemaMismatch('{"summary":"x","files":[{}, {}, {}, {}],"testsPassed":true,"count":0}');

  const nested = evaluateStructuredOutput(
    '{"summary":"x","files":[{"path":1,"status":"added"}],"testsPassed":true,"count":0}',
    schema,
  );
  assert.equal(nested.status, 'invalid');
  if (nested.status === 'invalid') {
    assert.equal(nested.error.code, 'SCHEMA_MISMATCH');
    assert.match(nested.error.message, /\$\.files\[0\]\.path/);
  }
});

test('rejects oversized input and candidates; deep JSON never throws', () => {
  const oversizedCases = [
    'x'.repeat(1024 * 1024 + 1),
    `\`\`\`json\n{"x":"${'x'.repeat(262144)}"}\n\`\`\``,
  ];
  for (const input of oversizedCases) {
    const result = evaluateStructuredOutput(input, schema);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid') {
      assert.equal(result.error.code, 'OUTPUT_TOO_LARGE');
    }
  }
  const deeplyNested = `\`\`\`json\n${'{"nested":'.repeat(1000)}0${'}'.repeat(1000)}\n\`\`\``;
  const deepResult = evaluateStructuredOutput(deeplyNested, schema);
  assert.equal(deepResult.status, 'invalid');
  if (deepResult.status === 'invalid') assert.equal(deepResult.error.code, 'SCHEMA_MISMATCH');
});
