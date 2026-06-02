// Side-effect entrypoint for the demo sandbox. Importing this module
// installs the fetch interceptor immediately.
//
// main.tsx imports it as its FIRST import so the wrapper replaces
// window.fetch before <App> — and specifically before the auth client,
// which binds globalThis.fetch at module-load time — is evaluated.
import { installDemoFetchInterceptor } from "./install";

installDemoFetchInterceptor();
