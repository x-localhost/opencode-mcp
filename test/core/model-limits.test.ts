import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contextCount,
  estimatePromptTokens,
  projectModelLimits,
  resolveModelLimit,
  usableInputTokens,
} from '../../src/core/model-limits.ts';
import type { OcTokens } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// projectModelLimits
// ---------------------------------------------------------------------------

test('projectModelLimits keeps only an allowlisted scalar projection, never upstream secrets', () => {
  const hostile = {
    connected: ['corp'],
    all: [
      {
        id: 'corp',
        name: 'SENTINEL-NAME',
        options: { apiKey: 'SENTINEL-APIKEY' },
        api: { url: 'http://SENTINEL-URL' },
        headers: { Authorization: 'SENTINEL-HEADER' },
        models: {
          'coding-model': {
            id: 'coding-model',
            status: 'active',
            cost: { input: 0, output: 0 },
            options: { apiKey: 'SENTINEL-MODEL-APIKEY' },
            limit: { context: 128000, output: 4096, apiKey: 'SENTINEL-LIMIT-APIKEY' },
          },
        },
      },
    ],
    default: { corp: 'coding-model' },
  };
  const limits = projectModelLimits(hostile);
  assert.deepEqual(limits.get('corp/coding-model'), { context: 128000, output: 4096 });
  const serialized = JSON.stringify([...limits.entries()]);
  for (const sentinel of ['SENTINEL-NAME', 'SENTINEL-APIKEY', 'SENTINEL-URL', 'SENTINEL-HEADER',
    'SENTINEL-MODEL-APIKEY', 'SENTINEL-LIMIT-APIKEY']) {
    assert.equal(serialized.includes(sentinel), false, `${sentinel} leaked`);
  }
});

test('projectModelLimits only considers providers listed as connected', () => {
  const response = {
    connected: ['corp'],
    all: [
      { id: 'corp', models: { a: { limit: { context: 1000, output: 100 } } } },
      { id: 'other', models: { b: { limit: { context: 1000, output: 100 } } } },
    ],
    default: {},
  };
  const limits = projectModelLimits(response);
  assert.deepEqual([...limits.keys()], ['corp/a']);
});

test('projectModelLimits keeps every model status, unlike the active-only models projection', () => {
  const response = {
    connected: ['corp'],
    all: [{ id: 'corp', models: {
      live: { status: 'active', limit: { context: 1000, output: 100 } },
      old: { status: 'deprecated', limit: { context: 2000, output: 200 } },
      other: { status: 'experimental', limit: { context: 3000, output: 300 } },
    } }],
    default: {},
  };
  const limits = projectModelLimits(response);
  assert.deepEqual([...limits.keys()].sort(), ['corp/live', 'corp/old', 'corp/other']);
});

test('projectModelLimits omits only invalid individual fields, keeping the rest of the model', () => {
  const response = {
    connected: ['corp'],
    all: [{ id: 'corp', models: {
      negative: { limit: { context: -1, output: 4096 } },
      fractional: { limit: { context: 128000.5, output: 4096 } },
      nonNumber: { limit: { context: '128000', output: 4096 } },
      tooLarge: { limit: { context: 100_000_001, output: 4096 } },
      allInvalid: { limit: { context: 0, output: 0 } },
      zeroIsInvalidButOutputKept: { limit: { context: 0, output: 4096 } },
    } }],
    default: {},
  };
  const limits = projectModelLimits(response);
  assert.deepEqual(limits.get('corp/negative'), { output: 4096 });
  assert.deepEqual(limits.get('corp/fractional'), { output: 4096 });
  assert.deepEqual(limits.get('corp/nonNumber'), { output: 4096 });
  assert.deepEqual(limits.get('corp/tooLarge'), { output: 4096 });
  assert.equal(limits.has('corp/allInvalid'), false);
  assert.deepEqual(limits.get('corp/zeroIsInvalidButOutputKept'), { output: 4096 });
});

