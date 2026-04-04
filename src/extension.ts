import * as vscode from "vscode";
import { EchoBridgeServer } from "./core/bridge";
import { getExtensionConfig } from "./core/config";
import { EchoLogger } from "./core/logger";
import { DataManager } from "./core/data-manager";
import { detectCurrentIde } from "./adapters/mcp-config";
import { EchoSidebarProvider } from "./webview/provider";
import { loadOrCreateToolName, rotateToolName } from "./utils/tool-name";
import { WindsurfPatchService } from "./adapters/windsurf-patch";

let statusBarItem: vscode.StatusBarItem | undefined;
let logger: EchoLogger | undefined;
let bridge: EchoBridgeServer | undefined;
let dataManager: DataManager | undefined;

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !bridge) {
    return;
  }
  const status = bridge.getStatus();
  statusBarItem.text = `$(comment) Quote ${status.running ? status.port : "offline"}`;
  statusBarItem.tooltip = `IDE: ${status.currentIde}\nTool: ${status.toolName}\nClients: ${status.sseClientCount}`;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  logger = new EchoLogger(context);
  const config = getExtensionConfig();
  const currentIde = detectCurrentIde();
  const toolName = await loadOrCreateToolName(context.globalStorageUri.fsPath);

  dataManager = DataManager.getInstance(context, logger);
  await dataManager.initialize();

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
    dataManager,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EchoSidebarProvider.viewId,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "quote.showStatus";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Disabled auto MCP config and rules writing - only account switching and quota stats
  // if (config.autoConfigureRules && vscode.workspace.isTrusted) {
  //   const sseUrl = `http://127.0.0.1:${runningPort}/sse`;
  //   const configuredPaths: string[] = [];

  //   const mcpPath = await writeMcpConfig(currentIde, toolName, sseUrl);
  //   configuredPaths.push(mcpPath);

  //   const ruleResults = await configureGlobalRules(toolName);
  //   configuredPaths.push(
  //     ...ruleResults
  //       .filter((result) => result.written)
  //       .map((result) => result.path),
  //   );
  //   bridge.setConfiguredPaths(configuredPaths);
  //   logger.info("Auto configuration completed.", { configuredPaths });

  //   void vscode.window
  //     .showInformationMessage(
  //       `AI Echo MCP 已配置 (${currentIde.name}) · 工具名: ${toolName}`,
  //       "查看配置",
  //     )
  //     .then((choice) => {
  //       if (choice === "查看配置") {
  //         void vscode.workspace
  //           .openTextDocument(vscode.Uri.file(currentIde.configPath))
  //           .then((doc) => vscode.window.showTextDocument(doc));
  //       }
  //     });
  // }

  context.subscriptions.push(
    vscode.commands.registerCommand("quote.openPanel", async () => {
      await vscode.commands.executeCommand(
        "workbench.view.extension.quote-sidebar",
      );
      sidebarProvider.reveal();
      sidebarProvider.postState();
    }),
    vscode.commands.registerCommand("quote.refresh", async () => {
      sidebarProvider.refresh();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage("Echo sidebar refreshed.");
    }),
    vscode.commands.registerCommand("quote.testFeedback", async () => {
      const message = await bridge?.injectTestFeedback();
      sidebarProvider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage(
        `Feedback test sent: ${message?.id ?? "n/a"}`,
      );
    }),
    vscode.commands.registerCommand("quote.showStatus", async () => {
      if (!bridge) {
        return;
      }
      const status = bridge.getStatus();
      await updateStatusBar();
      void vscode.window.showInformationMessage(
        `Echo bridge ${status.running ? "running" : "stopped"} · port ${status.port} · IDE ${status.currentIde}`,
      );
    }),
    vscode.commands.registerCommand("quote.copyPort", () => {
      if (!bridge) return;
      const port = bridge.getPort();
      void vscode.env.clipboard.writeText(String(port)).then(() => {
        void vscode.window.showInformationMessage(`端口 ${port} 已复制`);
      });
    }),
    vscode.commands.registerCommand("quote.rotateName", async () => {
      if (!bridge) return;
      const newName = await rotateToolName(context.globalStorageUri.fsPath);
      bridge.updateToolName(newName);
      await updateStatusBar();
      sidebarProvider.postBootstrap();
      void vscode.window.showInformationMessage(`工具名已旋转为: ${newName}`);
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void bridge?.stop();
      logger?.dispose();
    },
  });

  await updateStatusBar();

  // 首次激活时自动显示 Activity Bar 图标（Cursor 默认隐藏新插件贡献）
  const hasShownSidebar = context.globalState.get<boolean>(
    "hasShownSidebar",
    false,
  );
  if (!hasShownSidebar) {
    await context.globalState.update("hasShownSidebar", true);
    void vscode.commands.executeCommand(
      "workbench.view.extension.quote-sidebar",
    );
  }

  logger.info("Quote activated.", {
    currentIde: currentIde.name,
    requestedPort: config.serverPort,
    runningPort,
    autoConfigureRules: config.autoConfigureRules,
  });

  // ── 提前应用 Windsurf 补丁，避免切号时才触发重启 ────────────────────
  void ensurePatchApplied(logger);

  // ── 备用渠道：如果有 pending 切换则完成（兼容旧逻辑） ───────────────
  const pendingId = dataManager.windsurfAccounts.getPendingSwitchId();
  if (pendingId) {
    void completePendingSwitch(dataManager, sidebarProvider, logger, pendingId);
  }
}

