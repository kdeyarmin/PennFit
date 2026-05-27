// Public surface of @workspace/resupply-auth-react.
//
// Two entry points:
//   * `createAuthClient({ basePath })` — the fetch wrapper. Stateless;
//     each SPA constructs one and reuses it.
//   * `createAuthHooks(client)` — React Query hooks bound to a
//     specific client. Returns an object exposing `useSession`,
//     `useSignIn`, etc. Each SPA stores this once at app boot.

export { createAuthClient, AuthError } from "./client";
export type {
  AuthClient,
  AuthClientConfig,
  AuthErrorCode,
  AuthMe,
} from "./client";

export { createAuthHooks, SESSION_QUERY_KEY } from "./hooks";
export type { AuthHooks, CreateAuthHooksOptions } from "./hooks";

export { authErrorMessage, serverUnavailableMessage } from "./error-message";
export type { AuthErrorMessageOptions } from "./error-message";
