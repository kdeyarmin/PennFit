// Public barrel for the XPS Ship integration package.
export {
  readXpsShipConfigOrNull,
  isXpsShipUnconfigured,
  DEFAULT_XPS_API_BASE_URL,
  type XpsAddress,
  type XpsShipConfig,
} from "./config";

export {
  createXpsShipAdapter,
  type XpsShipAdapter,
  type XpsAvailability,
  type XpsResult,
} from "./adapter";

export type {
  XpsCreateOrderInput,
  XpsError,
  XpsLabel,
  XpsParcel,
  XpsQuoteInput,
  XpsRate,
  XpsShipment,
} from "./types";

export {
  validateReceiverAddress,
  type AddressIssue,
  type AddressValidation,
} from "./validate";
