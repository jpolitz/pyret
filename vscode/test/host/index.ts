// Entry point for `vscode-test-web --extensionTestsPath`.
//
// This module runs INSIDE the (web) extension host, with the full `vscode` API
// available. It boots Mocha's browser build, pulls in every *.test.ts in this
// directory (bundled by webpack via require.context), and runs them. The final
// Promise resolves on success and rejects on any failure, which is what
// vscode-test-web uses to set the process exit code.

import 'mocha/mocha';

declare const mocha: any;

export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    mocha.setup({ ui: 'bdd', reporter: undefined, color: true, timeout: 240000 });

    // Bundle and register all test files in this directory.
    const context = (require as any).context('.', true, /\.test$/);
    context.keys().forEach(context);

    try {
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