test('projectModelLimits caps the map at 4096 entries', () => {
  const models: Record<string, unknown> = {};
  for (let i = 0; i < 5000; i++) models[`m${i}`] = { limit: { context: 1000, output: 100 } };
  const limits = projectModelLimits({ connected: ['corp'], all: [{ id: 'corp', models }], default: {} });
  assert.equal(limits.size, 4096);
});

test('projectModelLimits tolerates malformed shapes without throwing', () => {
  assert.equal(projectModelLimits(null).size, 0);
  assert.equal(projectModelLimits({ connected: 'nope', all: [] }).size, 0);
  assert.equal(projectModelLimits({ connected: [], all: 'nope' }).size, 0);
  assert.equal(projectModelLimits({ connected: ['corp'], all: [{ id: 'corp', models: 'nope' }] }).size, 0);
  assert.equal(projectModelLimits({ connected: ['corp'], all: [{ id: 'corp', models: { m: { limit: 'nope' } } }] }).size, 0);
});

// ---------------------------------------------------------------------------
// usableInputTokens (worked examples from the OpenCode 1.18.33 probe; docs/design.md §13)
// ---------------------------------------------------------------------------

test('usableInputTokens matches the probe-verified worked examples', () => {
  assert.equal(usableInputTokens({ context: 128000, output: 4096 }), 123904);
  assert.equal(usableInputTokens({ context: 200000, input: 150000, output: 8192 }), 141808);
  assert.equal(usableInputTokens({ context: 0 }), undefined);
  assert.equal(usableInputTokens({ context: 100000 }), 68000); // output missing -> context - 32000
  assert.equal(usableInputTokens({ context: 100000, output: 64000 }), 68000); // output capped at 32000
  assert.equal(usableInputTokens({ input: 10000, output: 4096 }), 5904);
});

test('usableInputTokens is unknown with no usable data and never reports 0', () => {
  assert.equal(usableInputTokens({}), undefined);
  assert.equal(usableInputTokens({ output: 4096 }), undefined); // no context, no input
  assert.equal(usableInputTokens({ input: 100, output: 4096 }), undefined); // 100 - min(20000,4096)=0 -> unknown
  assert.equal(usableInputTokens({ context: 4096, output: 4096 }), undefined); // 4096-4096=0 -> unknown
});

// ---------------------------------------------------------------------------
// resolveModelLimit provenance
// ---------------------------------------------------------------------------

test('resolveModelLimit: no field came from the profile -> opencode', () => {
  const resolved = resolveModelLimit('corp/m', { context: 128000, output: 4096 }, undefined);
  assert.deepEqual(resolved, {
    limit: { context: 128000, output: 4096 }, limitSource: 'opencode', usableInputTokens: 123904,
  });
});

test('resolveModelLimit: every present field came from the profile -> profile', () => {
  const resolved = resolveModelLimit('corp/m', undefined, { context: 50000, output: 2000 });
  assert.deepEqual(resolved, {
    limit: { context: 50000, output: 2000 }, limitSource: 'profile', usableInputTokens: 48000,
  });
});

test('resolveModelLimit: some fields from each side -> mixed', () => {
  const resolved = resolveModelLimit('corp/m', { context: 128000, output: 4096 }, { input: 100000 });
  assert.deepEqual(resolved, {
    limit: { context: 128000, input: 100000, output: 4096 }, limitSource: 'mixed', usableInputTokens: 95904,
  });
});

test('resolveModelLimit: a maxRunning-only profile does not change provenance', () => {
  const resolved = resolveModelLimit('corp/m', { context: 128000, output: 4096 }, { maxRunning: 2 });
  assert.deepEqual(resolved, {
    limit: { context: 128000, output: 4096 }, limitSource: 'opencode', usableInputTokens: 123904, maxRunning: 2,
  });
});

test('resolveModelLimit: maxRunning-only with no upstream limit still resolves, with an empty limit', () => {
  const resolved = resolveModelLimit('corp/m', undefined, { maxRunning: 3 });
  assert.deepEqual(resolved, { limit: {}, limitSource: 'opencode', maxRunning: 3 });
});

