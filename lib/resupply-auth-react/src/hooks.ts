// React Query hooks over the AuthClient.
//
// All hooks are produced by `createAuthHooks(client)` so the SPA can
// hold one client instance and pass it once. This avoids the
// alternative (a React context for the client) which would force
// every consumer to wrap a provider, and also avoids hidden module-
// level singletons.
//
// Mutations invalidate the `/me` query key on success so a sign-in,
// sign-out, or password reset is reflected immediately in any
// consumer of `useSession`.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { AuthClient, AuthError, AuthMe, SignInResult } from "./client";

export const SESSION_QUERY_KEY = ["auth", "me"] as const;

export interface AuthHooks {
  /**
   * Read-only "who is the current user". Returns `null` when there's
   * no session (the API responded 401). Errors throw via React
   * Query as usual; consumers should branch on `data === null`.
   */
  useSession(): UseQueryResult<AuthMe | null, AuthError>;

  useSignIn(): UseMutationResult<
    SignInResult,
    AuthError,
    { email: string; password: string }
  >;
  /**
   * Second step of the MFA sign-in flow. Pass the challenge token
   * returned from `useSignIn` and the 6-digit code from the
   * authenticator. On success the session cookie is set and
   * `/me` invalidated.
   */
  useVerifySignInMfa(): UseMutationResult<
    void,
    AuthError,
    { challengeToken: string; code: string }
  >;
  useSignUp(): UseMutationResult<
    void,
    AuthError,
    { email: string; password: string; displayName?: string }
  >;
  useSignOut(): UseMutationResult<void, AuthError, void>;
  useForgotPassword(): UseMutationResult<void, AuthError, { email: string }>;
  useResetPassword(): UseMutationResult<
    void,
    AuthError,
    { token: string; password: string }
  >;
  useVerifyEmail(): UseMutationResult<void, AuthError, { token: string }>;
  useChangePassword(): UseMutationResult<
    void,
    AuthError,
    { currentPassword: string; newPassword: string }
  >;
}

export interface CreateAuthHooksOptions {
  /**
   * Cache /me for `staleTime` ms. Default 60s — same value the
   * dashboard uses for the existing /me probe so tab-switching
   * doesn't hammer the API. Override to 0 in tests if the test
   * needs an unconditional refetch.
   */
  staleTime?: number;
}

export function createAuthHooks(
  client: AuthClient,
  options: CreateAuthHooksOptions = {},
): AuthHooks {
  const staleTime = options.staleTime ?? 60_000;

  function invalidateMe(qc: QueryClient): void {
    void qc.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }

  return {
    useSession() {
      return useQuery({
        queryKey: SESSION_QUERY_KEY,
        queryFn: () => client.fetchMe(),
        staleTime,
        refetchOnWindowFocus: false,
      });
    },

    useSignIn() {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (input) => client.signIn(input),
        onSuccess: (result) => {
          // Only invalidate /me on the single-step path — the
          // mfaRequired branch hasn't set a session cookie yet,
          // and invalidating would trigger a /me probe that
          // returns 401 and confuses any session-watching gates.
          if (!result.mfaRequired) {
            invalidateMe(qc);
          }
        },
      });
    },

    useVerifySignInMfa() {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (input) => client.verifySignInMfa(input),
        onSuccess: () => invalidateMe(qc),
      });
    },

    useSignUp() {
      // Sign-up does NOT issue a session (the user has to verify
      // their email first), so we do NOT invalidate /me here.
      return useMutation({
        mutationFn: (input) => client.signUp(input),
      });
    },

    useSignOut() {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: () => client.signOut(),
        onSuccess: () => {
          // Reset to null immediately so any gate watching
          // useSession redirects without a flicker.
          qc.setQueryData(SESSION_QUERY_KEY, null);
          invalidateMe(qc);
        },
      });
    },

    useForgotPassword() {
      return useMutation({
        mutationFn: (input) => client.forgotPassword(input),
      });
    },

    useResetPassword() {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (input) => client.resetPassword(input),
        onSuccess: () => {
          // Server revoked all sessions for this user. Force the
          // SPA to re-fetch; it'll get null and route to sign-in.
          qc.setQueryData(SESSION_QUERY_KEY, null);
          invalidateMe(qc);
        },
      });
    },

    useVerifyEmail() {
      // Verify-email doesn't issue a session either, but it does
      // change emailVerified for any signed-in user, so refresh
      // /me after.
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (input) => client.verifyEmail(input),
        onSuccess: () => invalidateMe(qc),
      });
    },

    useChangePassword() {
      // Change-password keeps the current session alive; just
      // refresh /me defensively in case server-side state moved.
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (input) => client.changePassword(input),
        onSuccess: () => invalidateMe(qc),
      });
    },
  };
}
