import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LoggerLike } from '../core/logger';

// ─── 补丁特征关键字 ────────────────────────────────────────────────────────────
const PATCH_KEYWORD_1 = 'windsurf.provideAuthTokenToAuthProviderWithShit';
const PATCH_KEYWORD_2 = 'handleAuthTokenWithShit';

// ─── 原始 handleAuthToken 函数（精确匹配当前 Windsurf 混淆代码）──────────────────
const ORIGINAL_HANDLE_AUTH_TOKEN =
  'async handleAuthToken(A){const e=await(0,E.registerUser)(A),{apiKey:t,name:i}=e,' +
  'n=(0,B.getApiServerUrl)(e.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError' +
  '("Auth login failure: empty api_key");if(!i)throw new s.AuthMalformedLanguageServerResponseError' +
  '("Auth login failure: empty name");const r={id:(0,g.v4)(),accessToken:t,account:{label:i,id:i},' +
  'scopes:[]},I=(0,B.isStaging)((0,a.getConfig)(a.Config.API_SERVER_URL))?"apiServerUrl.staging":"apiServerUrl";' +
  'return await this.context.globalState.update(I,n),(0,o.isString)(n)&&!(0,o.isEmpty)(n)&&' +
  'await this.context.secrets.store(u.getApiServerUrlSecretKey(),n),this._cachedSessions=[r],' +
  'await this.context.secrets.store(u.getSessionsSecretKey(),JSON.stringify([r])),' +
  'await this.restartLanguageServerIfNeeded(n),this._sessionChangeEmitter.fire({added:[r],removed:[],changed:[]}),r}';

// ─── 新注入的 handleAuthTokenWithShit 函数（直接使用传入的 apiKey，跳过 registerUser）
const NEW_HANDLE_AUTH_TOKEN_WITH_SHIT =
  'async handleAuthTokenWithShit(A){const{apiKey:t,name:i}=A,' +
  'n=(0,B.getApiServerUrl)(A.apiServerUrl);if(!t)throw new s.AuthMalformedLanguageServerResponseError' +
  '("Auth login failure: empty api_key");if(!i)throw new s.AuthMalformedLanguageServerResponseError' +
  '("Auth login failure: empty name");const r={id:(0,g.v4)(),accessToken:t,account:{label:i,id:i},' +
  'scopes:[]},I=(0,B.isStaging)((0,a.getConfig)(a.Config.API_SERVER_URL))?"apiServerUrl.staging":"apiServerUrl";' +
  'return await this.context.globalState.update(I,n),(0,o.isString)(n)&&!(0,o.isEmpty)(n)&&' +
  'await this.context.secrets.store(u.getApiServerUrlSecretKey(),n),this._cachedSessions=[r],' +
  'await this.context.secrets.store(u.getSessionsSecretKey(),JSON.stringify([r])),' +
  'await this.restartLanguageServerIfNeeded(n),this._sessionChangeEmitter.fire({added:[r],removed:[],changed:[]}),r}';

// ─── 原始命令注册块（当前 Windsurf 版本）────────────────────────────────────────
const ORIGINAL_COMMAND_REGISTRATION =
  'A.subscriptions.push(s.commands.registerCommand(t.PROVIDE_AUTH_TOKEN_TO_AUTH_PROVIDER,' +
  'async A=>{try{return{session:await e.handleAuthToken(A),error:void 0}}catch(A){return A instanceof ' +
  'a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata.getInstance().errorCodes' +
  '.GENERIC_ERROR}}}),s.commands.registerCommand(t.LOGIN_WITH_REDIRECT,async(A,e)=>{(k||G)&&await F(),' +
  'k=void 0;const t=(0,f.getAuthSession)({promptLoginIfNone:!0,shouldRegisterNewUser:A,fromOnboarding:e})' +
  '.catch(A=>{if(!L(A))throw(0,u.sentryCaptureException)(A),console.error("Error during login with redirect:",A),A});' +
  'k=t;try{return await t}finally{k===t&&(k=void 0)}}),s.commands.registerCommand' +
  '(t.LOGIN_WITH_AUTH_TOKEN,()=>{e.provideAuthToken()}),s.commands.registerCommand(t.CANCEL_LOGIN,' +
  '()=>F()),s.commands.registerCommand(t.LOGOUT,' +
  'async()=>{const A=y.WindsurfAuthProvider.getInstance(),e=await A.getSessions();e.length>0&&' +
  'await A.removeSession(e[0].id)})),';

