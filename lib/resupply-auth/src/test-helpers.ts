// Test-only helpers. Lives in src/ (not test/) so it can be imported
// by both unit tests and the supertest integration tests in
// `src/http/*.test.ts`. Not part of the public surface — never
// re-exported from `./index`.

import { hashPassword } from "./password";
import type {
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
  __failures(emailLower: string): number;
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
  const attempts: Attempt[] = [];

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
    async findCredentialByUserId(userId) {
      return credentials.get(userId) ?? null;
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
    async bumpSession(sessionId, expiresAt, at) {
      const s = sessions.get(sessionId);
      if (!s || s.revokedAt) return;
      s.expiresAt = expiresAt;
      s.lastSeenAt = at;
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
    __failures(emailLower) {
      return attempts.filter((a) => !a.success && a.emailLower === emailLower)
        .length;
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
    pepper: Buffer;
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
  const hash = await hashPassword(input.password, input.pepper, {
    memoryCost: 1024,
    timeCost: 1,
    parallelism: 1,
  });
  repo.__putCredential({
    userId: user.id,
    passwordHash: hash,
    algo: "argon2id-v1",
    mustChange: false,
    updatedAt: new Date(),
  });
  return user;
}
