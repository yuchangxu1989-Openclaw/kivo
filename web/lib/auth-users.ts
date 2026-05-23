import Database from 'better-sqlite3';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'crypto';
import { resolve } from 'path';

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

const DEFAULT_DB_PATH = resolve(process.cwd(), '..', 'kivo.db');
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_PREFIX = 'scrypt';

let db: Database.Database | null = null;

function getDbPath() {
  return process.env.KIVO_DB_PATH || DEFAULT_DB_PATH;
}

function getDb() {
  if (!db) {
    db = new Database(getDbPath());
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function ensureUsersTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      created_at TEXT NOT NULL
    );
  `);
}

function mapUser(row: Record<string, unknown> | undefined): AuthUser | null {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    role: (row.role as UserRole) ?? 'viewer',
    createdAt: String(row.created_at),
  };
}

export function hasUsers() {
  ensureUsersTable();
  const row = getDb().prepare('SELECT COUNT(1) AS count FROM users').get() as { count?: number } | undefined;
  return Number(row?.count || 0) > 0;
}

export function findUserByUsername(username: string) {
  ensureUsersTable();
  const row = getDb().prepare(
    'SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?',
  ).get(username.trim().toLowerCase()) as Record<string, unknown> | undefined;
  return mapUser(row);
}

export function createUser(username: string, password: string, role: UserRole = 'admin') {
  ensureUsersTable();
  const normalizedUsername = username.trim().toLowerCase();
  const createdAt = new Date().toISOString();
  const user: AuthUser = {
    id: randomUUID(),
    username: normalizedUsername,
    passwordHash: hashPassword(password),
    role,
    createdAt,
  };

  getDb().prepare(
    'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(user.id, user.username, user.passwordHash, user.role, user.createdAt);

  return user;
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `${SCRYPT_PREFIX}$${salt}$${derived}`;
}

export function verifyPassword(password: string, passwordHash: string) {
  const [scheme, salt, expectedHex] = passwordHash.split('$');
  if (scheme !== SCRYPT_PREFIX || !salt || !expectedHex) {
    return false;
  }

  const actual = Buffer.from(scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex'), 'utf-8');
  const expected = Buffer.from(expectedHex, 'utf-8');
  if (actual.length !== expected.length) {
    timingSafeEqual(actual, actual);
    return false;
  }

  return timingSafeEqual(actual, expected);
}