test('resolveModelLimit: nothing from either side and no maxRunning -> undefined', () => {
  assert.equal(resolveModelLimit('corp/m', undefined, undefined), undefined);
  assert.equal(resolveModelLimit('corp/m', undefined, {}), undefined);
  assert.equal(resolveModelLimit('corp/m', {}, undefined), undefined);
});

// ---------------------------------------------------------------------------
// contextCount
// ---------------------------------------------------------------------------

test('contextCount uses tokens.total when it is a positive finite number', () => {
  assert.equal(contextCount({ input: 1, output: 1, reasoning: 0, total: 500 }), 500);
});

test('contextCount sums input+output+cache when total is absent', () => {
  assert.equal(contextCount({ input: 400, output: 40, reasoning: 10, cache: { read: 600, write: 0 } }), 1040);
});

test('contextCount treats missing cache as zero, not as unknown', () => {
  assert.equal(contextCount({ input: 100, output: 50, reasoning: 0 }), 150);
});

test('contextCount is unknown (never 0) on garbage or missing data', () => {
  assert.equal(contextCount(undefined), undefined);
  assert.equal(contextCount({ input: -1, output: 1, reasoning: 0 } as OcTokens), undefined);
  assert.equal(contextCount({ input: NaN, output: 1, reasoning: 0 } as OcTokens), undefined);
  assert.equal(contextCount({ input: 'oops', output: 1, reasoning: 0 } as unknown as OcTokens), undefined);
  assert.equal(contextCount({ input: 1, output: 1, reasoning: 0, cache: { read: -1, write: 0 } }), undefined);
  // total present but not a usable positive finite number falls back to the sum, not to unknown.
  assert.equal(contextCount({ input: 5, output: 5, reasoning: 0, total: NaN }), 10);
  assert.equal(contextCount({ input: 5, output: 5, reasoning: 0, total: 0 }), 10);
  assert.equal(contextCount({ input: 5, output: 5, reasoning: 0, total: -1 }), 10);
});

test('contextCount matches the probe fixture exactly', () => {
  const withTotal: OcTokens = { total: 1050, input: 400, output: 40, reasoning: 10, cache: { read: 600, write: 0 } };
  assert.equal(contextCount(withTotal), 1050);
  const withoutTotal: OcTokens = { input: 400, output: 40, reasoning: 10, cache: { read: 600, write: 0 } };
  assert.equal(contextCount(withoutTotal), 1040);
});

// ---------------------------------------------------------------------------
// estimatePromptTokens
// ---------------------------------------------------------------------------

test('estimatePromptTokens: ascii chars/4, rounded up', () => {
  assert.equal(estimatePromptTokens(''), 0);
  assert.equal(estimatePromptTokens('abcd'), 1);
  assert.equal(estimatePromptTokens('hello'), 2); // ceil(5/4)
});

test('estimatePromptTokens: non-ascii (Korean) code points/2, rounded up', () => {
  assert.equal(estimatePromptTokens('가나다'), 2); // ceil(3/2)
  assert.equal(estimatePromptTokens('가나'), 1); // ceil(2/2)
});

test('estimatePromptTokens: emoji count as one code point each, not one per UTF-16 unit', () => {
  const threeEmoji = '\u{1F600}\u{1F600}\u{1F600}'; // each is a surrogate pair
  assert.equal(threeEmoji.length, 6); // UTF-16 code units
  assert.equal(estimatePromptTokens(threeEmoji), 2); // ceil(3 code points / 2)
});

test('estimatePromptTokens: mixed ascii + non-ascii adds both halves', () => {
  // 'a','b','1' ascii (3); '가','\u{1F600}' non-ascii code points (2)
  assert.equal(estimatePromptTokens('ab가1\u{1F600}'), 1 + 1); // ceil(3/4) + ceil(2/2)
});
