/**
 * 角色配置兼容层：新名称优先，同时保留旧版本配置和默认数据目录。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const previousRoles = { PUBLISHER: 'PRODUCER', MIRROR: 'CONSUMER' };

/** role 为 PUBLISHER 或 MIRROR；按新变量、旧变量、fallback 顺序取非空值。 */
export function roleSetting(role, name, fallback, env = process.env) {
  const previousRole = previousRoles[role];
  return env[`${role}_${name}`] || env[`${previousRole}_${name}`] || fallback;
}

/** 显式路径优先，否则沿用已存在的旧默认目录；只选择目录，不迁移数据。 */
export function roleDataDirectory(role, env = process.env, cwd = process.cwd()) {
  const configured = roleSetting(role, 'DATA_DIR', undefined, env);
  if (configured) return resolve(cwd, configured);
  // 未显式配置时沿用旧目录，避免角色改名后看起来像丢失了历史数据。
  const existingDirectory = resolve(cwd, 'var', previousRoles[role].toLowerCase());
  return existsSync(existingDirectory)
    ? existingDirectory
    : resolve(cwd, 'var', role.toLowerCase());
}
