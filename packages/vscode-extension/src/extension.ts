/**
 * thtml VS Code Extension — entry point.
 *
 * Activates on `.thtml` files and:
 *   1. Spawns the thtml Language Server as a child process.
 *   2. Connects to it via the `vscode-languageclient` LanguageClient.
 *   3. Registers commands for restarting the server, showing output,
 *      and previewing templates.
 */

import * as path from "path";
import {
  ExtensionContext,
  OutputChannel,
  commands,
  window,
  workspace,
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let client: LanguageClient | undefined;
let outputChannel: OutputChannel | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: ExtensionContext): Promise<void> {
  outputChannel = window.createOutputChannel("thtml");
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine("thtml extension activating...");

  const config = workspace.getConfiguration("thtml");
  const lsEnabled = config.get<boolean>("languageServer.enabled", true);

  if (lsEnabled) {
    await startLanguageServer(context);
  } else {
    outputChannel.appendLine(
      "thtml language server disabled via thtml.languageServer.enabled."
    );
  }

  // --- Commands ---

  context.subscriptions.push(
    commands.registerCommand("thtml.restart", async () => {
      outputChannel?.appendLine("Restarting thtml language server...");
      await stopLanguageServer();
      await startLanguageServer(context);
      outputChannel?.appendLine("thtml language server restarted.");
    }),

    commands.registerCommand("thtml.showOutput", () => {
      outputChannel?.show(true);
    }),

    commands.registerCommand("thtml.previewTemplate", () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== "thtml") {
        void window.showWarningMessage("Open a .thtml file to preview it.");
        return;
      }
      // TODO: open a WebviewPanel that renders the template with a mock context
      void window.showInformationMessage("thtml: Preview coming soon!");
    })
  );

  outputChannel.appendLine("thtml extension activated.");
}

// ---------------------------------------------------------------------------
// Deactivation
// ---------------------------------------------------------------------------

export async function deactivate(): Promise<void> {
  await stopLanguageServer();
}

// ---------------------------------------------------------------------------
// Language server lifecycle
// ---------------------------------------------------------------------------

async function startLanguageServer(context: ExtensionContext): Promise<void> {
  // Resolve path to the compiled language server entry point.
  // When installed via the marketplace the server is bundled inside the
  // extension under node_modules. During development it lives in the sibling
  // package's dist directory.
  const serverModule = context.asAbsolutePath(
    path.join("node_modules", "@thtml", "language-server", "dist", "server.js")
  );

  const config = workspace.getConfiguration("thtml");
  const traceLevel = config.get<string>("languageServer.trace", "off");

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ["--nolazy", "--inspect=6009"],
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    // Activate for .thtml files only (both saved and unsaved buffers).
    documentSelector: [
      { scheme: "file", language: "thtml" },
      { scheme: "untitled", language: "thtml" },
    ],
    synchronize: {
      configurationSection: "thtml",
      fileEvents: workspace.createFileSystemWatcher("**/*.thtml"),
    },
    outputChannel,
    traceOutputChannel: outputChannel,
    middleware: {
      // Reserved for future middleware hooks.
    },
  };

  client = new LanguageClient(
    "thtml-language-server",
    "thtml Language Server",
    serverOptions,
    clientOptions
  );

  if (traceLevel !== "off") {
    void client.setTrace(traceLevel as "messages" | "verbose");
  }

  await client.start();

  outputChannel?.appendLine(
    `thtml language server started (module: ${serverModule})`
  );
}

async function stopLanguageServer(): Promise<void> {
  if (client !== undefined) {
    try {
      await client.stop();
    } finally {
      client = undefined;
    }
  }
}