async function ensurePatchApplied(log: EchoLogger): Promise<void> {
  try {
    const result = await WindsurfPatchService.checkAndApply(log);
    if (result.needsRestart) {
      log.info('Windsurf patch applied at activation, reloading window.');
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '切号功能初始化（仅首次），即将刷新...' },
        () => new Promise<void>(r => setTimeout(r, 1500))
      );
      setTimeout(() => {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 1800);
    }
  } catch (err) {
    log.warn('Patch check at activation failed (non-fatal).', { error: String(err) });
  }
}

async function waitForPatchedCommand(maxWaitMs = 30_000): Promise<boolean> {
  const PATCHED_CMD = "windsurf.provideAuthTokenToAuthProviderWithShit";
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const cmds = await vscode.commands.getCommands(true);
    if (cmds.includes(PATCHED_CMD)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function completePendingSwitch(
  dataManager: DataManager,
  provider: EchoSidebarProvider,
  log: EchoLogger,
  pendingId: string,
): Promise<void> {
  // 等待补丁命令注册就绪（最多 30 秒，每 2 秒检查一次）
  const ready = await waitForPatchedCommand(30_000);
  if (!ready) {
    await dataManager.windsurfAccounts.clearPendingSwitchId();
    vscode.window.showErrorMessage(
      "切换失败：Windsurf 补丁命令未加载，请手动重启后再次点击切换。",
    );
    log.warn(
      "Pending switch aborted: patched command not found after 30s wait.",
    );
    return;
  }

  log.info("Resuming pending switch after reload.", { pendingId });
  const result = await dataManager.windsurfAccounts.switchTo(pendingId);

  if (!result.success && result.needsRestart) {
    // 理论上不会再次触发 needsRestart（补丁刚写入），保底清除避免死循环
    await dataManager.windsurfAccounts.clearPendingSwitchId();
    vscode.window.showErrorMessage(
      "切换失败：补丁未生效，请手动重启 Windsurf 后再次点击切换。",
    );
    return;
  }

  // 清除 pending 标记
  await dataManager.windsurfAccounts.clearPendingSwitchId();

  if (result.success) {
    const account = dataManager.windsurfAccounts.getById(pendingId);
    const msg = `已切换到 ${account?.email ?? pendingId}`;
    provider.postBootstrap();
    vscode.window.setStatusBarMessage(`$(check) ${msg}`, 5000);
    void vscode.window.showInformationMessage(msg);
    log.info("Pending switch completed.", { pendingId });
  } else {
    log.warn("Pending switch failed.", { error: result.error });
    vscode.window.showErrorMessage(`切换失败: ${result.error ?? "未知错误"}`);
  }
}

export async function deactivate(): Promise<void> {
  dataManager?.endSession();
  DataManager.resetInstance();
  await bridge?.stop();
  logger?.dispose();
}
