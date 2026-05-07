/**
 * In-memory role assignment store.
 * Maps identity (email/nickname) to a set of roles.
 */

export type Role = 'admin' | 'editor' | 'viewer';

export interface RoleAssignment {
  identity: string;
  role: Role;
  assignedAt: number;
}

const assignments = new Map<string, RoleAssignment>();

const VALID_ROLES: Role[] = ['admin', 'editor', 'viewer'];

export function isValidRole(r: string): r is Role {
  return VALID_ROLES.includes(r as Role);
}

export function assignRole(identity: string, role: Role): RoleAssignment {
  const entry: RoleAssignment = { identity, role, assignedAt: Date.now() };
  assignments.set(identity, entry);
  return entry;
}

export function removeRole(identity: string): boolean {
  return assignments.delete(identity);
}

export function getRole(identity: string): RoleAssignment | undefined {
  return assignments.get(identity);
}

export function listRoles(): RoleAssignment[] {
  return Array.from(assignments.values()).sort((a, b) => b.assignedAt - a.assignedAt);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  editor: '编辑者',
  viewer: '只读',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: '可管理用户角色、编辑和删除所有知识条目',
  editor: '可创建和编辑知识条目',
  viewer: '仅可查看知识条目，不可编辑',
};
