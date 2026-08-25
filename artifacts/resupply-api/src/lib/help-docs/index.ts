// Invite help documents — getting-started guides attached to invite
// emails, tailored to the new user's type (patient vs staff role).
export {
  HELP_DOC_VERSION,
  patientHelpDocs,
  providerHelpDocs,
  staffHelpDocs,
  type HelpDoc,
  type HelpDocSection,
} from "./content";
export {
  buildInviteHelpAttachments,
  __clearHelpDocCache,
  type HelpDocAudience,
  type InviteHelpAttachment,
} from "./render";
export {
  staffRoleProfile,
  type StaffRoleFamily,
  type StaffRoleProfile,
} from "./roles";
export {
  CUSTOMER_SERVICE_MANUAL_FILENAME,
  loadCustomerServiceManual,
  __clearManualCache,
} from "./manual";
