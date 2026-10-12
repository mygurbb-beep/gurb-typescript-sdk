/**
 * @gurb/server — server-side SDK for the Gurb community platform.
 *
 * ⚠️  This package holds secret keys. It throws if it detects a browser
 * environment. For anything running in a user's browser, use `@gurb/embed`.
 *
 * Two clients, two credentials, deliberately not interchangeable:
 *
 *   GurbClient       gurb_<id>_<secret>      one community — read, members, embed
 *   GurbAdminClient  gurb_sa_<id>_<secret>   the platform — create communities, mint keys
 *
 * And, for a partner (host) site: GurbPartnerEvents, keyed by the community's
 * EVENTS secret (whsec_…), which tells Gurb who may still be inside.
 */
export { GurbClient, createGurbClient } from './client.js'
export type { GurbClientOptions } from './client.js'
export { GurbAdminClient, createGurbAdminClient } from './admin-client.js'
export type { GurbAdminClientOptions } from './admin-client.js'
export { GurbApiError } from './errors.js'
export {
  GurbPartnerEvents,
  createGurbPartnerEvents,
  PARTNER_EVENT_LIMITS,
  signPartnerEvent,
} from './partner-events.js'
export type {
  PartnerEvent,
  PartnerEventType,
  PartnerEventsOptions,
  PartnerAccess,
  PartnerSnapshotMember,
  PartnerSendOutcome,
  PartnerSendResult,
} from './partner-events.js'
export * from '@gurb/api-types'
