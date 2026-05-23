// Test-only helpers. Lives in src/ (not test/) so it can be imported
// by both unit tests and the supertest integration tests in
// `src/http/*.test.ts`. Not part of the public surface — never
// re-exported from `./index`.

import { hashPassword } from "./password";
import type {
  AuthEmailTokenRow,
  AuthRepository,
  AuthSession,
  AuthUser,
  PasswordCredential,
} from "./repository";

/**
 * In-memory repo for tests. Not threadsafe, not transactional —
 * simulating Postgres semantics enough for the handler-level tests
 * to be useful. The DB-backed repo gets exercised separately by
 * the resupply-db migration test (Stage 1) and by the integration
 * smoke harness in resupply-testing (future).
 */
export interface MemoryRepo extends AuthRepository {
  // Direct hooks for the test to set up state without going through
  // SQL.
  __putUser(u: AuthUser): void;
  __putCredential(c: PasswordCredential): void;
  __sessions(): AuthSession[];
  __users(): AuthUser[];
  __credentials(): PasswordCredential[];
  __emailTokens(): AuthEmailTokenRow[];
  __failures(emailLower: string): number;
  /**
   * Count failed attempts whose `emailLower` starts with `prefix`.
   * Useful for asserting per-endpoint IP-sentinel counters
   * (e.g. `__reset:`, `__verify:`, `__forgot:`) without having
   * to know the actual `req.ip` that supertest will produce.
   */
  __failuresStartingWith(prefix: string): number;
  __successes(emailLower: string): number;
  __forceFailures(emailLower: string, count: number): void;
}

interface Attempt {
  emailLower: string;
  ip: string | null;
  success: boolean;
  attemptedAt: Date;
}

