/*
  Ported from: src/arr/compiler/locators/url.arr

  Network fetch: the original uses the `fetch` trove (src/js/trove/fetch.js),
  which is an async cross-fetch with a 20s AbortSignal timeout, resumed onto
  the Pyret stack. Locator methods here are synchronous and we have no Pyret
  stack to pause, so `fetch` shells out to a child node process
  (`node -e <script> <url>`) that performs the same global-fetch call with
  the same timeout and reports {ok, value} as JSON on stdout. The left/right
  payloads and error message strings mirror fetch.js exactly.
*/

import * as P from 'path';
import { execFileSync } from 'child_process';
import * as PP from '../parse-pyret';
import * as CL from '../compile-lib';
import * as CS from '../compile-structs';
import { Either, left, right, raise } from '../shared';

const FETCH_TIMEOUT = 20000;

const FETCH_SCRIPT = `
const url = process.argv[1];
const FETCH_TIMEOUT = ${FETCH_TIMEOUT};
(async () => {
  try {
    const result = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (result.ok) {
      const text = await result.text();
      process.stdout.write(JSON.stringify({ ok: true, value: text }));
    } else {
      const err = result.statusText;
      const message = \`Fetching \${url} failed with status \${result.status}: \${err}\`;
      process.stdout.write(JSON.stringify({ ok: false, value: message }));
    }
  } catch (e) {
    const message = String(e);
    const error = \`Fetch of \${url} failed with an error. This may mean that the server you're fetching from does not support fetch requests from the browser, the URL has a formatting issue, or the request took longer than \${FETCH_TIMEOUT}ms. The system-level error was "\${message}"\`;
    process.stdout.write(JSON.stringify({ ok: false, value: error }));
  }
})();
`;

// left(text) on success, right(message) on failure, like F.fetch.
export function fetch(url: string): Either<string, string> {
  let out: string;
  try {
    out = execFileSync(process.execPath, ['-e', FETCH_SCRIPT, url], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    });
    const parsed = JSON.parse(out);
    return parsed.ok ? left(parsed.value) : right(parsed.value);
  } catch (e) {
    const message = String(e);
    return right(`Fetch of ${url} failed with an error. This may mean that the server you're fetching from does not support fetch requests from the browser, the URL has a formatting issue, or the request took longer than ${FETCH_TIMEOUT}ms. The system-level error was "${message}"`);
  }
}

export type UrlLocator = CL.Locator & { url: string; globals: CS.Globals };

export function mockableUrlLocator(fetcher: { fetch(url: string): Either<string, string> }): (url: string, globals: CS.Globals) => UrlLocator {
  return (url: string, globals: CS.Globals): UrlLocator => {
    let ast: CL.PyretCode | undefined = undefined;
    return {
      url: url,
      globals: globals,
      getUncached(): CL.Locator | undefined { return undefined; },
      getModifiedTime(): number { return Date.now(); },
      getOptions(options: CS.CompileOptions): CS.CompileOptions { return options; },
      getModule(this: any): CL.PyretCode {
        if (ast === undefined) {
          const result = fetcher.fetch(this.url);
          if (result.$name === 'left') {
            ast = new CL.PyretAst(PP.surfaceParse(result.v, this.url));
          } else {
            raise("Error fetching " + this.url + ": " + result.v);
          }
        }
        return ast!;
      },
      getDependencies(this: any): CS.AnyDependency[] {
        return CL.getStandardDependencies(this.getModule(), this.uri());
      },
      getNativeModules(): CS.NativeModule[] { return []; },
      getExtraImports(): CS.ExtraImports { return CS.standardImports; },
      getGlobals(this: any): CS.Globals { return this.globals; },
      setCompiled(_loadable: CS.Loadable, _provides: Map<string, CS.Provides>): void {
        ast = undefined;
      },
      needsCompile(_provides: Map<string, CS.Provides>): boolean { return true; },
      getCompiled(): CS.Loadable | undefined { return undefined; },
      uri(this: any): string { return this.url; },
      name(this: any): string { return P.basename(this.url, ""); }
    };
  };
}

export const urlLocator = mockableUrlLocator({ fetch: fetch });
