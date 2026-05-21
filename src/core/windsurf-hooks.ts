import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoggerLike } from './logger';

interface WindsurfHookCommand {
  command?: string;
  powershell?: string;
  show_output?: boolean;
  working_directory?: string;
}

interface WindsurfHookConfig {
  hooks?: Record<string, WindsurfHookCommand[]>;
}

export class WindsurfHooksManager {
  private static readonly HOOKS_DIR = path.join(os.homedir(), '.codeium', 'windsurf');
  private static readonly HOOKS_FILE = path.join(WindsurfHooksManager.HOOKS_DIR, 'hooks.json');
  private static readonly HOOK_EVENTS = ['post_cascade_response', 'post_cascade_response_with_transcript'] as const;
  private static readonly COMMAND_MARKER = '/api/ap/cascade-hook';

  static async ensureHooksDir(logger?: LoggerLike): Promise<void> {
    try {
      await fs.mkdir(WindsurfHooksManager.HOOKS_DIR, { recursive: true });
      logger?.info('Windsurf hooks directory ensured', { path: WindsurfHooksManager.HOOKS_DIR });
    } catch (error) {
      logger?.error('Failed to ensure hooks directory', { error: String(error), path: WindsurfHooksManager.HOOKS_DIR });
      throw error;
    }
  }

  static async readHooksConfig(logger?: LoggerLike): Promise<WindsurfHookConfig | null> {
    try {
      const content = await fs.readFile(WindsurfHooksManager.HOOKS_FILE, 'utf-8');
      const config = JSON.parse(content) as WindsurfHookConfig;
      logger?.info('Windsurf hooks config read', { path: WindsurfHooksManager.HOOKS_FILE });
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger?.info('Windsurf hooks file does not exist, will create new one');
        return null;
      }
      logger?.error('Failed to read hooks config', { error: String(error), path: WindsurfHooksManager.HOOKS_FILE });
      throw error;
    }
  }

  static async writeHooksConfig(config: WindsurfHookConfig, logger?: LoggerLike): Promise<void> {
    try {
      const tmpPath = `${WindsurfHooksManager.HOOKS_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
      await fs.rename(tmpPath, WindsurfHooksManager.HOOKS_FILE);
      logger?.info('Windsurf hooks config written', { path: WindsurfHooksManager.HOOKS_FILE });
    } catch (error) {
      logger?.error('Failed to write hooks config', { error: String(error), path: WindsurfHooksManager.HOOKS_FILE });
      throw error;
    }
  }

  /**
   * Inject Quote cascade hook into Windsurf hooks.json
   */
  static async injectHook(bridgePort: number, logger?: LoggerLike): Promise<{ success: boolean; message: string }> {
    try {
      await WindsurfHooksManager.ensureHooksDir(logger);
      const config = await WindsurfHooksManager.readHooksConfig(logger) || { hooks: {} };
      
      if (!config.hooks) {
        config.hooks = {};
      }

      const hook = WindsurfHooksManager.createHookCommand(bridgePort);
      let changed = false;
      for (const event of WindsurfHooksManager.HOOK_EVENTS) {
        const hooks = config.hooks[event] ?? [];
        const exists = hooks.some((item) => item.command === hook.command);
        if (!exists) {
          hooks.push(hook);
          config.hooks[event] = hooks;
          changed = true;
        }
      }

      if (!changed) {
        logger?.info('Quote cascade hooks already exist', { bridgePort });
        return { success: true, message: 'Hooks already exist' };
      }

      await WindsurfHooksManager.writeHooksConfig(config, logger);
      logger?.info('Quote cascade hook injected successfully', {
        bridgePort,
        events: WindsurfHooksManager.HOOK_EVENTS,
      });

      return { success: true, message: 'Hook injected successfully' };
    } catch (error) {
      logger?.error('Failed to inject hook', { error: String(error) });
      return { success: false, message: `Failed to inject hook: ${String(error)}` };
    }
  }

  /**
   * Remove Quote cascade hook from Windsurf hooks.json
   */
  static async removeHook(logger?: LoggerLike): Promise<{ success: boolean; message: string }> {
    try {
      const config = await WindsurfHooksManager.readHooksConfig(logger);
      if (!config || !config.hooks) {
        return { success: true, message: 'No hooks config found' };
      }

      let changed = false;
      for (const event of WindsurfHooksManager.HOOK_EVENTS) {
        const before = config.hooks[event] ?? [];
        const after = before.filter((hook) => !hook.command?.includes(WindsurfHooksManager.COMMAND_MARKER));
        if (after.length !== before.length) {
          changed = true;
          if (after.length > 0) {
            config.hooks[event] = after;
          } else {
            delete config.hooks[event];
          }
        }
      }

      if (!changed) {
        return { success: true, message: 'Hook not found' };
      }

      await WindsurfHooksManager.writeHooksConfig(config, logger);
      logger?.info('Quote cascade hooks removed');
      return { success: true, message: 'Hook removed successfully' };
    } catch (error) {
      logger?.error('Failed to remove hook', { error: String(error) });
      return { success: false, message: `Failed to remove hook: ${String(error)}` };
    }
  }

  /**
   * Check if Quote hook is installed and enabled
   */
  static async checkHookStatus(logger?: LoggerLike): Promise<{ installed: boolean; enabled: boolean; url?: string; events?: string[] }> {
    try {
      const config = await WindsurfHooksManager.readHooksConfig(logger);
      if (!config || !config.hooks) {
        return { installed: false, enabled: false };
      }

      const events = WindsurfHooksManager.HOOK_EVENTS.filter((event) =>
        (config.hooks?.[event] ?? []).some((hook) => hook.command?.includes(WindsurfHooksManager.COMMAND_MARKER)),
      );
      if (events.length === 0) {
        return { installed: false, enabled: false, events: [] };
      }

      return {
        installed: true,
        enabled: true,
        url: WindsurfHooksManager.COMMAND_MARKER,
        events,
      };
    } catch (error) {
      logger?.error('Failed to check hook status', { error: String(error) });
      return { installed: false, enabled: false };
    }
  }

  /**
   * Get hooks file path for debugging
   */
  static getHooksFilePath(): string {
    return WindsurfHooksManager.HOOKS_FILE;
  }

  private static createHookCommand(bridgePort: number): WindsurfHookCommand {
    const url = `http://127.0.0.1:${bridgePort}${WindsurfHooksManager.COMMAND_MARKER}`;
    return {
      command: `curl -fsS --connect-timeout 1 --max-time 3 -X POST -H 'Content-Type: application/json' --data-binary @- '${url}' >/dev/null 2>&1 || true`,
      show_output: false,
    };
  }
}
