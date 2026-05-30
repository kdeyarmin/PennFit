// Observability primitives — currently just the external-API
// latency wrapper.
//
// Why this exists
// ---------------
// Stripe / SendGrid / Twilio / OpenAI live outside our process and
// each is a potential source of unexplained slowness at the
// application edge. Today we only see them in the access-log line
// for the surrounding HTTP request — bundled with everything else
// that request did. P3.9 introduces a uniform timing wrapper so
// per-vendor latency is visible as its own structured event.
//
// Output channel: pino. We don't ship a metrics agent today
// (Datadog / Prometheus etc.), but the structured events we emit
// here have the right shape to be scraped or forwarded later
// without any code change at the call sites — switch the consumer,
// keep the producer.
//
// Correlation: pino's mixin (see lib/logger.ts) automatically adds
// `requestId` to every line emitted from inside an active
// AsyncLocalStorage scope (P3.7), so each external_api_latency
// event ties back to the originating HTTP request without any
// explicit threading.

import { logger } from "./logger";

export interface WithMetricsOptions {
  /**
   * Stable, low-cardinality identifier for the call site. The
   * convention is `<vendor>.<operation>` (e.g. `stripe.refunds.create`,
   * `sendgrid.send_email`, `twilio.sms.create`) so dashboards can
   * group by name without exploding cardinality with per-request
   * detail.
   */
  name: string;
  /**
   * Optional caller-supplied attributes attached to the emitted
   * event. Keep small — every histogram bucket multiplies by these.
   * Examples: `{ vendor_endpoint: 'us-west' }`, `{ idempotent: true }`.
   * NEVER include PHI or per-row identifiers here.
   */
  attrs?: Record<string, string | number | boolean>;
}

/**
 * Time `fn`, emit a structured `external_api_latency` event when it
 * settles, return (or rethrow) the result unchanged. Adds zero
 * behavioural change to the wrapped call.
 *
 *   await withMetrics(
 *     { name: "stripe.refunds.create" },
 *     () => stripe.refunds.create(args, opts),
 *   );
 *
 * Event shape:
 *   event:        "external_api_latency"
 *   name:         <opts.name>
 *   outcome:      "success" | "failure"
 *   elapsed_ms:   <number>   // 2-decimal precision
 *   ...attrs                 // flattened from opts.attrs
 *   requestId:    <string>?  // injected by lib/logger.ts mixin (P3.7)
 *
 * On failure the wrapper does NOT log the error itself — that's the
 * caller's responsibility (and they typically log structured
 * vendor-specific fields like stripe_request_id which the wrapper
 * doesn't see). The wrapper only times the call.
 */
export async function withMetrics<T>(
  opts: WithMetricsOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAtNs = process.hrtime.bigint();
  let outcome: "success" | "failure" = "success";
  try {
    return await fn();
  } catch (err) {
    outcome = "failure";
    throw err;
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
    // Round to 2 decimals to keep log lines compact. The histogram
    // consumer cares about distribution, not nanosecond precision.
    const rounded = Math.round(elapsedMs * 100) / 100;
    logger.info(
      {
        event: "external_api_latency",
        name: opts.name,
        outcome,
        elapsed_ms: rounded,
        ...opts.attrs,
      },
      `${opts.name} ${outcome} in ${rounded}ms`,
    );
  }
}
