// The structural claim the port off the postMessage bridge actually makes, as an
// asserted ledger.
//
// 🔴 WHAT THE PORT DID **NOT** DO: reach zero importers of `@civitai/blocks-react`.
// That is not reachable and must not be claimed. Two subpaths legitimately stay:
//
//   - `/ui` — the design-system pack (`BlockGate`, `ResourceCard`, `Badge`,
//     `ReportButton`) — until `civitai/civitai-app-starters#328` lands. Its
//     components are themselves bridge clients, which is the whole reason
//     `src/lib/sdk-transport.ts` exists: the bridge transport is constructed on
//     every production boot regardless, so the SDK ADAPTS that one instead of
//     standing up a second (two `message` listeners, two `BLOCK_HELLO`s, two
//     `BLOCK_READY`s, two token copies).
//   - `/testing` — the mock host, which still answers groups 1 and 2 (BLOCK_INIT,
//     viewer, theme, token, consent, resize, sign-in, resource picker, Buzz
//     purchase, publish). Those are STILL postMessage.
//
// 🔴 WHAT IT DID DO IS MOVE THE **COMPOSITION**: no production runtime file takes
// its runtime bindings from the bare `@civitai/blocks-react` entry any more. What
// remains on that entry is the port's own transport adapter, one dev-only module,
// and tests.
//
// WHY THIS IS A LEDGER AND NOT A COUNT. A count ("2 bare importers") passes while
// the WRONG two files are the importers — a production file could swap in for a
// test file and nothing would notice. So the assertion names the exact SET, and it
// fails when the set GROWS (a new production file reaches for the bridge) **or**
// SHRINKS (a module this ledger's reasoning depends on quietly disappeared, which
// would make the surrounding comments describe code that is no longer there).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/**
 * Every source file under `src/`, enumerated from the FILESYSTEM.
 *
 * 🔴 NOT A RECURSIVE GREP. `grep -r` on this host is a wrapper that honours
 * `.gitignore`, so it is blind to exactly the generated and ignored paths a scan
 * like this must not silently skip — and a blind scan returns a confident zero.
 * `readdirSync` sees what is there.
 */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Path relative to `src/`, with forward slashes on every platform. */
