import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectCurrentIde, removeMcpConfigEntries } from "./adapters/mcp-config";
import { handleAutoContinueDialog } from "./core/auto-continue";
import { BlockedTrajectoriesManager } from "./core/blocked-trajectories-manager";
import type { DialogCallback } from "./core/bridge";
import { QuoteBridge } from "./core/bridge";
import { getExtensionConfig, isSwitchWarmupEnabled } from "./core/config";
import type { BlockedTrajectory, CascadeHookRequest, WindsurfAccount } from "./core/contracts";
import { DataManager } from "./core/data-manager";
import { getGlobalMetrics } from "./core/hook-metrics";
import { InstanceManager } from "./core/instance-manager";
import { QuoteLogger } from "./core/logger";
import { QuotaBlockDetector } from "./core/quota-block-detector";
import { QuotaPoller } from "./core/quota-poller";
import { WindsurfHooksManager } from "./core/windsurf-hooks";
import { loadOrCreateToolName, rotateToolName } from "./utils/tool-name";
import { QuoteDialogPanel } from "./webview/dialog-panel";
import { QuoteSidebarProvider } from "./webview/provider";
// windsurf-patch 仅供 provider.ts 调试面板查询状态，此文件不再需要

let statusBarItem: vscode.StatusBarItem | undefined;
let logger: QuoteLogger | undefined;
let bridge: QuoteBridge | undefined;
let dataManager: DataManager | undefined;
let activeToolName: string | undefined;
let secondaryInstance = false;
let extensionContext: vscode.ExtensionContext | undefined;
let sidebarProvider: QuoteSidebarProvider | undefined;
let blockedTrajectoriesManager: BlockedTrajectoriesManager | undefined;
const OWNED_MCP_NAMES_KEY = 'ownedMcpNames';
const LEGACY_EXTENSION_ID = 'opensource.ai-quote';

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyGlobalStorage(context: vscode.ExtensionContext): Promise<void> {
  const currentStorage = context.globalStorageUri.fsPath;
  const parent = path.dirname(currentStorage);
  const legacyStorage = path.join(parent, LEGACY_EXTENSION_ID);
  if (legacyStorage === currentStorage) return;
  if (!(await pathExists(legacyStorage))) return;
  await fs.mkdir(currentStorage, { recursive: true });
  const names = await fs.readdir(legacyStorage);
  for (const name of names) {
    const source = path.join(legacyStorage, name);
    const target = path.join(currentStorage, name);
    if (await pathExists(target)) continue;
    await fs.cp(source, target, { recursive: true, errorOnExist: false });
  }
}

function sanitizeAccount(account: WindsurfAccount): Omit<WindsurfAccount, "password"> & { password: string } {
  return {
    ...account,
    password: account.password ? "***" : "",
  };
}

function getOwnedMcpNames(context: vscode.ExtensionContext): string[] {
  const value = context.globalState.get<string[]>(OWNED_MCP_NAMES_KEY, []);
  return Array.isArray(value) ? value.filter((name) => typeof name === 'string' && name.length > 0) : [];
}

async function rememberOwnedMcpName(context: vscode.ExtensionContext, name: string): Promise<void> {
  const owned = new Set(getOwnedMcpNames(context));
  owned.add(name);
  await context.globalState.update(OWNED_MCP_NAMES_KEY, [...owned]);
}

