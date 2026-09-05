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

import { BLOCK_SCOPES } from '@civitai/app-sdk/blocks';

/**
 * 🔴 IMPORTED FROM THE SDK, NOT RE-TYPED. `BLOCK_SCOPES` is the vocabulary the
 * canonical manifest schema validates against by MEMBERSHIP, and `defineBlock`
 * gates on it. A second hand-written copy of those strings is the same defect
 * this change removed from `persistence.ts`'s status list: two lists of one
 * thing drift in one direction, and here the drift is silent in the worst
 * possible place — a typo'd scope literal type-checks, ships in the manifest,
 * and fails at approval or, worse, at the first privileged call, as a FORBIDDEN
 * the app reports as "storage is unavailable".
 */

/** Spends the viewer's Buzz, capped by `page.buzzBudgetPerGen`. */
export const BUDGETED_SCOPE = BLOCK_SCOPES.AI_WRITE_BUDGETED;

/** Reads this viewer's own private per-app KV rows (`useAppStorage().get/list`). */
export const STORAGE_READ_SCOPE = BLOCK_SCOPES.APPS_STORAGE_READ;

/** Writes this viewer's own private per-app KV rows (`useAppStorage().set/delete`). */
export const STORAGE_WRITE_SCOPE = BLOCK_SCOPES.APPS_STORAGE_WRITE;

/**
 * Reads the app-scoped SHARED store — the published-matrix gallery every viewer
 * browses (`useSharedStorage().list/get/getCount(s)`).
 *
 * 🔴 A DIFFERENT TRUST BOUNDARY FROM `apps:storage:read`, which is why it is a
 * separate scope rather than an extension of it: the private store returns rows
 * this viewer wrote, the shared store returns rows OTHER people wrote. Reading
 * is the half every viewer needs; writing is gated separately below.
 */
export const SHARED_READ_SCOPE = BLOCK_SCOPES.APPS_STORAGE_SHARED_READ;

/**
 * Writes to the shared store — publishing a matrix, voting on one, reporting
 * one, and withdrawing the viewer's own entry
 * (`useSharedStorage().append/update/vote/unvote/report/withdraw`).
 *
 * Voting and reporting sit behind this same scope, so a viewer who can browse
 * the gallery but has not been granted shared-write can still read it — the
 * failure surfaces on the control they pressed, not as a blank page.
 */
export const SHARED_WRITE_SCOPE = BLOCK_SCOPES.APPS_STORAGE_SHARED_WRITE;

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
  SHARED_READ_SCOPE,
  SHARED_WRITE_SCOPE,
] as const;

export type DeclaredScope = (typeof DECLARED_SCOPES)[number];
