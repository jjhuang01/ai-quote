import * as path from 'node:path';
import * as vscode from "vscode";
import { EchoBridgeServer } from "./core/bridge";
import { getExtensionConfig } from "./core/config";
import { EchoLogger } from "./core/logger";
import { HistoryManager } from "./core/history";
import { QueueManager } from "./core/queue";
import { AccountManager } from "./core/account";
import { FeedbackManager } from "./core/feedback";
import { detectCurrentIde, writeMcpConfig } from "./adapters/mcp-config";
import { configureGlobalRules } from "./adapters/rules";
import { EchoSidebarProvider } from "./webview/provider";
import { generateToolName } from "./utils/tool-name";

let statusBarItem: vscode.StatusBarItem | undefined;
let logger: EchoLogger | undefined;
let bridge: EchoBridgeServer | undefined;
let historyManager: HistoryManager | undefined;
let queueManager: QueueManager | undefined;
let accountManager: AccountManager | undefined;
let feedbackManager: FeedbackManager | undefined;

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !bridge) {
    return;
  }
  const status = bridge.getStatus();
  statusBarItem.text = `$(radio-tower) Echo ${status.running ? status.port : "offline"}`;
  statusBarItem.tooltip = `IDE: ${status.currentIde}\nTool: ${status.toolName}\nClients: ${status.sseClientCount}`;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger = new EchoLogger(context);
  const config = getExtensionConfig();
  const currentIde = detectCurrentIde();
  const toolName = generateToolName();

  // Initialize managers
  historyManager = new HistoryManager(context);
  await historyManager.initialize();
  
  queueManager = new QueueManager(logger);
  
  accountManager = new AccountManager(context, logger);
  await accountManager.initialize();
  
  feedbackManager = new FeedbackManager(context, logger);
  await feedbackManager.initialize();

  bridge = new EchoBridgeServer(
    logger,
    config.serverPort,
    toolName,
    currentIde.name,
  );
  const runningPort = await bridge.start();

  const sidebarProvider = new EchoSidebarProvider(
    context.extensionUri,
    bridge,
    logger,
    historyManager,
    queueManager,
    accountManager,
    feedbackManager,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EchoSidebarProvider.viewId,
      sidebarProvider,
    ),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "infiniteDialog.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  if (config.autoConfigureRules && vscode.workspace.isTrusted) {
    const sseUrl = `http://127.0.0.1:${runningPort}/sse`;
    const configuredPaths: string[] = [];

    const mcpPath = await writeMcpConfig(currentIde, toolName, sseUrl);
    configuredPaths.push(mcpPath);

    const ruleResults = await configureGlobalRules(toolName);
    configuredPaths.push(
      ...ruleResults
        .filter((result) => result.written)
        .map((result) => result.path),
    );
    bridge.setConfiguredPaths(configuredPaths);
    logger.info("Auto configuration completed.", { configuredPaths });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("infiniteDialog.openPanel", async () => {
      await vscode.commands.executeCommand(
        "workbench.view.extension.infinite-dialog-sidebar",
      );
      sidebarProvider.reveal();
      sidebarProvider.postState();
    }),
    vscode.commands.registerCommand("infiniteDialog.refresh", async () => {
      sidebarProvider.refresh();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage(
        "AI Echo rebuilt sidebar refreshed.",
      );
    }),
    vscode.commands.registerCommand("infiniteDialog.testFeedback", async () => {
      const message = await bridge?.injectTestFeedback();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage(
        `Feedback test sent: ${message?.id ?? "n/a"}`,
      );
    }),
    vscode.commands.registerCommand("infiniteDialog.showStatus", async () => {
      if (!bridge) {
        return;
      }
      const status = bridge.getStatus();
      await updateStatusBar();
      void vscode.window.showInformationMessage(
        `Echo bridge ${status.running ? "running" : "stopped"} · port ${status.port} · IDE ${status.currentIde}`,
      );
    }),
    vscode.commands.registerCommand("infiniteDialog.openLogs", async () => {
      const logPath = logger?.getLogFilePath();
      if (!logPath) {
        return;
      }
      // 打开日志目录
      const logDir = path.dirname(logPath);
      await vscode.commands.executeCommand(
        "revealFileInOS",
        vscode.Uri.file(logDir),
      );
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void bridge?.stop();
      logger?.dispose();
    },
  });

  await updateStatusBar();
  logger.info("AI Echo Rebuild activated.", {
    currentIde: currentIde.name,
    requestedPort: config.serverPort,
    runningPort,
    autoConfigureRules: config.autoConfigureRules,
  });
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
  logger?.dispose();
}
