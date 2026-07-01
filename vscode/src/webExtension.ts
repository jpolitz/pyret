import * as vscode from 'vscode';
import { PyretCPOWebProvider, makeCommandHandler } from './pyretCPOWebEditor';

export function activate(context: vscode.ExtensionContext) {
    // Browser hover: mirrors the desktop LSP's `onHover`, but computed by a
    // companion `pyret.jarr -serve` reachable over a plain WebSocket. VS Code
    // for the Web runs the extension host in a Web Worker where the global
    // `WebSocket` is available, so no `ws` node module is needed. Register this
    // first so a failure in the CPO editor wiring can't prevent hover.
    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: 'pyret' }, new PyretHoverProvider()),
    );

    try {
        // Register our custom editor providers
        context.subscriptions.push(PyretCPOWebProvider.register(context));
        context.subscriptions.push(vscode.commands.registerCommand("pyret-parley.run-file", makeCommandHandler(context)));
    } catch (err) {
        console.error('pyret: CPO web editor registration failed: ' + err);
    }
}

// Minimal ambient shape for the Web Worker `WebSocket` global (tsconfig `lib`
// omits DOM/WebWorker, so we type just what we use rather than widen globals).
type WS = {
    onopen: (() => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onclose: (() => void) | null;
    send(data: string): void;
    close(): void;
};
declare const WebSocket: { new (url: string): WS };

interface HoverSuccess { type: 'hover-success'; name: string; ann: string | null; doc: string; }

class PyretHoverProvider implements vscode.HoverProvider {
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.Hover | null> {
        const cfg = vscode.workspace.getConfiguration('pyret-parley');
        const serverUrl = cfg.get<string>('hover.serverUrl', 'ws://localhost:5555');
        const diskRoot = cfg.get<string>('hover.diskRoot', '');
        const debug = cfg.get<boolean>('hover.debug', false);
        const note = (m: string) => { if (debug) void vscode.window.showInformationMessage('pyret-hover: ' + m); };

        // The Pyret server compiles a file by path from disk. Map the (possibly
        // virtual, e.g. vscode-test-web://) document URI onto a real path: when
        // `hover.diskRoot` is set, join it with the file's basename; otherwise
        // fall back to the URI's own fsPath.
        const segments = document.uri.path.split('/');
        const basename = segments[segments.length - 1];
        const program = diskRoot ? `${diskRoot.replace(/\/$/, '')}/${basename}` : document.uri.fsPath;

        // LSP positions are 0-indexed; Pyret srclocs are 1-indexed (matches the
        // desktop `server-node-tmp.ts` onHover handler).
        const line = position.line + 1;
        const col = position.character + 1;
        note(`fired uri=${document.uri.toString()} prog=${program} L${line} C${col}`);

        let result: HoverSuccess | null;
        try {
            result = await queryHover(serverUrl, program, line, col, token);
        } catch (err) {
            console.error(`pyret hover error: ${err}`);
            note(`error ${err}`);
            return null;
        }
        note(`result ${result ? result.name + ' :: ' + result.ann : 'null'}`);
        if (!result) return null;

        // Same rendering as the desktop LSP: a `pyret` code fence for the
        // signature, followed by the natural-language docstring.
        const parts: string[] = [];
        if (result.ann) {
            parts.push('```pyret\n' + result.name + ' :: ' + result.ann + '\n```');
        }
        if (result.doc) {
            parts.push(result.ann ? result.doc : `${result.name}: ${result.doc}`);
        }
        if (parts.length === 0) return null;

        const md = new vscode.MarkdownString(parts.join('\n\n'));
        return new vscode.Hover(md);
    }
}

function queryHover(
    serverUrl: string,
    program: string,
    line: number,
    col: number,
    token: vscode.CancellationToken,
): Promise<HoverSuccess | null> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(serverUrl);
        const timer = setTimeout(() => {
            if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } reject(new Error('hover query timed out')); }
        }, 30000);
        const settle = (value: HoverSuccess | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { ws.close(); } catch { /* ignore */ }
            resolve(value);
        };
        token.onCancellationRequested(() => settle(null));

        ws.onopen = () => {
            ws.send(JSON.stringify({
                command: 'query',
                query: 'hover',
                compileOptions: JSON.stringify({ program, 'base-dir': '.' }),
                queryOptions: JSON.stringify({ line, col }),
            }));
        };
        ws.onmessage = (ev: { data: unknown }) => {
            let msg: { [k: string]: unknown };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.type === 'echo-err' || msg.type === 'echo-log') {
                return; // server progress chatter; keep waiting for the real reply
            }
            if (msg.type === 'hover-success') {
                settle({
                    type: 'hover-success',
                    name: String(msg.name ?? ''),
                    ann: msg.ann == null ? null : String(msg.ann),
                    doc: String(msg.doc ?? ''),
                });
            } else {
                settle(null); // hover-failure or anything else
            }
        };
        ws.onerror = (e: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error('websocket error')); } };
        ws.onclose = () => settle(null);
    });
}
