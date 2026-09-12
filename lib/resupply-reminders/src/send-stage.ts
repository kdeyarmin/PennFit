// Keep the original error object: callers already inspect vendor error classes
// and PostgREST codes. This process-local signal adds no fields to logged errors.
const preSendErrors = new WeakSet<object>();

export function isReminderPreSendError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && preSendErrors.has(error)
  );
}

export interface ReminderSendStage {
  readonly providerAttempted: boolean;
  markProviderAttempted(): void;
  /** Only for a vendor wrapper's known local validation error, before SDK I/O. */
  markProviderNotAttempted(): void;
}

/** Preserve ambiguous transport and post-acceptance failures as possibly sent. */
export async function withReminderSendStage<T>(
  run: (stage: ReminderSendStage) => Promise<T>,
): Promise<T> {
  let attempted = false;
  try {
    return await run({
      get providerAttempted() {
        return attempted;
      },
      markProviderAttempted: () => {
        attempted = true;
      },
      markProviderNotAttempted: () => {
        attempted = false;
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      // A reused error object must reflect this attempt, not an earlier one.
      if (attempted) preSendErrors.delete(error);
      else preSendErrors.add(error);
    }
    throw error;
  }
}
