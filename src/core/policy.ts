import type { PermissionRule, Sandbox } from '../types.ts';

/** Build the deny-only session rules for one sandbox profile. */
export function sessionRulesFor(sandbox: Sandbox): Array<PermissionRule & { action: 'deny' }> {
  const permissions = ['task', 'question', 'plan_enter', 'plan_exit'];
  if (sandbox === 'read-only') permissions.push('edit', 'bash', 'external_directory', 'webfetch', 'websearch');
  else if (sandbox === 'workspace-write') permissions.push('external_directory');
  return permissions.map((permission) => ({ permission, pattern: '*', action: 'deny' as const }));
}
