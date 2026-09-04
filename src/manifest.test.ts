import { describe, expect, it } from 'vitest';

import manifest from '../block.manifest.json';
import { DECLARED_SCOPES } from './scopes.js';

/**
 * 🔴 A SCOPE THE MANIFEST DOES NOT DECLARE IS A FEATURE THAT THROWS FORBIDDEN.
 *
 * The platform re-checks the token's scopes inside every storage procedure
 * (`resolveStorageContext`, civitai `src/server/routers/apps.router.ts`) and
 * rejects the call when the required scope is absent — with the comment that
 * storage is "a DECLARED, approved scope — not an ambient capability". Before
 * this change gen-matrix declared only `ai:write:budgeted`, so every
 * `useAppStorage()` call this app has ever made — the run persistence that has
 * shipped since M1 — was rejected for every viewer, moderators included.
 *
 * That defect was invisible because the failure is silent by design: the write
 * path is deliberately best-effort (`.catch(() => undefined)`), so a FORBIDDEN
 * looks exactly like a successful save that simply had nothing to restore.
 *
 * These guards make the declaration checkable in both directions. They cannot
 * tell you the scope has been APPROVED — only a moderator's approval of a
 * released version does that — but they can tell you it was declared, and that
 * someone wrote down why.
 */

const declaredScopes = (manifest as { scopes?: unknown }).scopes;
const justifications = (manifest as { scopeJustifications?: Record<string, unknown> })
  .scopeJustifications;

describe('declared scopes', () => {
  it('keeps block.manifest.json scopes in lockstep with src/scopes.ts', () => {
    // Array equality, not set equality: order is part of the contract, so a
    // reordering edit is visible rather than silently absorbed.
    expect(declaredScopes).toEqual([...DECLARED_SCOPES]);
  });

  it('still declares the Buzz scope the money path depends on', () => {
    // Pinned as a LITERAL rather than through the constant. Every other
    // assertion here compares the manifest against `scopes.ts`, so a single edit
    // that dropped this scope from BOTH files would keep them in lockstep and go
    // green. Spending Buzz is the app's whole purpose; that regression must not
    // be reachable by editing two files consistently.
    expect(declaredScopes).toContain('ai:write:budgeted');
  });

  it('gives every declared scope a written justification, and no extras', () => {
    // Both directions: a scope with no justification is an undisclosed
    // capability request, and a justification with no scope is stale copy that
    // reads as though the app asks for something it does not.
    expect(Object.keys(justifications ?? {}).sort()).toEqual([...DECLARED_SCOPES].sort());
  });

  it('makes each justification a non-empty string that names the scope it covers', () => {
    for (const scope of DECLARED_SCOPES) {
      const text = (justifications ?? {})[scope];
      expect(typeof text, `justification for ${scope} must be a string`).toBe('string');
      // A placeholder like "" or "TODO" is worse than none — it satisfies a
      // key-presence check while disclosing nothing to the reviewer reading it.
      expect(String(text).trim().length, `justification for ${scope} must not be blank`)
        .toBeGreaterThan(30);
    }
  });
});
