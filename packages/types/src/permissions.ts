/**
 * The permission catalogue, shipped as DATA rather than fetched.
 *
 * WHY IT IS EMBEDDED
 *
 * Every permission the platform defines, with Arabic and English labels. It is
 * platform metadata — it changes when Gurb ships a new permission, a few times
 * a year — not per-community state, so there is nothing to fetch and nothing
 * to cache. Rendering a permission screen costs zero network calls.
 *
 * Regenerate on each release from the backend's own constants; the `source`
 * field in the JSON records where it came from.
 */
import catalog from './permission-catalog.json' with { type: 'json' }
import type { CommunityRole } from './index.js'

export interface CatalogPermission {
  id: string
  name: string
  nameArabic: string
  description: string
  descriptionArabic: string
  /** `manage` | `create` | `moderate` | `customize` — see `impliedBy`. */
  type: string
  /** Which roles an admin may grant this to. Empty means admin-only. */
  assignableTo: string[]
}

export interface CatalogCategory {
  id: string
  name: string
  nameArabic: string
  permissions: CatalogPermission[]
}

export const PERMISSION_CATALOG = catalog as {
  source: string
  total: number
  categories: CatalogCategory[]
  roleDefaults: Record<string, string[]>
}

export type PermissionLocale = 'ar' | 'en'

/** Every permission the platform defines, flattened. */
export function allPermissions(): CatalogPermission[] {
  return PERMISSION_CATALOG.categories.flatMap((c) => c.permissions)
}

/** One permission by id, or undefined when the catalogue does not define it. */
export function findPermission(id: string): CatalogPermission | undefined {
  return allPermissions().find((p) => p.id === id)
}

/**
 * An id → label map, ready to render.
 *
 * KEEP A `?? id` FALLBACK at the call site. A member can hold a permission
 * minted by a platform release newer than this catalogue, and a missing key
 * rendering as an empty string makes a permission vanish from the screen.
 */
export function permissionLabels(locale: PermissionLocale = 'ar'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of allPermissions()) out[p.id] = locale === 'ar' ? p.nameArabic : p.name
  return out
}

/**
 * `module:manage` SUBSUMES `module:create` and `module:moderate`.
 *
 * THIS IS THE ONE RULE THAT MAKES RAW COUNTS LIE. Every guard in Gurb accepts
 * `manage | create | moderate` for a module, so a COMMUNITY_ADMIN holding
 * `posts:manage` can create posts without holding `posts:create`.
 *
 * Counted naively, a MODERATOR looks MORE powerful than a COMMUNITY_ADMIN — 33
 * default permissions against 29 — because the moderator is granted the
 * granular pair where the admin is granted the one that covers both. Any screen
 * that compares roles by list length states the opposite of the truth.
 */
export function impliedBy(held: readonly string[], wanted: string): boolean {
  if (held.includes(wanted)) return true
  const [module, verb] = wanted.split(':')
  if (!module || !verb || verb === 'manage') return false
  return held.includes(`${module}:manage`)
}

/**
 * What a role can actually do — expanded, not as stored.
 *
 * Takes the role's stored defaults and adds every permission its `*:manage`
 * grants imply. This is the number to show a human.
 */
export function effectivePermissions(role: CommunityRole | string): string[] {
  const held = PERMISSION_CATALOG.roleDefaults[role] ?? []
  return allPermissions()
    .map((p) => p.id)
    .filter((id) => impliedBy(held, id))
}

/** The permissions an admin may grant to this role. Admin-only ones are excluded. */
export function assignableTo(role: 'MODERATOR' | 'MEMBER'): CatalogPermission[] {
  return allPermissions().filter((p) => p.assignableTo.includes(role))
}

/**
 * The catalogue grouped for display, marking what the role already has.
 *
 * One call gives a permission screen everything it needs: categories in the
 * platform's own order, labels in the requested language, and per row whether
 * the role holds it by default and whether it may be granted at all.
 */
export function permissionsForRole(
  role: CommunityRole | string,
  locale: PermissionLocale = 'ar',
): {
  id: string
  label: string
  permissions: { id: string; label: string; description: string; held: boolean; assignable: boolean }[]
}[] {
  const effective = new Set(effectivePermissions(role))
  return PERMISSION_CATALOG.categories.map((c) => ({
    id: c.id,
    label: locale === 'ar' ? c.nameArabic : c.name,
    permissions: c.permissions.map((p) => ({
      id: p.id,
      label: locale === 'ar' ? p.nameArabic : p.name,
      description: locale === 'ar' ? p.descriptionArabic : p.description,
      held: effective.has(p.id),
      assignable: p.assignableTo.includes(role as 'MODERATOR' | 'MEMBER'),
    })),
  }))
}