function rel(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/**
 * Classify one file's `@civitai/blocks-react` imports by ENTRY.
 *
 * 🔴 THE CLOSING QUOTE IS PART OF THE PATTERN, and leaving it off is how this
 * measurement gets reported wrong: `'@civitai/blocks-react` prefix-matches
 * `'@civitai/blocks-react/ui'` and `'@civitai/blocks-react/testing'`, so an
 * unanchored search conflates three populations into one inflated number. Each
 * entry is matched on its own full specifier, and `import(...)` is included
 * because a dynamic import is an importer too — `main.tsx` reaches `/testing`
 * that way and a `from '…'` pattern cannot see it.
 */
function entriesUsedBy(file: string): Set<'bare' | 'ui' | 'testing'> {
  const src = readFileSync(file, 'utf8');
  const used = new Set<'bare' | 'ui' | 'testing'>();
  // Matches both `from '<spec>'` and `import('<spec>')`, single or double quoted.
  for (const m of src.matchAll(/(?:from|import\s*\(|vi\.mock\s*\()\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec === '@civitai/blocks-react') used.add('bare');
    else if (spec === '@civitai/blocks-react/ui') used.add('ui');
    else if (spec === '@civitai/blocks-react/testing') used.add('testing');
  }
  return used;
}

function importersOf(entry: 'bare' | 'ui' | 'testing'): string[] {
  return sourceFiles()
    .filter((f) => entriesUsedBy(f).has(entry))
    .map(rel)
    .sort();
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f);

describe('the bridge-composition ledger', () => {
  /**
   * 🔴 THE PORT'S CENTRAL CLAIM. Every file still on the bare entry must be one of
   * exactly three kinds, and the ledger names which is which so a reader can check
   * the reasoning rather than trust the count.
   */
  it('names every importer of the BARE @civitai/blocks-react entry', () => {
    expect(importersOf('bare')).toEqual([
      // The port's OWN adapter — the single place the bridge transport is wrapped
      // for `initialize({ transport })`. This is the file whose existence makes
      // "one transport" true, so it is the last one that should ever leave.
      'lib/sdk-transport.ts',
      // Its unit test, which mocks the bare entry so the singleton is never reached.
      'lib/sdk-transport.test.ts',
      // The runtime module's test — its `resetTransport()`-following case reaches
      // the REAL bridge singleton on purpose, because that case's whole premise is
      // that `getTransport()` returns a DIFFERENT object after a reset.
      'lib/sdk-runtime.test.tsx',
      // The runtime module reads `getTransport()` to DERIVE the adapter's input.
      // It imports no binding from the bridge — see the `/ui`-liveness note in
      // `sdk-transport.ts` for why the singleton is the right input.
      'lib/sdk-runtime.ts',
      // Dev/test-only: allowlists `window.location.origin` before the mock host
      // speaks. Reached from `main.tsx` only inside its `VITE_DEV_HARNESS` branch,
      // via a dynamic import, so it is in no production bundle path.
      'dev-transport.ts',
    ].sort());
  });

  /**
   * 🔴 THE HALF THAT IS EASY TO GET WRONG IN THE REPORTING DIRECTION. A production
   * runtime file appearing here is the regression this whole ledger exists to
   * catch: it would mean a binding came back off the bridge while
   * `src/lib/sdk-runtime.ts` claimed to own all of them.
   *
   * `main.tsx` and `App.tsx` are the two that matter most — the production
   * entrypoint and the component that used to take fourteen hooks from the bridge.
   */
  it('has NO production runtime file on the bare entry', () => {
    const production = importersOf('bare').filter(
      (f) => !isTest(f) && f !== 'dev-transport.ts' && !f.startsWith('lib/sdk-'),
    );
    expect(
      production,
      'bridge-composition-guard: a production runtime file is taking bindings from ' +
        '`@civitai/blocks-react` again. The port moved all fifteen onto ' +
        '`src/lib/sdk-runtime.ts` over `@civitai/sdk`; adding one back here ' +
        'reintroduces the transport the adapter exists to keep singular.',
    ).toEqual([]);
    // The two named above, specifically — a spelled check on the general rule above
    // is walkable by a file the filter happens to exclude.
    expect(importersOf('bare')).not.toContain('main.tsx');
    expect(importersOf('bare')).not.toContain('App.tsx');
    expect(importersOf('bare')).not.toContain('ErrorBoundary.tsx');
  });

  /**
   * `/ui` is OUT OF SCOPE and deliberately unchanged — pinned so a later reader can
   * see the port did not quietly start migrating the pack, and so that when
   * starters#328 lands the diff is visible here.
   */
  it('leaves the /ui pack’s importers exactly as they were', () => {
    expect(importersOf('ui')).toEqual(
      ['App.tsx', 'GalleryPanel.tsx', 'ResourceBrowser.tsx', 'main.tsx'].sort(),
    );
  });

  /**
   * `/testing` legitimately stays: the mock host still answers groups 1 and 2. Two
   * of these three are test scaffolding; `main.tsx`'s is the dynamic, dev-only
   * harness import.
   */
  it('keeps the /testing mock host where it belongs', () => {
    expect(importersOf('testing')).toEqual(
      [
        'App.integration.test.tsx',
        'dev-transport.ts',
        'lib/sdk-runtime.test.tsx',
        'main.tsx',
        'test-setup.ts',
      ].sort(),
    );
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THIS FILE'S OWN INSTRUMENT. Every assertion above
   * is a claim about what `entriesUsedBy` FOUND, and a zero from a scanner wired to
   * nothing is indistinguishable from a zero that means something. So: prove the
   * classifier can separate the three entries on a file it is certain about, and
   * prove the anchoring works — an unanchored prefix match would classify a `/ui`
   * import as bare and every count above would be inflated.
   */
  it('[instrument] the classifier anchors on the full specifier, not a prefix', () => {
    // `main.tsx` imports `/ui` statically and `/testing` dynamically, and — after
    // the port — the bare entry NOT at all. All three facts in one file.
    const main = entriesUsedBy(join(SRC, 'main.tsx'));
    expect([...main].sort()).toEqual(['testing', 'ui']);

    // And the classifier is not vacuously empty: the adapter is bare-only.
    const adapter = entriesUsedBy(join(SRC, 'lib', 'sdk-transport.ts'));
    expect([...adapter]).toEqual(['bare']);

    // The scan reaches nested directories — `src/lib/*` would be invisible to a
    // non-recursive walk, and it is where the port's own modules live.
    expect(sourceFiles().map(rel)).toContain('lib/sdk-runtime.ts');
  });
});
