import * as assert from 'assert';
import * as vscode from 'vscode';

// These tests run in the (web) extension host. They drive the extension exactly
// the way the editor "Run" button does — by invoking the `pyret-parley.run-file`
// command on an open .arr tab — and then use the WORKSPACE FILESYSTEM as the
// oracle: a Pyret program that writes a file lets us observe, without ever
// touching the webview DOM, whether file paths (and url-file imports) resolved
// the way we expect.
//
// The workspace is the mounted fixtures folder (test/fixtures/spell-checker):
//
//   ai/        plain.arr, starter-ok.arr, starter-bug.arr   <- the open "tabs"
//   libraries/ core.arr, lib-ok.arr, lib-bug.arr            <- the helper library
//
// url-file mode is "all-local" (see .vscode/settings.json), so imports resolve
// against the workspace filesystem with no network access.

const EXTENSION_ID = 'PyretProgrammingLanguage.pyret-parley';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function root(): vscode.Uri {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders && folders.length > 0, 'expected a workspace folder (run with --folderPath)');
  return folders![0].uri;
}

function fixture(...segments: string[]): vscode.Uri {
  return vscode.Uri.joinPath(root(), ...segments);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function tryDelete(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    /* fine if it isn't there */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Poll until `uri` exists with non-empty contents, or until `timeoutMs` elapses.
// Returns the decoded contents, or null on timeout.
async function awaitFileContents(uri: vscode.Uri, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 0) {
        return dec(bytes);
      }
    } catch {
      /* not written yet */
    }
    await sleep(500);
  }
  return null;
}

// Open an .arr file as a text editor (so it is the active text editor, which the
// run-file command keys off of) and trigger a run, exactly like the editor-tab
// Run button. The program runs in the REPL webview the command spins up.
async function runStarter(relPath: string): Promise<void> {
  const uri = fixture(relPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('pyret-parley.run-file');
}

describe('vscode url-file / working-directory resolution', function () {
  this.timeout(240000);

  before(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext!.activate();
  });

  it('resolves a relative output path against the open tab\'s directory', async () => {
    const out = fixture('ai', 'plain-out.txt');
    await tryDelete(out);

    await runStarter('ai/plain.arr');

    const contents = await awaitFileContents(out, 180000);
    assert.strictEqual(
      contents?.trim(),
      'hello-from-tab',
      'expected output-file("plain-out.txt") to be written next to the open tab (ai/)',
    );
    // And NOT at the workspace root, confirming "working dir" == tab dir.
    assert.strictEqual(await exists(fixture('plain-out.txt')), false,
      'output must not land at the workspace root');
  });

  it('runs the full starter -> library -> core chain (../libraries workaround)', async () => {
    const out = fixture('ai', 'result-ok.txt');
    await tryDelete(out);

    await runStarter('ai/starter-ok.arr');

    const contents = await awaitFileContents(out, 180000);
    assert.strictEqual(
      contents?.trim(),
      '42',
      'expected the value to flow starter -> Lib -> Core and be written to result-ok.txt',
    );
  });

  // The payoff of the fix: a library imports its sibling core.arr as just
  // "core.arr", and it resolves relative to the LIBRARY (libraries/core.arr),
  // not the open tab (ai/). Before the context-aware finder this failed; now the
  // value flows starter -> Lib -> Core and is written out.
  it('a library imports its sibling core.arr without ../ (module-relative)', async () => {
    const out = fixture('ai', 'result-bug.txt');
    await tryDelete(out);

    await runStarter('ai/starter-bug.arr');

    const contents = await awaitFileContents(out, 180000);
    assert.strictEqual(
      contents?.trim(),
      '42',
      'lib-bug.arr imports url-file(base, "core.arr"); it should resolve relative to ' +
        'the library (libraries/core.arr) via the context-aware finder',
    );
  });
});
