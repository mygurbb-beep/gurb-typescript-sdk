import { describe, expect, it } from 'vitest'
import {
  PERMISSION_CATALOG, allPermissions, findPermission, permissionLabels,
  impliedBy, effectivePermissions, assignableTo, permissionsForRole,
} from './permissions.js'

describe('the catalogue', () => {
  it('carries every permission the platform defines', () => {
    expect(allPermissions()).toHaveLength(PERMISSION_CATALOG.total)
    expect(PERMISSION_CATALOG.total).toBe(48)
    expect(PERMISSION_CATALOG.categories).toHaveLength(26)
  })

  /**
   * The whole reason this ships as data. A blank label renders as an empty
   * cell, which reads as "this permission does nothing" rather than as a gap.
   */
  it('has BOTH languages on every single row — no blanks', () => {
    const blank = allPermissions().filter(
      (p) => !p.name || !p.nameArabic || !p.description || !p.descriptionArabic,
    )
    expect(blank.map((p) => p.id)).toEqual([])
  })

  it('has no duplicate ids across categories', () => {
    const ids = allPermissions().map((p) => p.id)
    expect(ids).toHaveLength(new Set(ids).size)
  })

  it('shapes every id as module:verb', () => {
    for (const p of allPermissions()) expect(p.id).toMatch(/^[a-z0-9_]+:[a-z0-9_]+$/)
  })
})

describe('labels', () => {
  it('answers Arabic by default and English on request', () => {
    expect(permissionLabels()['users:manage']).toBe(findPermission('users:manage')!.nameArabic)
    expect(permissionLabels('en')['users:manage']).toBe(findPermission('users:manage')!.name)
  })

  it('covers every id, so a `?? id` fallback is a safety net and not the norm', () => {
    const labels = permissionLabels()
    expect(allPermissions().filter((p) => !labels[p.id])).toEqual([])
  })
})

/**
 * THE RULE THAT MAKES RAW COUNTS LIE.
 *
 * A COMMUNITY_ADMIN is granted `posts:manage`; a MODERATOR is granted
 * `posts:create` AND `posts:moderate`. Counted naively the moderator looks more
 * powerful — 33 stored against 29 — and any screen that compares roles by list
 * length tells the reader the opposite of the truth.
 */
describe('manage subsumes create and moderate', () => {
  it('stores FEWER permissions for the admin than for the moderator', () => {
    const admin = PERMISSION_CATALOG.roleDefaults.COMMUNITY_ADMIN!.length
    const mod = PERMISSION_CATALOG.roleDefaults.MODERATOR!.length
    expect(admin).toBe(29)
    expect(mod).toBe(33)
    expect(admin).toBeLessThan(mod) // ← the misleading fact, pinned deliberately
  })

  it('but resolves the admin to MORE actual capability once manage is expanded', () => {
    expect(effectivePermissions('COMMUNITY_ADMIN').length).toBeGreaterThan(
      effectivePermissions('MODERATOR').length,
    )
  })

  it('grants create and moderate to a holder of manage', () => {
    expect(impliedBy(['posts:manage'], 'posts:create')).toBe(true)
    expect(impliedBy(['posts:manage'], 'posts:moderate')).toBe(true)
  })

  it('does NOT work in reverse — create never implies manage', () => {
    expect(impliedBy(['posts:create'], 'posts:manage')).toBe(false)
  })

  it('never leaks across modules', () => {
    expect(impliedBy(['posts:manage'], 'blogs:create')).toBe(false)
  })

  it('gives the admin the create permissions it was never granted directly', () => {
    const stored = PERMISSION_CATALOG.roleDefaults.COMMUNITY_ADMIN!
    expect(stored).not.toContain('posts:create')
    expect(effectivePermissions('COMMUNITY_ADMIN')).toContain('posts:create')
  })
})

describe('MEMBER', () => {
  /** Not a bug and not a gap — every capability is granted individually. */
  it('holds nothing at all, by design', () => {
    expect(PERMISSION_CATALOG.roleDefaults.MEMBER).toEqual([])
    expect(effectivePermissions('MEMBER')).toEqual([])
  })
})

describe('what an admin may grant', () => {
  it('offers a real subset to a moderator', () => {
    const a = assignableTo('MODERATOR')
    expect(a.length).toBeGreaterThan(0)
    expect(a.length).toBeLessThan(PERMISSION_CATALOG.total)
  })

  it('never offers an admin-only permission to anybody', () => {
    for (const p of allPermissions()) {
      if (p.assignableTo.length === 0) {
        expect(assignableTo('MODERATOR')).not.toContain(p)
        expect(assignableTo('MEMBER')).not.toContain(p)
      }
    }
  })
})

describe('permissionsForRole — one call for a whole screen', () => {
  it('returns every category, in the platform order, with labels', () => {
    const view = permissionsForRole('MODERATOR')
    expect(view).toHaveLength(26)
    expect(view[0]!.label).toBe(PERMISSION_CATALOG.categories[0]!.nameArabic)
    expect(permissionsForRole('MODERATOR', 'en')[0]!.label).toBe(
      PERMISSION_CATALOG.categories[0]!.name,
    )
  })

  it('marks held rows using the EXPANDED set, not the stored one', () => {
    const flat = permissionsForRole('COMMUNITY_ADMIN').flatMap((c) => c.permissions)
    expect(flat.find((p) => p.id === 'posts:create')?.held).toBe(true)
  })

  it('marks nothing held for a plain member', () => {
    const flat = permissionsForRole('MEMBER').flatMap((c) => c.permissions)
    expect(flat.filter((p) => p.held)).toEqual([])
  })

  it('never loses a permission — the view is the whole catalogue', () => {
    const flat = permissionsForRole('MEMBER').flatMap((c) => c.permissions)
    expect(flat).toHaveLength(PERMISSION_CATALOG.total)
  })
})
