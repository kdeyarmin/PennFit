export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  customFetch,
  setBaseUrl,
  setAuthTokenGetter,
  ApiError,
} from "./custom-fetch";
export type { AuthTokenGetter, ErrorType } from "./custom-fetch";
