// Same rule the dispense-readiness reviewer uses for E0601: the payer
// profile's DME prior-auth flag, plus a parsed eligibility result that
// says this service needs one. A Medicare name alone does not.

export function e0601PriorAuthRequired(input: {
  payerRequiresPriorAuthDme: boolean | null;
  eligibilityRequiresPriorAuth: boolean | null;
}): boolean {
  if (input.eligibilityRequiresPriorAuth === true) return true;
  return input.payerRequiresPriorAuthDme === true;
}
