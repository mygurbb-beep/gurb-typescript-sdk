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
 */
export { GurbClient, createGurbClient } from './client.js'
export type { GurbClientOptions } from './client.js'
export { GurbAdminClient, createGurbAdminClient } from './admin-client.js'
export type { GurbAdminClientOptions } from './admin-client.js'
export { GurbApiError } from './errors.js'
export * from '@gurb/api-types'
