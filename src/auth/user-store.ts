import bcrypt from 'bcryptjs';
import type { User, Role } from './auth-types.js';

export interface UserStoreOptions {
  idFactory?: () => string;
  hashPassword?: (password: string) => string;
  verifyPassword?: (password: string, hash: string) => boolean;
}

function defaultHash(password: string): string {
  return bcrypt.hashSync(password, 10);
}

function defaultVerify(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export class UserStore {
  private readonly users = new Map<string, User>();
  private readonly usernameIndex = new Map<string, string>();
  private readonly idFactory: () => string;
  private readonly hashPassword: (password: string) => string;
  private readonly verifyPassword: (password: string, hash: string) => boolean;

  constructor(options: UserStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.hashPassword = options.hashPassword ?? defaultHash;
    this.verifyPassword = options.verifyPassword ?? defaultVerify;
  }

  createUser(username: string, password: string, role: Role, createdBy: string): User {
    if (this.usernameIndex.has(username)) {
      throw new Error(`Username already exists: ${username}`);
    }
    const now = new Date();
    const user: User = {
      id: this.idFactory(),
      username,
      passwordHash: this.hashPassword(password),
      role,
      createdAt: now,
      updatedAt: now,
      createdBy,
      disabled: false,
    };
    this.users.set(user.id, user);
    this.usernameIndex.set(username, user.id);
    return user;
  }

  authenticate(username: string, password: string): User | null {
    const userId = this.usernameIndex.get(username);
    if (!userId) return null;
    const user = this.users.get(userId)!;
    if (user.disabled) return null;
    if (!this.verifyPassword(password, user.passwordHash)) return null;
    return user;
  }

  changePassword(userId: string, oldPassword: string, newPassword: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    if (!this.verifyPassword(oldPassword, user.passwordHash)) return false;
    user.passwordHash = this.hashPassword(newPassword);
    user.updatedAt = new Date();
    return true;
  }

  updateRole(userId: string, role: Role): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    user.role = role;
    user.updatedAt = new Date();
    return true;
  }

  disableUser(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user || user.disabled) return false;
    user.disabled = true;
    user.updatedAt = new Date();
    return true;
  }

  getUser(userId: string): User | null {
    return this.users.get(userId) ?? null;
  }

  getUserByUsername(username: string): User | null {
    const userId = this.usernameIndex.get(username);
    if (!userId) return null;
    return this.users.get(userId) ?? null;
  }

  listUsers(): User[] {
    return Array.from(this.users.values());
  }
}
