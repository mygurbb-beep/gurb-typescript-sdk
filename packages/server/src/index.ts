/**
 * @gurb/server — server-side SDK for the Gurb community platform.
 *
 * ⚠️  This package holds your secret API key. It throws if it detects a browser
 * environment. For anything running in a user's browser, use `@gurb/embed`.
 */
export { GurbClient, createGurbClient } from './client.js'
export type { GurbClientOptions } from './client.js'
export { GurbApiError } from './errors.js'
export * from '@gurb/api-types'
