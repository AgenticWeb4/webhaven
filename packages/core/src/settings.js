import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const previousRoles = { PUBLISHER: 'PRODUCER', MIRROR: 'CONSUMER' };

export function roleSetting(role, name, fallback, env = process.env) {
  const previousRole = previousRoles[role];
  return env[`${role}_${name}`] || env[`${previousRole}_${name}`] || fallback;
}

export function roleDataDirectory(role, env = process.env, cwd = process.cwd()) {
  const configured = roleSetting(role, 'DATA_DIR', undefined, env);
  if (configured) return resolve(cwd, configured);
  // Reuse v0.1.0 data when no explicit directory was configured. A rename must not hide it.
  const existingDirectory = resolve(cwd, 'var', previousRoles[role].toLowerCase());
  return existsSync(existingDirectory)
    ? existingDirectory
    : resolve(cwd, 'var', role.toLowerCase());
}