// ─── 追加注册的新命令 ─────────────────────────────────────────────────────────
const NEW_COMMAND_REGISTRATION =
  'A.subscriptions.push(s.commands.registerCommand(' +
  '"windsurf.provideAuthTokenToAuthProviderWithShit",' +
  'async A=>{try{return{session:await e.handleAuthTokenWithShit(A),error:void 0}}catch(A){' +
  'return A instanceof a.WindsurfError?{error:A.errorMetadata}:{error:C.WindsurfExtensionMetadata' +
  '.getInstance().errorCodes.GENERIC_ERROR}}})),';

// ─── 公开接口 ─────────────────────────────────────────────────────────────────

export interface PatchStatus {
  applied: boolean;
  extensionPath?: string;
  error?: string;
}

export interface PatchApplyResult {
  success: boolean;
  needsRestart?: boolean;
  error?: string;
  permissionHint?: string;
}

export class WindsurfPatchService {
  /**
   * 查找 Windsurf extension.js 路径
   * 兼容：直接安装（无版本后缀）与 codeium.windsurf-x.y.z 命名
   */
  static findExtensionPath(): string | null {
    const appRoot = vscode.env.appRoot;
    if (!appRoot) return null;

    // ── 构建全平台候选路径列表（对齐参考项目 windsurfPathService.ts）──────────
    const candidates: string[] = [];
    const parent = path.dirname(appRoot);

    // 通用路径（最常见，跨平台）
    candidates.push(path.join(appRoot, 'extensions', 'windsurf', 'dist', 'extension.js'));

    if (process.platform === 'win32') {
      candidates.push(
        path.join(appRoot, 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, 'Extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, '..', 'data', 'extensions', 'windsurf', 'dist', 'extension.js'),
      );
    } else if (process.platform === 'darwin') {
      candidates.push(
        path.join(appRoot, 'Contents', 'Resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, '..', '..', 'Extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, 'Resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
      );
    } else {
      candidates.push(
        path.join(appRoot, 'resources', 'app', 'extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, '..', 'extensions', 'windsurf', 'dist', 'extension.js'),
        path.join(appRoot, 'usr', 'share', 'windsurf', 'extensions', 'windsurf', 'dist', 'extension.js'),
      );
    }

    // 通用父目录备用路径
    candidates.push(
      path.join(parent, 'extensions', 'windsurf', 'dist', 'extension.js'),
      path.join(parent, 'windsurf', 'extensions', 'windsurf', 'dist', 'extension.js'),
      path.join(appRoot, '..', 'extensions', 'windsurf', 'dist', 'extension.js'),
    );

    // 精确路径匹配（去重后逐一检查）
    for (const p of [...new Set(candidates)]) {
      if (fs.existsSync(p)) return p;
    }

    // ── 扫描 codeium.windsurf-* 版本化目录 ──────────────────────────────────
    const extensionsDir = path.join(appRoot, 'extensions');
    try {
      const entries = fs.readdirSync(extensionsDir);
      for (const entry of entries) {
        if (entry.startsWith('codeium.windsurf') || entry === 'windsurf') {
          const candidate = path.join(extensionsDir, entry, 'dist', 'extension.js');
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * 检查补丁是否已应用
   */
  static async isPatchApplied(): Promise<PatchStatus> {
    const extensionPath = this.findExtensionPath();
    if (!extensionPath) {
      return { applied: false, error: '未找到 Windsurf extension.js，请确认 Windsurf 已安装' };
    }
    try {
      const content = fs.readFileSync(extensionPath, 'utf-8');
      const applied = content.includes(PATCH_KEYWORD_1) && content.includes(PATCH_KEYWORD_2);
      return { applied, extensionPath };
    } catch (err) {
      return { applied: false, extensionPath, error: String(err) };
    }
  }

  /**
   * 生成权限修复命令提示
   */
  static getPermissionHint(extensionPath: string): string {
    const distDir = path.dirname(extensionPath);          // .../dist
    const extDir  = path.dirname(distDir);                // .../codeium.windsurf-x
    const extsDir = path.dirname(extDir);                 // .../extensions
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return `请在终端运行:\nsudo chmod -R +w "${extsDir}"`;
    }
    return '请以管理员身份运行 Windsurf';
  }

  /**
   * 应用补丁（修改 extension.js）
   * 返回 needsRestart=true 表示首次打补丁需要重启 Windsurf 才能加载新命令
   */
  static async applyPatch(logger?: LoggerLike): Promise<PatchApplyResult> {
    const extensionPath = this.findExtensionPath();
    if (!extensionPath) {
      return { success: false, error: '未找到 Windsurf extension.js，请确认 Windsurf 已安装' };
    }

    try { fs.accessSync(extensionPath, fs.constants.R_OK); }
    catch { return { success: false, error: `无法读取文件: ${extensionPath}` }; }

    try { fs.accessSync(extensionPath, fs.constants.W_OK); }
    catch {
      return {
        success: false,
        error: `没有写入权限: ${extensionPath}`,
        permissionHint: this.getPermissionHint(extensionPath)
      };
    }

    let content = fs.readFileSync(extensionPath, 'utf-8');

    // 步骤1：注入 handleAuthTokenWithShit 函数
    const fnIdx = content.indexOf(ORIGINAL_HANDLE_AUTH_TOKEN);
    if (fnIdx === -1) {
      return {
        success: false,
        error: '未找到 handleAuthToken 函数。当前 Windsurf 版本可能不兼容，请联系开发者。'
      };
    }
    const insertFnAt = fnIdx + ORIGINAL_HANDLE_AUTH_TOKEN.length;
    content = content.slice(0, insertFnAt) + NEW_HANDLE_AUTH_TOKEN_WITH_SHIT + content.slice(insertFnAt);

    // 步骤2：注入新命令注册
    const cmdIdx = content.indexOf(ORIGINAL_COMMAND_REGISTRATION);
    if (cmdIdx === -1) {
      return {
        success: false,
        error: '未找到命令注册块。当前 Windsurf 版本可能不兼容，请联系开发者。'
      };
    }
    const insertCmdAt = cmdIdx + ORIGINAL_COMMAND_REGISTRATION.length;
    content = content.slice(0, insertCmdAt) + NEW_COMMAND_REGISTRATION + content.slice(insertCmdAt);

    try {
      fs.writeFileSync(extensionPath, content, 'utf-8');
    } catch (err) {
      return { success: false, error: `写入文件失败: ${String(err)}` };
    }

    // 验证写入
    const verify = fs.readFileSync(extensionPath, 'utf-8');
    if (!verify.includes(PATCH_KEYWORD_1) || !verify.includes(PATCH_KEYWORD_2)) {
      return { success: false, error: '补丁写入后验证失败，文件内容与预期不符' };
    }

    logger?.info('WindsurfPatch applied.', { extensionPath });
    return { success: true, needsRestart: true };
  }

  /**
   * 检查并自动应用补丁（幂等）
   */
  static async checkAndApply(logger?: LoggerLike): Promise<PatchApplyResult> {
    const status = await this.isPatchApplied();
    if (status.applied) {
      return { success: true, needsRestart: false };
    }
    if (status.error && !status.extensionPath) {
      return { success: false, error: status.error };
    }
    return this.applyPatch(logger);
  }
}
