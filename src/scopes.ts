/**
 * The scopes this block DECLARES in `block.manifest.json`, as a runtime value.
 *
 * 🔴 A SCOPE IS NOT AN AMBIENT CAPABILITY. The platform re-checks the token's
 * scopes on every privileged call — for storage, `resolveStorageContext` in
 * civitai's `apps.router` throws FORBIDDEN unless the required scope is present
 * in the token claims, and a scope only reaches the token when it was BOTH in
 * the manifest AND in the block's approved-scopes snapshot. So declaring a scope
 * here and in the manifest is necessary but NOT sufficient: the feature behind it
 * stays dead until a version carrying the declaration has been APPROVED.
 *
 * This module exists so that fact is checkable by a test. `manifest.test.ts`
 * pins this list against the manifest's `scopes` array and against the keys of
 * `scopeJustifications`, so a scope cannot be added to one and forgotten in the
 * other, and cannot be added anywhere without a written reason.
 */

/** Spends the viewer's Buzz, capped by `page.buzzBudgetPerGen`. */
export const BUDGETED_SCOPE = 'ai:write:budgeted';

/** Reads this viewer's own private per-app KV rows (`useAppStorage().get/list`). */
export const STORAGE_READ_SCOPE = 'apps:storage:read';

/** Writes this viewer's own private per-app KV rows (`useAppStorage().set/delete`). */
export const STORAGE_WRITE_SCOPE = 'apps:storage:write';

/**
 * Every scope the manifest declares, in manifest order.
 *
 * Order is part of the contract the lockstep test asserts, so an edit that
 * reorders the manifest is visible rather than silent.
 */
export const DECLARED_SCOPES = [
  BUDGETED_SCOPE,
  STORAGE_READ_SCOPE,
  STORAGE_WRITE_SCOPE,
] as const;

export type DeclaredScope = (typeof DECLARED_SCOPES)[number];
