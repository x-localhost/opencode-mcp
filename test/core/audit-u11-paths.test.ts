import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkingDirectory } from '../../src/core/paths.ts';
import { EngineError } from '../../src/types.ts';
import type { Config } from '../../src/types.ts';

const config = (root: string, remotePaths = false) =>
  ({ defaultCwd: root, allowedRoots: [root], remotePaths } as Config);

test('rejects percent escapes in remote working directories', async () => {
  await assert.rejects(
    resolveWorkingDirectory('/work/proj/%2E%2E/%2E%2E', config('/work/proj', true)),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('rejects percent escapes in local working directories even when the directory exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u11-path-'));
  try {
    await mkdir(path.join(root, '%2E%2E'));
    await assert.rejects(resolveWorkingDirectory('%2E%2E', config(root)), { code: 'INVALID_ARGUMENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a local symlink whose resolved directory contains percent escapes', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'u11-link-'));
  const root = path.join(parent, 'root');
  const target = path.join(parent, 'target-%2E%2E');
  try {
    await mkdir(root);
    await mkdir(target);
    await symlink(target, path.join(root, 'link'));
    await assert.rejects(resolveWorkingDirectory(path.join(root, 'link'), config(root)), {
      code: 'INVALID_ARGUMENT',
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('allows a local symlink to a clean directory inside the allowed root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u11-clean-link-'));
  const target = path.join(root, 'target');
  try {
    await mkdir(target);
    await symlink(target, path.join(root, 'link'));
    assert.equal(await resolveWorkingDirectory(path.join(root, 'link'), config(root)), target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a relative remote path resolved against a default cwd containing percent escapes', async () => {
  await assert.rejects(
    resolveWorkingDirectory('project', config('/work/%2E%2E', true)),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('rejects oversized working directories with a bounded error message', async () => {
  await assert.rejects(
    resolveWorkingDirectory('/' + 'a'.repeat(10_000_000), config('/work/proj', true)),
    (error: unknown) => {
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.ok(error.message.length <= 400);
      return true;
    },
  );
});
