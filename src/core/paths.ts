import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from '../types.ts';
import type { Config } from '../types.ts';

function inside(candidate: string, root: string, module: typeof path | typeof path.posix): boolean {
  const relative = module.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${module.sep}`) && !module.isAbsolute(relative))
  );
}

/** Resolve and confine a requested directory to the configured roots. */
export async function resolveWorkingDirectory(cwd: string | undefined, config: Config): Promise<string> {
  const given = cwd ?? config.defaultCwd;
  if (typeof given !== 'string' || !given.trim())
    throw new EngineError('INVALID_ARGUMENT', 'Working directory must be a non-empty path');
  if (given.length > 4096) {
    throw new EngineError('INVALID_ARGUMENT', `Working directory is too long: ${given.slice(0, 300)}`);
  }
  if (given.includes('%')) {
    throw new EngineError('INVALID_ARGUMENT', 'Working directory must not contain percent-escapes');
  }
  const display = given.slice(0, 300);
  const module = config.remotePaths ? path.posix : path;
  const resolved = module.resolve(config.defaultCwd, given);
  if (config.remotePaths) {
    if (resolved.includes('%')) {
      throw new EngineError('INVALID_ARGUMENT', 'Working directory must not contain percent-escapes');
    }
    if (!config.allowedRoots.some((root) => inside(resolved, module.resolve(root), module)))
      throw new EngineError('PATH_NOT_ALLOWED', `Working directory is outside allowed roots: ${display}`);
    return resolved;
  }
  let actual: string;
  try {
    actual = await realpath(resolved);
    if (!(await stat(actual)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new EngineError(
      'INVALID_ARGUMENT',
      `Working directory does not exist or is not a directory: ${display}`,
    );
  }
  if (actual.includes('%')) {
    throw new EngineError('INVALID_ARGUMENT', 'Working directory must not contain percent-escapes');
  }
  const roots = await Promise.all(
    config.allowedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return root;
      }
    }),
  );
  if (!roots.some((root) => inside(actual, root, path)))
    throw new EngineError('PATH_NOT_ALLOWED', `Working directory is outside allowed roots: ${display}`);
  return actual;
}