async function refreshQuotaAfterSwitch(accountId: string, reason: string): Promise<void> {
  if (!dataManager) {
    return;
  }
  if (!isSwitchWarmupEnabled()) {
    return;
  }
  try {
    const quotaResult = await dataManager.windsurfAccounts.fetchRealQuota(accountId, {
      mode: "switch-warmup",
    });
    if (!quotaResult.success) {
      logger?.warn("Fetch quota after account switch failed.", {
        accountId,
        reason,
        error: quotaResult.error,
      });
    }
  } catch (error) {
    logger?.warn("Fetch quota after account switch threw.", {
      accountId,
      reason,
      error: String(error),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTranscriptTailWithRetry(transcriptPath: string, attempts = 6, delayMs = 250): Promise<string> {
  let lastText = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const transcriptContent = await fs.readFile(transcriptPath, 'utf-8');
      const lines = transcriptContent.trim().split('\n').filter(Boolean);
      lastText = lines.slice(-20).join('\n');
      if (lastText.length > 0 && QuotaBlockDetector.detect(lastText).type !== 'none') {
        return lastText;
      }
    } catch {
      lastText = "";
    }
    await sleep(delayMs);
  }
  return lastText;
}

async function triggerCascadeContinue(trajectoryId?: string): Promise<{ success: boolean; command?: string; error?: string }> {
  const commands = await vscode.commands.getCommands(true);
  const commandSet = new Set(commands);
  const noArgCandidates = [
    'windsurf.continue',
    'windsurf.resume',
    'windsurf.retry',
    'windsurf.continueCascade',
    'windsurf.resumeCascade',
    'windsurf.retryCascade',
  ];
  const textCandidates = [
    'windsurf.sendTextToChat',
    'windsurf.sendTextToCascade',
  ];

  for (const command of noArgCandidates) {
    if (!commandSet.has(command)) {
      continue;
    }
    try {
      await vscode.commands.executeCommand(command);
      return { success: true, command };
    } catch (error) {
      return { success: false, command, error: String(error) };
    }
  }

  for (const command of textCandidates) {
    if (!commandSet.has(command)) {
      continue;
    }
    try {
      await vscode.commands.executeCommand(command, 'Continue');
      return { success: true, command };
    } catch (error) {
      return { success: false, command, error: String(error) };
    }
  }

  return {
    success: false,
    error: `No Cascade continue command found for trajectory ${trajectoryId ?? 'unknown'}`,
  };
}

async function wakeBlockedTrajectoryAfterSwitch(trajectoryId?: string): Promise<void> {
  if (!trajectoryId || !blockedTrajectoriesManager) {
    return;
  }
  blockedTrajectoriesManager.updateWakeStatus(trajectoryId, 'waking');
  const result = await triggerCascadeContinue(trajectoryId);
  if (result.success) {
    blockedTrajectoriesManager.updateWakeStatus(trajectoryId, 'woken');
    logger?.info('[Cascade Hook] Continue triggered after account switch', {
      trajectoryId,
      command: result.command,
    });
  } else {
    blockedTrajectoriesManager.updateWakeStatus(trajectoryId, 'failed', result.error);
    logger?.warn('[Cascade Hook] Continue trigger failed after account switch', {
      trajectoryId,
      command: result.command,
      error: result.error,
    });
  }
}

/**
 * Handle Cascade Hook events for quota/rate limit detection
 */
async function handleCascadeHook(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const metrics = getGlobalMetrics();
  const startTime = Date.now();
  
  try {
    metrics.recordCall();
    
    const hookRequest = request as unknown as CascadeHookRequest;
    const { agent_action_name, tool_info } = hookRequest;

    logger?.info('[Cascade Hook] Received', {
      agent_action_name,
      hasResponse: !!tool_info.response,
      hasTranscript: !!tool_info.transcript_path,
      timestamp: new Date().toISOString(),
    });

    let textToAnalyze = tool_info.response ?? '';
    const transcriptPath = tool_info.transcript_path;
    const trajectoryId = QuotaBlockDetector.extractTrajectoryId(transcriptPath);

    if (!textToAnalyze && transcriptPath) {
      textToAnalyze = await readTranscriptTailWithRetry(transcriptPath);
      logger?.debug('[Cascade Hook] Read transcript for error text', {
        trajectoryId,
        sampleLength: textToAnalyze.length,
      });
    }

    logger?.debug('[Cascade Hook] Extracted data', {
      trajectoryId,
      textLength: textToAnalyze.length,
      transcriptPath,
    });

    // Detect quota block
    const detection = QuotaBlockDetector.detect(textToAnalyze);

    logger?.info('[Cascade Hook] Detection result', {
      trajectoryId,
      detectionType: detection.type,
      matchedText: detection.matchedText,
      resetAt: detection.resetAt,
      retryDelayMs: detection.retryDelayMs,
      textSample: textToAnalyze.slice(0, 200),
    });

    if (detection.type === 'quota_exhausted') {
      metrics.recordDetection('quota_exhausted');
      metrics.recordAutoSwitchTrigger();
      
      logger?.warn('[Cascade Hook] Quota exhausted detected', {
        trajectoryId,
        matchedText: detection.matchedText,
        resetAt: detection.resetAt,
        detection,
      });

      // Mark trajectory as blocked
      if (trajectoryId && blockedTrajectoriesManager) {
        const currentAccount = dataManager?.windsurfAccounts.getCurrentAccount();
        const currentAccountId = currentAccount?.id;
        const blocked: BlockedTrajectory = {
          trajectoryId,
          transcriptPath,
          blockerType: detection.type,
          resetAt: detection.resetAt,
          accountIdAtBlock: currentAccountId,
          detectedAt: new Date().toISOString(),
          wakeStatus: 'pending',
        };
        blockedTrajectoriesManager.add(blocked);
        metrics.recordTrajectoryBlockAdded();
        
        logger?.info('[Cascade Hook] Trajectory marked as blocked', {
          trajectoryId,
          accountIdAtBlock: currentAccountId,
          blockedCount: blockedTrajectoriesManager.count(),
        });
      }

      // Trigger auto switch
      if (dataManager) {
        const oldAccountId = dataManager.windsurfAccounts.getCurrentAccount()?.id;
        logger?.info('[Cascade Hook] Attempting auto switch', {
          trigger: 'quota_exhausted',
          currentAccountId: oldAccountId,
        });
        
        const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded({ forceCurrentExhausted: true });
        
        if (switched) {
          metrics.recordAutoSwitchSuccess();
          const newAccountId = dataManager.windsurfAccounts.getCurrentAccount()?.id;
          await wakeBlockedTrajectoryAfterSwitch(trajectoryId);
          logger?.info('[Cascade Hook] Auto switch successful', {
            oldAccountId,
            newAccountId,
            blockedTrajectories: blockedTrajectoriesManager?.count(),
          });
        } else {
          metrics.recordAutoSwitchFailure();
          logger?.warn('[Cascade Hook] Auto switch failed', {
            reason: 'no suitable account or switch failed',
            accountCount: dataManager.windsurfAccounts.getAll().length,
          });
        }
      }
    } else if (detection.type === 'rate_limited_long') {
      metrics.recordDetection('rate_limited_long');
      metrics.recordAutoSwitchTrigger();
      
      logger?.warn('[Cascade Hook] Long rate limit detected, treating as quota block', {
        trajectoryId,
        matchedText: detection.matchedText,
        resetAt: detection.resetAt,
        detection,
      });

      // Similar to quota exhausted, mark as blocked and trigger switch
      if (trajectoryId && blockedTrajectoriesManager) {
        const currentAccount = dataManager?.windsurfAccounts.getCurrentAccount();
        const currentAccountId = currentAccount?.id;
        const blocked: BlockedTrajectory = {
          trajectoryId,
          transcriptPath,
          blockerType: detection.type,
          resetAt: detection.resetAt,
          accountIdAtBlock: currentAccountId,
          detectedAt: new Date().toISOString(),
          wakeStatus: 'pending',
        };
        blockedTrajectoriesManager.add(blocked);
        metrics.recordTrajectoryBlockAdded();
        
        logger?.info('[Cascade Hook] Trajectory marked as blocked (long rate limit)', {
          trajectoryId,
          accountIdAtBlock: currentAccountId,
        });
      }

      if (dataManager) {
        const oldAccountId = dataManager.windsurfAccounts.getCurrentAccount()?.id;
        logger?.info('[Cascade Hook] Attempting auto switch (long rate limit)', {
          trigger: 'rate_limited_long',
          currentAccountId: oldAccountId,
        });
        
        const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded({ forceCurrentExhausted: true });
        
        if (switched) {
          metrics.recordAutoSwitchSuccess();
          await wakeBlockedTrajectoryAfterSwitch(trajectoryId);
          logger?.info('[Cascade Hook] Auto switch successful (long rate limit)', {
            oldAccountId,
            newAccountId: dataManager.windsurfAccounts.getCurrentAccount()?.id,
          });
        } else {
          metrics.recordAutoSwitchFailure();
          logger?.warn('[Cascade Hook] Auto switch failed (long rate limit)');
        }
      }
    } else if (detection.type === 'rate_limited_short') {
      metrics.recordDetection('rate_limited_short');
      
      logger?.info('[Cascade Hook] Short rate limit detected, will retry', {
        trajectoryId,
        matchedText: detection.matchedText,
        retryDelayMs: detection.retryDelayMs,
        detection,
      });
      // For short rate limits, we don't switch account, just let it retry
    }

    const duration = Date.now() - startTime;
    logger?.info('[Cascade Hook] Completed', {
      trajectoryId,
      detectionType: detection.type,
      durationMs: duration,
    });

    return {
      success: true,
      detection,
      trajectoryId,
      durationMs: duration,
    };
  } catch (error) {
    metrics.recordError();
    const duration = Date.now() - startTime;
    logger?.error('[Cascade Hook] Failed', {
      error: String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
      durationMs: duration,
      requestKeys: Object.keys(request),
    });
    
    return {
      success: false,
      error: String(error),
      durationMs: duration,
    };
  }
}

async function updateStatusBar(): Promise<void> {
  if (!statusBarItem || !bridge) {
    return;
  }
  const status = bridge.getStatus();
  const waitingIcon = status.activeDialog ? '$(pause-circle) ' : '';
  const onlineText = status.running ? '运行中' : '离线';
  statusBarItem.text = `${waitingIcon}$(comment) Windsurf Quote`;
  const queuedText = status.queuedDialogCount > 0 ? `  \n队列中: ${status.queuedDialogCount}` : '';
  const toolTipMd = new vscode.MarkdownString(
    `**Windsurf Quote 已激活 (${onlineText})**  \n` +
    `工具名: \`${status.toolName}\`  \n` +
    `IDE: ${status.currentIde}  \n` +
    `SSE 客户端: ${status.sseClientCount}` +
    (status.activeDialog ? '  \n⏸ **LLM 等待响应...**' : '') +
    queuedText
  );
  toolTipMd.isTrusted = true;
  statusBarItem.tooltip = toolTipMd;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  extensionContext = context;
  logger = new QuoteLogger(context);
  await migrateLegacyGlobalStorage(context);
  const config = getExtensionConfig();
  const currentIde = detectCurrentIde();
  let toolName = await loadOrCreateToolName(context.globalStorageUri.fsPath);
  await rememberOwnedMcpName(context, toolName);

  dataManager = DataManager.getInstance(context, logger);
  await dataManager.initialize();
  context.subscriptions.push({
    dispose: () => dataManager?.dispose(),
  });

  bridge = new QuoteBridge(
    logger,
    config.serverPort,
    toolName,
    currentIde.name,
    config.dialogTimeoutSeconds > 0 ? config.dialogTimeoutSeconds * 1000 : 0,
  );
  const runningPort = await bridge.start();
  bridge.registerAutopilotHandlers({
    getAccounts: async () => {
      const accounts = dataManager?.windsurfAccounts.getAll().map(sanitizeAccount) ?? [];
      return { success: true, accounts };
    },
    getQuota: async () => {
      const currentId = await dataManager?.windsurfAccounts.getDisplayCurrentAccountId();
      const accounts = dataManager?.windsurfAccounts.getAll() ?? [];
      const current = currentId ? accounts.find((account) => account.id === currentId) : undefined;
      return {
        success: true,
        current: current ? sanitizeAccount(current) : undefined,
        all: accounts.map(sanitizeAccount),
        snapshots: dataManager?.windsurfAccounts.getQuotaSnapshots() ?? [],
      };
    },
    switchAccount: async (accountId: string) => {
      if (!dataManager) {
        return { success: false, message: "DataManager unavailable" };
      }
      const result = await dataManager.windsurfAccounts.switchTo(accountId);
      if (result.success) {
        await refreshQuotaAfterSwitch(accountId, "autopilot.switchAccount");
        provider.postBootstrap();
      }
      const account = dataManager.windsurfAccounts.getById(accountId);
      return {
        success: result.success,
        switchedTo: account ? sanitizeAccount(account) : undefined,
        message: result.success ? `Switched to ${account?.email ?? accountId}` : result.error ?? "Switch failed",
      };
    },
    switchNext: async () => {
      if (!dataManager) {
        return { success: false, message: "DataManager unavailable" };
      }
      const beforeId = await dataManager.windsurfAccounts.getDisplayCurrentAccountId();
      const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded();
      const afterId = await dataManager.windsurfAccounts.getDisplayCurrentAccountId();
      if (switched && afterId) {
        await refreshQuotaAfterSwitch(afterId, "autopilot.switchNext");
      }
      provider.postBootstrap();
      return {
        success: switched,
        switchedTo: afterId && afterId !== beforeId ? sanitizeAccount(dataManager.windsurfAccounts.getById(afterId)!) : undefined,
        previousAccountId: beforeId,
        currentAccountId: afterId,
        message: switched ? "Auto switch completed" : "No switch performed",
      };
    },
    refreshQuotas: async () => {
      if (!dataManager) {
        return { success: 0, failed: 1, errors: ["DataManager unavailable"] };
      }
      const currentId = await dataManager.windsurfAccounts.getDisplayCurrentAccountId();
      if (!currentId) {
        return { success: 0, failed: 1, errors: ["No current account"] };
      }
      const single = await dataManager.windsurfAccounts.fetchRealQuota(currentId);
      provider.postBootstrap();
      return single.success
        ? { success: 1, failed: 0, errors: [] }
        : { success: 0, failed: 1, errors: [single.error ?? "Unknown quota refresh error"] };
    },
  });

  // Initialize blocked trajectories manager
  blockedTrajectoriesManager = new BlockedTrajectoriesManager();

  // Register cascade hook handler
  bridge.registerCascadeHookHandler(handleCascadeHook);

  // Auto-inject Windsurf hooks on startup
  try {
    const hookResult = await WindsurfHooksManager.injectHook(runningPort, logger);
    logger?.info('Windsurf hook injection result', hookResult);
    if (hookResult.success && hookResult.message === 'Hook injected successfully') {
      void vscode.window.showInformationMessage(
        `Windsurf Hook 已注入，路径: ${WindsurfHooksManager.getHooksFilePath()}`
      );
    } else if (!hookResult.success) {
      void vscode.window.showWarningMessage(`Windsurf Hook 注入失败: ${hookResult.message}`);
    }
  } catch (error) {
    logger?.error('Failed to auto-inject Windsurf hook', { error: String(error) });
  }

  // Multi-window isolation: if port fell back, another instance owns the primary toolName.
  // Generate a session-scoped toolName so each window keeps an independent MCP entry.
  secondaryInstance = runningPort !== config.serverPort;
  if (secondaryInstance) {
    const { generateToolName } = await import('./utils/tool-name');
    toolName = generateToolName();
    bridge.updateToolName(toolName);
    await rememberOwnedMcpName(context, toolName);
    logger.info('Secondary instance detected — using session-scoped toolName.', {
      primaryPort: config.serverPort,
      runningPort,
      toolName,
    });
  }
  activeToolName = toolName;

  const provider = new QuoteSidebarProvider(
    context.extensionUri,
    bridge,
    logger,
    dataManager,
    context,
  );
  sidebarProvider = provider;

  const rotateMcpName = async (): Promise<{ newName: string }> => {
    if (!bridge) {
      throw new Error('Bridge 未初始化');
    }
    const newName = await rotateToolName(context.globalStorageUri.fsPath);
    toolName = newName;
    bridge.updateToolName(newName);
    activeToolName = newName;
    await rememberOwnedMcpName(context, newName);
    // MCP and rules configuration disabled as per project requirements
    logger?.info('Rotation completed (MCP and rules side effects disabled).', { newName });
    return { newName };
  };
  provider.setRotateMcpNameCallback(rotateMcpName);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      QuoteSidebarProvider.viewId,
      provider,
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

  // Auto MCP config and rules writing — DISABLED
  const configuredPaths: string[] = [];
  // MCP and rules configuration disabled as per project requirements
  const rawConfig = vscode.workspace.getConfiguration('quote');
  logger.info('Auto configuration disabled.', {
    userConfiguredMcp: rawConfig.get<boolean>('autoConfigureMcp', false),
    userConfiguredRules: rawConfig.get<boolean>('autoConfigureRules', false),
  });
  bridge.setConfiguredPaths(configuredPaths);

  // Register MCP dialog callback: open QuoteDialogPanel (editor tab) on LLM call
  const dialogHandler: DialogCallback = (req) => {
    void (async () => {
      if (statusBarItem) {
        statusBarItem.text = `$(pause-circle) $(comment) Windsurf Quote`;
        statusBarItem.tooltip = '⏸ LLM 等待用户响应...';
      }

      try {
        const quotaAutoContinueEnabled =
          dataManager?.settings.get().quotaAutoContinueEnabled ?? false;
        if (quotaAutoContinueEnabled) {
          const autoContinue = await handleAutoContinueDialog(req, {
            refreshCurrentQuotaBeforeSwitch: async () => {
              const currentId = await dataManager?.windsurfAccounts.getDisplayCurrentAccountId();
              if (!currentId) {
                return { success: false, error: "No current account" };
              }
              // 多窗口场景下 save() 可能因版本冲突抛出；配额刷新是尽力而为，不阻塞切换
              try {
                return await dataManager?.windsurfAccounts.fetchRealQuota(
                  currentId,
                  { mode: "auto" },
                ) ?? { success: false, error: "DataManager unavailable" };
              } catch {
                return { success: true };
              }
            },
            // 对话框出现 = 当前账号已确认耗尽，跳过本地计数器的不可靠判断
            autoSwitchIfNeeded: async () => dataManager?.windsurfAccounts.autoSwitchIfNeeded({ forceCurrentExhausted: true }) ?? false,
            getCurrentAccountId: async () => dataManager?.windsurfAccounts.getDisplayCurrentAccountId(),
            refreshQuotaAfterSwitch,
            resolveDialog: (sessionId, response) => bridge?.resolvePendingDialog(sessionId, response),
          });
          if (autoContinue.handled) {
            logger?.info('Auto-continued exhausted dialog.', {
              sessionId: req.sessionId,
              switched: autoContinue.switched,
              accountId: autoContinue.accountId,
              reply: autoContinue.reply,
            });
            provider.postBootstrap();
            void updateStatusBar();
            return;
          }
        }
      } catch (error) {
        logger?.warn('Auto-continue failed, falling back to manual dialog.', {
          sessionId: req.sessionId,
          error: String(error),
        });
      }

      // ── Queue auto-reply: if queue has content, consume first item automatically ──
      const queueItems = provider.getQueueItems();
      if (queueItems.length > 0) {
        const autoReply = queueItems[0];
        provider.replaceQueue(queueItems.slice(1));
        bridge?.resolvePendingDialog(req.sessionId, autoReply);
        logger?.info('Auto-replied from queue.', {
          sessionId: req.sessionId,
          responseLen: autoReply.length,
          queueRemaining: queueItems.length - 1,
        });
        void updateStatusBar();
        provider.postState();
        QuoteDialogPanel.syncQueueItems(provider.getQueueItems());
        return;
      }

      // ── No queue items — show dialog panel and wait for user input ──
      // Notify sidebar for status display
      provider.postPendingDialog(req);
      try {
        const settings = dataManager!.settings.get();
        // Load recent conversation history for display in dialog panel
        const recentHistory = dataManager!.history.getByType('conversation').slice(0, 20);
        QuoteDialogPanel.show(context.extensionUri, req, (sessionId, response, images) => {
          bridge?.resolvePendingDialog(sessionId, response, images);
          // Save this exchange to history
          void dataManager!.history.add({
            type: 'conversation',
            title: req.summary.slice(0, 80),
            content: JSON.stringify({ summary: req.summary, response, sessionId }),
          });
          void updateStatusBar();
          provider.postState();
        }, {
          enterToSend: settings.enterToSend,
          queueCount: provider.getQueueCount(),
          queueItems: provider.getQueueItems(),
          soundAlert: settings.soundAlert ?? 'none',
          recentHistory: recentHistory.map(h => {
            try {
              const data = JSON.parse(h.content) as { summary: string; response: string };
              return { summary: data.summary, response: data.response, time: h.createdAt };
            } catch { return null; }
          }).filter((h): h is { summary: string; response: string; time: string } => h !== null),
          onQueueAdd: (items) => {
            provider.addToQueue(items);
            QuoteDialogPanel.syncQueueItems(provider.getQueueItems());
          },
          onQueueReplace: (items) => {
            provider.replaceQueue(items);
            QuoteDialogPanel.syncQueueItems(provider.getQueueItems());
          }
        });
      } catch (err) {
        logger?.error('Failed to open QuoteDialogPanel.', { error: String(err) });
        // Sidebar dialog card is the fallback — user can still respond from there
      }
    })();
  };
  bridge.registerDialogCallback(dialogHandler);
  bridge.registerDialogResolvedCallback(() => {
    // Show "sent" state in editor tab dialog panel — user closes manually via X button
    QuoteDialogPanel.showSentState();
    void updateStatusBar();
  });
  bridge.registerSseClientChangeCallback(() => {
    void updateStatusBar();
    provider.postState();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("quote.openPanel", async () => {
      await vscode.commands.executeCommand(
        "workbench.view.extension.quote-sidebar",
      );
      provider.reveal();
      provider.postState();
    }),
    vscode.commands.registerCommand("quote.refresh", async () => {
      provider.refresh();
      provider.postState();
      await updateStatusBar();
      vscode.window.showInformationMessage("Windsurf Quote sidebar refreshed.");
    }),
    vscode.commands.registerCommand("quote.testFeedback", async () => {
      const message = await bridge?.injectTestFeedback();
      provider.postState();
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
        `Windsurf Quote bridge ${status.running ? "running" : "stopped"} · port ${status.port} · IDE ${status.currentIde}`,
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
      const result = await rotateMcpName();
      await updateStatusBar();
      provider.postBootstrap();
      void vscode.window.showInformationMessage(`工具名已旋转为: ${result.newName}`);
    }),
    vscode.commands.registerCommand("quote.debugListWindsurfCommands", async () => {
      const allCommands = await vscode.commands.getCommands(true);
      const windsurfCommands = allCommands.filter(cmd =>
        cmd.includes('windsurf') || cmd.includes('cascade') || cmd.includes('continue') || cmd.includes('resume')
      ).sort();
      const output = windsurfCommands.join('\n');
      const channel = vscode.window.createOutputChannel('Windsurf Commands');
      channel.appendLine(`Found ${windsurfCommands.length} Windsurf-related commands:\n`);
      channel.appendLine(output);
      channel.show();
      logger?.info('Windsurf commands listed', { count: windsurfCommands.length });
    }),
    vscode.commands.registerCommand("quote.debugHookStatus", async () => {
      const status = await WindsurfHooksManager.checkHookStatus(logger);
      const channel = vscode.window.createOutputChannel('Hook Status');
      channel.appendLine('=== Windsurf Hook Status ===\n');
      channel.appendLine(`Installed: ${status.installed}`);
      channel.appendLine(`Enabled: ${status.enabled}`);
      if (status.url) {
        channel.appendLine(`URL: ${status.url}`);
      }
      channel.appendLine(`\nConfig file: ${WindsurfHooksManager.getHooksFilePath()}`);
      channel.show();
      logger?.info('Hook status checked', status);
    }),
    vscode.commands.registerCommand("quote.debugHookMetrics", async () => {
      const metrics = getGlobalMetrics().getMetrics();
      const channel = vscode.window.createOutputChannel('Hook Metrics');
      channel.appendLine('=== Cascade Hook Metrics ===\n');
      channel.appendLine(`Total Calls: ${metrics.totalCalls}`);
      channel.appendLine(`Quota Exhausted Detections: ${metrics.quotaExhaustedDetections}`);
      channel.appendLine(`Rate Limit Short Detections: ${metrics.rateLimitShortDetections}`);
      channel.appendLine(`Rate Limit Long Detections: ${metrics.rateLimitLongDetections}`);
      channel.appendLine(`Auto Switch Triggers: ${metrics.autoSwitchTriggers}`);
      channel.appendLine(`Auto Switch Successes: ${metrics.autoSwitchSuccesses}`);
      channel.appendLine(`Auto Switch Failures: ${metrics.autoSwitchFailures}`);
      channel.appendLine(`Trajectory Blocks Added: ${metrics.trajectoryBlocksAdded}`);
      channel.appendLine(`Errors: ${metrics.errors}`);
      
      if (blockedTrajectoriesManager) {
        channel.appendLine(`\n=== Blocked Trajectories ===\n`);
        channel.appendLine(`Count: ${blockedTrajectoriesManager.count()}`);
        const blocked = blockedTrajectoriesManager.getAll();
        blocked.forEach(t => {
          channel.appendLine(`  - ${t.trajectoryId}: ${t.blockerType} (${t.wakeStatus})`);
        });
      }
      
      channel.show();
      logger?.info('Hook metrics displayed', metrics);
    }),
    vscode.commands.registerCommand("quote.debugResetHookMetrics", async () => {
      getGlobalMetrics().reset();
      if (blockedTrajectoriesManager) {
        blockedTrajectoriesManager.clear();
      }
      void vscode.window.showInformationMessage('Hook metrics reset');
      logger?.info('Hook metrics reset');
    }),
    vscode.commands.registerCommand("quote.importToken", async () => {
      if (!dataManager) {
        void vscode.window.showErrorMessage("DataManager 未初始化");
        return;
      }
      const token = await vscode.window.showInputBox({
        prompt: "粘贴 auth1 Token（以 auth1_ 开头）",
        placeHolder: "auth1_xxxxxxxxxxxxx",
        validateInput: (value) => {
          if (!value.trim()) return "Token 不能为空";
          if (!value.trim().startsWith("auth1_")) return "Token 必须以 auth1_ 开头";
          return undefined;
        },
      });
      if (!token) return;
      const result = await dataManager.windsurfAccounts.importAuth1Token(token.trim());
      if (result.success && result.account) {
        provider.postBootstrap();
        void updateStatusBar();
        void vscode.window.showInformationMessage(
          `Token 导入成功${result.account.email ? `: ${result.account.email}` : ''}`,
        );
        if (result.account.id) {
          void refreshQuotaAfterSwitch(result.account.id, "importToken");
        }
      } else {
        void vscode.window.showErrorMessage(
          `Token 导入失败: ${result.error ?? "未知错误"}`,
        );
      }
    }),
    vscode.commands.registerCommand("quote.createClone", async () => {
      if (!dataManager) {
        void vscode.window.showErrorMessage("DataManager 未初始化");
        return;
      }
      const label = await vscode.window.showInputBox({
        prompt: "输入分身名称",
        placeHolder: "例如：分身 1",
        validateInput: (value) => value.trim() ? undefined : "分身名称不能为空",
      });
      if (!label) return;
      const choice = await vscode.window.showWarningMessage(
        "将启动一个隔离 user-data-dir 的新窗口。不会复制或修改主实例数据库，分身内账号状态需要单独初始化。",
        { modal: true },
        "创建分身",
      );
      if (choice !== "创建分身") return;

      try {
        const manager = new InstanceManager(dataManager.globalStoragePath);
        const clone = await manager.createClone({ label: label.trim() });
        void vscode.window.showInformationMessage(`已启动分身: ${clone.label}`);
      } catch (error) {
        logger?.error("Create clone failed.", { error: String(error) });
        void vscode.window.showErrorMessage(`创建分身失败: ${String(error)}`);
      }
    }),
    vscode.commands.registerCommand("quote.testDialog", () => {
      if (!bridge) return;
      const sessionId = `test_${Date.now()}`;
      const req: import('./core/contracts').McpDialogRequest = {
        id: `test_${Date.now()}`,
        sessionId,
        summary: '## 对话框测试\n\n这是一条来自 **Windsurf Quote 插件**的测试对话框请求。\n\n请选择一个选项或输入自定义回复：',
        options: ['✅ 确认', '❌ 取消', '🔄 重试'],
        isMarkdown: true,
        receivedAt: new Date().toISOString(),
      };

      // injectTestDialogRequest triggers dialogCallback which opens QuoteDialogPanel
      bridge.injectTestDialogRequest(req, (response) => {
        logger?.info('TestDialog: user responded.', { response });
        void vscode.window.showInformationMessage(`测试对话框收到回复: "${response}"`);
        void updateStatusBar();
      });
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void bridge?.stop();
      logger?.dispose();
    },
  });

  await updateStatusBar();

  // ── autoSwitch 定时器：按 checkInterval 轮询，动态读取最新配置 ─────────
  // 使用固定10s轮询判断是否到达下次检查时间，避免配置变化后需要重建定时器
  // 初始化为当前时间，避免启动后立即触发换号（冷启动宽限期）
  let lastAutoSwitchCheckAt = Date.now();
  const autoSwitchPollInterval = setInterval(async () => {
    if (!dataManager) return;
    const cfg = dataManager.windsurfAccounts.getAutoSwitchConfig();
    if (!cfg.enabled) return;
    const intervalMs = Math.max(10, cfg.checkInterval) * 1000;
    if (Date.now() - lastAutoSwitchCheckAt < intervalMs) return;
    lastAutoSwitchCheckAt = Date.now();
    const switched = await dataManager.windsurfAccounts.autoSwitchIfNeeded();
    provider.postBootstrap();
    if (switched) {
      logger?.info('Auto-switch triggered by timer.');
    }
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(autoSwitchPollInterval) });

  // ── 配额自动刷新（10秒定时器）：高度健壮，支持窗口聚焦优化、并发控制、自动清理 ──
  const quotaPoller = new QuotaPoller(dataManager, logger!, () => {
    provider.postBootstrap();
  });
  quotaPoller.start();
  context.subscriptions.push(quotaPoller);

  // 延迟刷新状态：等待 MCP 客户端连接后更新 SSE 计数
  setTimeout(() => {
    void updateStatusBar();
    provider.postBootstrap();
  }, 3000);

  logger.info("Windsurf Quote activated.", {
    currentIde: currentIde.name,
    requestedPort: config.serverPort,
    runningPort,
    autoConfigureMcp: config.autoConfigureMcp,
    autoConfigureRules: config.autoConfigureRules,
    cleanupOnDeactivate: config.cleanupOnDeactivate,
  });

  // ── 备用渠道：如果有 pending 切换则完成（兼容旧逻辑） ───────────────
  const pendingId = dataManager.windsurfAccounts.getPendingSwitchId();
  if (pendingId) {
    void completePendingSwitch(dataManager, sidebarProvider, logger, pendingId);
  }
}

async function completePendingSwitch(
  dataManager: DataManager,
  provider: QuoteSidebarProvider,
  log: QuoteLogger,
  pendingId: string,
): Promise<void> {
  // 无补丁方案：等待 Windsurf 完全加载（最多 15 秒）
  await new Promise<void>((r) => setTimeout(r, 5000));

  log.info("Resuming pending switch after reload.", { pendingId });
  const result = await dataManager.windsurfAccounts.switchTo(pendingId);

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
  try {
    const cleanupConfig = getExtensionConfig();
    if (cleanupConfig.cleanupOnDeactivate) {
      const context = extensionContext;
      const ide = detectCurrentIde();
      const ownedNames = context ? getOwnedMcpNames(context) : [];
      const namesToClean = new Set<string>(ownedNames);
      if (activeToolName) {
        namesToClean.add(activeToolName);
      }
      if (namesToClean.size > 0) {
        await removeMcpConfigEntries(ide, [...namesToClean]);
      }
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder && activeToolName) {
        for (const rulesFile of ['.windsurfrules', 'AI_FEEDBACK_RULES.md']) {
          const rulesPath = path.join(wsFolder.uri.fsPath, rulesFile);
          const content = await fs.readFile(rulesPath, 'utf8').catch(() => '');
          if (content.includes(activeToolName)) {
            await fs.unlink(rulesPath).catch(() => {});
          }
        }
      }
      logger?.info('Deactivate cleanup done.', {
        activeToolName,
        secondaryInstance,
        ownedMcpNames: [...namesToClean],
      });
    } else {
      logger?.info('Deactivate cleanup skipped by configuration.', {
        activeToolName,
        secondaryInstance,
      });
    }
  } catch (err) {
    logger?.warn('Deactivate cleanup failed (non-fatal).', { error: String(err) });
  }
  extensionContext = undefined;
  sidebarProvider?.dispose();
  sidebarProvider = undefined;
  dataManager?.endSession();
  dataManager?.dispose();
  DataManager.resetInstance();
  await bridge?.stop();
  logger?.dispose();
}
