# `@workspace/resupply-auth-react`

Headless React hooks + a small fetch client for the in-house auth
API exposed by `lib/resupply-auth`. Designed to be consumed by both
`artifacts/resupply-dashboard` (staff) and `artifacts/cpap-fitter`
(customer + admin) without imposing a UI library.

What's in here:

- `createAuthClient({ basePath })` — fetch wrapper for `/auth/*`
  endpoints. Handles the `pf_csrf` cookie read + `X-PF-CSRF` header
  injection, typed `AuthError` for non-2xx responses, and shape-safe
  parsing of `{ error, message }` bodies.
- `createAuthHooks(client)` — React Query hooks: `useSession`,
  `useSignIn`, `useSignUp`, `useSignOut`, `useForgotPassword`,
  `useResetPassword`, `useVerifyEmail`, `useChangePassword`. The
  hooks invalidate the `/me` query key on mutations that flip
  identity state.

What's NOT in here:

- JSX components / forms. Each product has its own design tokens;
  forms are written per-product in the consuming SPA. The hooks
  expose everything a form component needs.
- Routing. The SPA decides where its sign-in / verify pages live.
