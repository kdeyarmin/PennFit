// Invite help documents — getting-started guides attached to invite
// emails, tailored to the new user's type (patient vs staff role).
export {
  HELP_DOC_VERSION,
  PATIENT_HELP_DOCS,
  PROVIDER_HELP_DOCS,
  staffHelpDocs,
  type HelpDoc,
  type HelpDocSection,
} from "./content";
export {
  buildInviteHelpAttachments,
  __clearHelpDocCache,
  type HelpDocAudience,
} from "./render";
export {
  CUSTOMER_SERVICE_MANUAL_FILENAME,
  loadCustomerServiceManual,
  __clearManualCache,
} from "./manual";