export function makeMemoryRepo(now: () => Date = () => new Date()): MemoryRepo {
  const users = new Map<string, AuthUser>();
  const credentials = new Map<string, PasswordCredential>();
  const sessions = new Map<string, AuthSession>();
  const sessionsByHash = new Map<string, AuthSession>();
  const emailTokens = new Map<string, AuthEmailTokenRow>();
  const attempts: Attempt[] = [];
  let userSeq = 0;

  const repo: MemoryRepo = {
    async findUserByEmail(emailLower) {
      for (const u of users.values()) {
        if (u.emailLower === emailLower) return u;
      }
      return null;
    },
    async findUserById(id) {
      return users.get(id) ?? null;
    },
    async insertUser(input) {
      userSeq += 1;
      const user: AuthUser = {
        id: `u_mem_${userSeq}`,
        emailLower: input.emailLower,
        displayName: input.displayName,
        role: input.role,
        status: input.status,
        emailVerifiedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      users.set(user.id, user);
      return user;
    },
    async markEmailVerified(userId, at) {
      const u = users.get(userId);
      if (!u) return;
      if (!u.emailVerifiedAt) u.emailVerifiedAt = at;
      if (u.status === "invited") u.status = "active";
      u.updatedAt = at;
    },
    async updateUserStatus(userId, status) {
      const u = users.get(userId);
      if (!u) return;
      u.status = status;
      u.updatedAt = now();
    },
    async findCredentialByUserId(userId) {
      return credentials.get(userId) ?? null;
    },
    async upsertCredential(input) {
      // Mirror the supabase-repository semantics: undefined ⇒
      // preserve the existing column; null ⇒ clear it; Date ⇒
      // overwrite. The sign-in algorithm-upgrade path relies on
      // "preserve" so a stale operator-typed credential keeps its
      // expiry clock when it gets rehashed.
      const prior = credentials.get(input.userId) ?? null;
      let setByAdminAt: Date | null;
      if (input.setByAdminAt === undefined) {
        setByAdminAt = prior?.setByAdminAt ?? null;
      } else {
        setByAdminAt = input.setByAdminAt;
      }
      credentials.set(input.userId, {
        userId: input.userId,
        passwordHash: input.passwordHash,
        algo: "argon2id-v1",
        mustChange: input.mustChange ?? false,
        setByAdminAt,
        updatedAt: now(),
      });
    },
    async findSessionByTokenHash(hash) {
      return sessionsByHash.get(hash.toString("hex")) ?? null;
    },
    async insertSession(input) {
      const session: AuthSession = {
        id: `s_${sessions.size + 1}`,
        userId: input.userId,
        issuedAt: now(),
        expiresAt: input.expiresAt,
        lastSeenAt: now(),
        revokedAt: null,
        ip: input.ip,
        userAgentHash: input.userAgentHash,
      };
      sessions.set(session.id, session);
      sessionsByHash.set(input.tokenHash.toString("hex"), session);
      return session;
    },
    async revokeSession(sessionId, at) {
      const s = sessions.get(sessionId);
      if (!s || s.revokedAt) return;
      s.revokedAt = at;
    },
    async revokeAllUserSessions(userId, at) {
      for (const s of sessions.values()) {
        if (s.userId === userId && !s.revokedAt) s.revokedAt = at;
      }
    },
    async revokeOtherUserSessions(userId, exceptSessionId, at) {
      for (const s of sessions.values()) {
        if (s.userId === userId && s.id !== exceptSessionId && !s.revokedAt) {
          s.revokedAt = at;
        }
      }
    },
    async bumpSession(sessionId, expiresAt, at) {
      const s = sessions.get(sessionId);
      if (!s || s.revokedAt) return;
      s.expiresAt = expiresAt;
      s.lastSeenAt = at;
    },
    async insertEmailToken(input) {
      emailTokens.set(input.tokenHash.toString("hex"), {
        tokenHash: input.tokenHash,
        userId: input.userId,
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now(),
      });
    },
    async consumeEmailToken(input) {
      const key = input.tokenHash.toString("hex");
      const row = emailTokens.get(key);
      if (!row) return null;
      if (row.consumedAt) return null;
      if (row.expiresAt.getTime() <= input.at.getTime()) return null;
      row.consumedAt = input.at;
      return row;
    },
    async recordLoginAttempt(input) {
      attempts.push({ ...input, attemptedAt: now() });
    },
    async countRecentFailures(input) {
      const cutoff = now().getTime() - input.sinceMs;
      let n = 0;
      for (const a of attempts) {
        if (a.success) continue;
        if (a.attemptedAt.getTime() <= cutoff) continue;
        if (input.emailLower !== null && a.emailLower === input.emailLower) {
          n++;
          continue;
        }
        if (input.ip !== null && a.ip === input.ip) {
          n++;
          continue;
        }
      }
      return n;
    },

    __putUser(u) {
      users.set(u.id, u);
    },
    __putCredential(c) {
      credentials.set(c.userId, c);
    },
    __sessions() {
      return [...sessions.values()];
    },
    __users() {
      return [...users.values()];
    },
    __credentials() {
      return [...credentials.values()];
    },
    __emailTokens() {
      return [...emailTokens.values()];
    },
    __failures(emailLower) {
      return attempts.filter((a) => !a.success && a.emailLower === emailLower)
        .length;
    },
    __failuresStartingWith(prefix) {
      return attempts.filter(
        (a) => !a.success && a.emailLower.startsWith(prefix),
      ).length;
    },
    __successes(emailLower) {
      return attempts.filter((a) => a.success && a.emailLower === emailLower)
        .length;
    },
    __forceFailures(emailLower, count) {
      for (let i = 0; i < count; i++) {
        attempts.push({
          emailLower,
          ip: null,
          success: false,
          attemptedAt: now(),
        });
      }
    },
  };
  return repo;
}

/** Convenience: insert a user + credential pair with a hashed password. */
export async function seedUserWithPassword(
  repo: MemoryRepo,
  input: {
    id: string;
    emailLower: string;
    role?: AuthUser["role"];
    status?: AuthUser["status"];
    emailVerified?: boolean;
    password: string;
  },
): Promise<AuthUser> {
  const user: AuthUser = {
    id: input.id,
    emailLower: input.emailLower,
    displayName: null,
    role: input.role ?? "customer",
    status: input.status ?? "active",
    emailVerifiedAt: (input.emailVerified ?? true) ? new Date() : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  repo.__putUser(user);
  const hash = await hashPassword(input.password, {
    memoryCost: 1024,
    timeCost: 1,
    parallelism: 1,
  });
  repo.__putCredential({
    userId: user.id,
    passwordHash: hash,
    algo: "argon2id-v1",
    mustChange: false,
    setByAdminAt: null,
    updatedAt: new Date(),
  });
  return user;
}
