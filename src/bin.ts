#!/usr/bin/env node
/**
 * wecom-aibot-mcp - 企业微信智能机器人 MCP 服务
 *
 * npx 运行入口
 *
 * v2.0 架构变更：
 * - 使用 Session 管理
 * - robotName 作为连接索引
 * - 不再使用 projectDir
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  runConfigWizard,
  loadConfig,
  saveConfig,
  deleteRobotConfigInteractive,
  uninstall,
  addMcpConfig,
  detectUserIdFromMessage,
  ensureHookInstalled,
  listAllRobots,
  ensureGlobalConfigs,
  getAuthToken,
  setAuthToken,
  getHttpsConfig,
  setHttpsConfig,
  updateMcpAuthHeaders,
  runRemoteInstallWizard,
  WecomConfig,
  VERSION,
} from './config-wizard.js';
import { initClient, WecomClient } from './client.js';
import { registerTools } from './tools/index.js';
import { startHttpServer, stopHttpServer, HTTP_PORT } from './http-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllConnectionStates } from './connection-manager.js';
import { loadStats, cleanupOldLogs } from './connection-log.js';
import { startKeepaliveMonitor, stopKeepaliveMonitor } from './keepalive-monitor.js';
import { logger } from './logger.js';

const PID_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'server.pid');

function showHelp() {
  console.log(`
企业微信智能机器人 MCP 服务 v${VERSION}

安装:
  npx @vrs-soft/wecom-aibot-mcp

用法:
  npx @vrs-soft/wecom-aibot-mcp [选项]

选项:
  --help, -h      显示帮助信息
  --version, -v   显示版本号
  --setup         安装向导（交互式，询问本地 / 远程）
  --setup --server          服务器端安装（配置机器人 + Token）
  --setup --channel         Channel 客户端安装（写入 Channel MCP）
  --setup --server --channel  本地完整安装（HTTP + Channel）
  --upgrade       强制升级全局配置（覆盖 MCP 配置、权限、skill）
  --reinstall     重新安装全局配置（删除后重新写入，保留机器人配置）
  --start         启动 MCP Server（后台服务模式）
  --stop          停止 MCP Server
  --debug         前台启动 MCP Server（日志直接输出到终端，用于调试）
  --channel       启动 Channel MCP Proxy（stdio 代理 + SSE 唤醒）
  --http-only     仅启动 HTTP Server（远程部署场景，不安装 Channel MCP 配置）
  --channel-only  仅配置 Channel MCP（本地连接远程 HTTP Server）
  --status        显示服务状态和机器人配置
  --config        重新配置默认机器人（修改 Bot ID / Secret / 目标用户）
  --add           添加新的机器人配置（多机器人场景）
  --rename [名称] 重命名机器人（可选参数：旧名称，交互式输入新名称）
  --list          列出所有已配置的机器人及其占用状态
  --delete [名称] 删除指定的机器人配置（保留 MCP 配置）
  --uninstall     卸载并删除所有配置（包括 MCP 配置、hook、skill）
  --set-token [token]  设置/清除 Auth Token（远程部署用，--set-token --clear 清除）
  --clean-cache   清空 CC 注册表缓存（清理异常断线残留的 ccId）

使用流程:
  1. 安装:    npx @vrs-soft/wecom-aibot-mcp --setup
     （根据角色选择参数：--server / --channel / 两者都传 / 不传交互选择）

  2. 启动服务: npx @vrs-soft/wecom-aibot-mcp --start
     （后台启动 MCP HTTP Server）

  3. 停止服务: npx @vrs-soft/wecom-aibot-mcp --stop

拆分部署（远程 HTTP + 本地 Channel）:

  远程服务器:
    npx @vrs-soft/wecom-aibot-mcp --http-only --start
    # 只启动 HTTP Server，不写入本地 MCP 配置

  本地机器:
    MCP_URL=http://远程IP:18963 npx @vrs-soft/wecom-aibot-mcp --channel-only
    # 必须通过 MCP_URL 指定远程 HTTP MCP 地址
    # 只配置 Channel MCP，连接远程 HTTP Server

MCP 配置（默认安装同时配置两种模式）:

  HTTP Transport（轮询模式）:
    "wecom-aibot": {
      "type": "http",
      "url": "http://127.0.0.1:18963/mcp"
    }

  Channel Transport（SSE 推送模式）:
    "wecom-aibot-channel": {
      "command": "npx",
      "args": ["@vrs-soft/wecom-aibot-mcp", "--channel"]
    }

  Channel 模式优势：微信消息自动唤醒 agent，无需主动轮询
  启动 Channel 模式（研究预览）：
    claude --dangerously-load-development-channels server:wecom-aibot-channel

更多信息: https://github.com/eric2877/wecom-aibot-mcp
`);
}

function showVersion() {
  console.log(`wecom-aibot-mcp v${VERSION}`);
}

function showStatus() {
  const allRobots = listAllRobots();
  const connections = getAllConnectionStates();
  const authToken = getAuthToken();

  // 检查服务是否运行
  const serverRunning = isServerRunning();
  console.log(`\n服务状态: ${serverRunning ? '✅ 运行中' : '❌ 未启动'}`);

  // 显示 Auth Token 状态（带部分 token 显示）
  if (authToken) {
    const maskedToken = authToken.length > 12
      ? `${authToken.slice(0, 8)}...${authToken.slice(-4)}`
      : `${authToken.slice(0, 4)}...`;
    console.log(`Auth Token: ✅ 已配置 (${maskedToken})`);
  } else {
    console.log(`Auth Token: （未配置，本地部署无需 token）`);
  }
  console.log('');

  if (allRobots.length === 0) {
    console.log('尚未配置机器人，请运行 npx @vrs-soft/wecom-aibot-mcp 启动配置向导');
    return;
  }

  // 构建机器人占用信息
  const robotUsage = new Map<string, { agentName: string }>();
  for (const conn of connections) {
    if (conn.agentName) {
      robotUsage.set(conn.robotName, { agentName: conn.agentName });
    }
  }

  console.log(`已配置 ${allRobots.length} 个机器人:\n`);

  for (const robot of allRobots) {
    const usage = robotUsage.get(robot.name);
    const statusTag = usage ? ` [使用中]` : '';
    const docTag = robot.doc_mcp_url ? ' [文档✅]' : '';

    console.log(`    Bot名称：  ${robot.name}${statusTag}${docTag}`);
    console.log(`    Bot ID：   ${robot.botId}`);
    console.log(`    目标用户：${robot.targetUserId}`);
    if (usage) {
      console.log(`    使用者：  ${usage.agentName}`);
    }
    console.log('');
  }
}

// 检查服务是否运行
function isServerRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    // 检查进程是否存在
    process.kill(pid, 0);
    return true;
  } catch {
    // 进程不存在，清理 PID 文件（可能已被进程自身删除）
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    return false;
  }
}

// 停止服务
function stopServer(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    console.log('[mcp] 服务未运行');
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    process.kill(pid, 'SIGTERM');

    // 等待进程退出
    let attempts = 0;
    while (attempts < 10) {
      try {
        process.kill(pid, 0);
        // 进程还存在，等待
        setTimeout(() => {}, 500);
        attempts++;
      } catch {
        // 进程已退出
        break;
      }
    }

    // 进程退出后删除 PID 文件（如果还存在）
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    console.log('[mcp] 服务已停止');
    return true;
  } catch (err) {
    logger.error('[mcp] 停止服务失败:', err);
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    return false;
  }
}

// 等待连接验证（用于配置向导验证凭证）
async function waitForConnection(client: WecomClient, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (client.isConnected()) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 500);
  });
}

// 启动 MCP Server（前台运行，供 --start 使用）
async function startMcpServerForeground(isDebug: boolean = false): Promise<void> {
  const savedConfig = loadConfig();
  if (!savedConfig || !savedConfig.botId || !savedConfig.secret || !savedConfig.targetUserId) {
    logger.error('[mcp] 未找到配置，请先运行: npx @vrs-soft/wecom-aibot-mcp');
    process.exit(1);
  }

  // 写入 PID 文件
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Debug 模式：创建 debug 标记文件
  if (isDebug) {
    const debugFile = path.join(os.homedir(), '.wecom-aibot-mcp', 'debug');
    fs.writeFileSync(debugFile, 'true');
    console.log('[mcp] Debug 标记文件已创建');
  }

  // 确保 hook 已安装
  ensureHookInstalled();

  // 加载统计并清理旧日志
  loadStats();
  cleanupOldLogs(1 / 24);

  // 创建 MCP Server
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  });

  registerTools(server);

  // 启动 HTTP 服务
  logger.log('');
  logger.log('  ╔════════════════════════════════════════════════════════╗');
  logger.log(`  ║   企业微信智能机器人 MCP 服务 v${VERSION}                   ║`);
  logger.log('  ║   Claude Code 审批通道                                 ║');
  logger.log('  ╚════════════════════════════════════════════════════════╝');
  logger.log('');

  const httpsConfig = getHttpsConfig() ?? undefined;
  const protocol = httpsConfig ? 'HTTPS' : 'HTTP';
  logger.log(`[mcp] 启动 MCP ${protocol} Server (端口: ${HTTP_PORT})...`);
  await startHttpServer(server, HTTP_PORT, httpsConfig);

  startKeepaliveMonitor();

  logger.log(`[mcp] MCP Server 已就绪`);
  logger.log(`[mcp] HTTP endpoint: http://127.0.0.1:${HTTP_PORT}/mcp`);
  logger.log(`[mcp] 健康检查: http://127.0.0.1:${HTTP_PORT}/health`);
  logger.log(`[mcp] 微信模式：enter_headless_mode 时建立连接`);
  logger.log(`[mcp] PID: ${process.pid}`);

  // 退出处理
  const gracefulShutdown = () => {
    console.log('[mcp] 正在关闭...');
    stopKeepaliveMonitor();
    stopHttpServer();
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    // Debug 模式：删除 debug 标记文件
    if (isDebug) {
      const debugFile = path.join(os.homedir(), '.wecom-aibot-mcp', 'debug');
      if (fs.existsSync(debugFile)) {
        fs.unlinkSync(debugFile);
        console.log('[mcp] Debug 标记文件已删除');
      }
    }
    process.exit(0);
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

// 后台启动 MCP Server（使用 spawn）
function startMcpServerBackground(): void {
  // 检查配置是否存在
  const savedConfig = loadConfig();
  if (!savedConfig || !savedConfig.botId || !savedConfig.secret || !savedConfig.targetUserId) {
    logger.error('[mcp] 未找到配置，请先运行: npx @vrs-soft/wecom-aibot-mcp');
    process.exit(1);
  }

  // 检查是否已运行
  if (isServerRunning()) {
    console.log('[mcp] 服务已在运行中');
    return;
  }

  const nodePath = process.execPath;
  const scriptPath = process.argv[1];

  const child = spawn(nodePath, [scriptPath, '--start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  console.log('[mcp] MCP Server 已在后台启动');
  logger.log(`[mcp] HTTP endpoint: http://127.0.0.1:18963/mcp`);
  console.log('[mcp] 健康检查: curl http://127.0.0.1:18963/health');
  console.log('[mcp] 停止服务: npx @vrs-soft/wecom-aibot-mcp --stop');
  console.log('[mcp] 调试模式: npx @vrs-soft/wecom-aibot-mcp --debug');
}

async function main() {
  const args = process.argv.slice(2);

  // 确定安装模式
  const installMode: 'full' | 'http-only' | 'channel-only' =
    args.includes('--http-only') ? 'http-only' :
    args.includes('--channel-only') ? 'channel-only' : 'full';

  // 以下命令跳过顶部 ensureGlobalConfigs，避免覆盖配置
  // --setup: 向导完成后自己调用
  // --channel: 作为 Channel MCP 代理运行，不应改写全局配置
  // --reinstall / --http-only: 有自己的处理逻辑
  // --version / -v: 只查版本，不写配置
  const skipEnsure = args.includes('--reinstall') || args.includes('--http-only') ||
    args.includes('--setup') || args.includes('--channel') ||
    args.includes('--version') || args.includes('-v');
  if (!skipEnsure) {
    // 强制覆盖所有全局配置（不依赖智能体）
    ensureGlobalConfigs(installMode);
  }

  // 解析命令行参数
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  // --upgrade 命令：强制升级全局配置（已在启动时执行，这里显示结果）
  if (args.includes('--upgrade')) {
    console.log('\n[mcp] ✅ 全局配置已更新完成！');
    console.log('[mcp] 配置位置:');
    console.log('  - ~/.claude.json (MCP Server 配置)');
    console.log('  - ~/.claude/settings.local.json (权限和 Hook)');
    console.log('  - ~/.wecom-aibot-mcp/version.json (版本记录)');
    console.log('\n[mcp] 请重启 Claude Code 以加载最新配置');
    process.exit(0);
  }

  // --reinstall 命令：删除所有全局配置（保留机器人配置）后重新安装
  if (args.includes('--reinstall')) {
    logger.log('\n[mcp] 重新安装全局配置...');
    console.log('[mcp] 保留所有机器人配置: ~/.wecom-aibot-mcp/robot-*.json');

    const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
    const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
    const VERSION_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'version.json');
    const HOOK_SCRIPT = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

    // 1. 删除 ~/.claude.json 中的 wecom-aibot 配置
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);
      if (config.mcpServers?.['wecom-aibot']) {
        delete config.mcpServers['wecom-aibot'];
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(config, null, 2));
        console.log('[mcp] 已删除 ~/.claude.json 中的 wecom-aibot 配置');
      }
    }

    // 2. 删除 ~/.claude/settings.local.json 中的权限和 Hook
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      const content = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8');
      const config = JSON.parse(content);
      if (config.permissions?.allow) {
        config.permissions.allow = config.permissions.allow.filter(
          (p: string) => !p.startsWith('mcp__wecom-aibot__')
        );
        console.log('[mcp] 已删除 wecom-aibot 工具权限');
      }
      if (config.hooks?.PermissionRequest) {
        config.hooks.PermissionRequest = config.hooks.PermissionRequest.filter(
          (h: any) => !h.hooks?.some?.((hook: any) => hook.command?.includes?.('wecom-aibot-mcp'))
        );
        if (config.hooks.PermissionRequest.length === 0) {
          delete config.hooks.PermissionRequest;
        }
        console.log('[mcp] 已删除 PermissionRequest hook');
      }
      fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(config, null, 2));
    }

    // 3. 删除版本文件
    if (fs.existsSync(VERSION_FILE)) {
      fs.unlinkSync(VERSION_FILE);
      console.log('[mcp] 已删除 ~/.wecom-aibot-mcp/version.json');
    }

    // 4. 删除 hook 脚本
    if (fs.existsSync(HOOK_SCRIPT)) {
      fs.unlinkSync(HOOK_SCRIPT);
      console.log('[mcp] 已删除 ~/.wecom-aibot-mcp/permission-hook.sh');
    }

    // 5. 重新安装全局配置
    logger.log('\n[mcp] 正在重新安装...');
    ensureGlobalConfigs();

    logger.log('\n[mcp] ✅ 重新安装完成！');
    console.log('[mcp] 请重启 Claude Code 以加载最新配置');
    process.exit(0);
  }

  if (args.includes('--status') || args.includes('--list')) {
    showStatus();
    process.exit(0);
  }

  // --stop 命令：停止服务
  if (args.includes('--stop')) {
    stopServer();
    process.exit(0);
  }

  // --clean-cache 命令：清空 CC 注册表缓存
  if (args.includes('--clean-cache')) {
    if (!isServerRunning()) {
      console.log('[mcp] 服务未运行，无需清理缓存');
      process.exit(0);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/admin/clean-cache`, { method: 'POST' });
      const data = await res.json() as { ok: boolean; cleared: number; entries: string[] };
      if (data.ok) {
        console.log(`[mcp] 已清空 CC 注册表，共清理 ${data.cleared} 条`);
        if (data.entries.length > 0) {
          console.log(`[mcp] 已清理: ${data.entries.join(', ')}`);
        }
      }
    } catch (err) {
      console.error('[mcp] 清理失败:', err);
    }
    process.exit(0);
  }

  // --uninstall 命令：先停止服务再卸载
  if (args.includes('--uninstall')) {
    if (isServerRunning()) {
      console.log('[mcp] 正在停止服务...');
      stopServer();
    }
    uninstall();
    process.exit(0);
  }

  // --set-token 命令：设置/清除 Auth Token
  if (args.includes('--set-token')) {
    const tokenIndex = args.indexOf('--set-token');
    const clearToken = args.includes('--clear');

    if (clearToken) {
      setAuthToken(undefined);
      updateMcpAuthHeaders(undefined);
      console.log('[mcp] ✅ Auth Token 已清除（服务端 + 客户端 MCP 配置）');
      process.exit(0);
    }

    // 检查下一个参数是否是 token（不是另一个 --flag）
    const nextArg = args[tokenIndex + 1];
    const token = (nextArg && !nextArg.startsWith('--')) ? nextArg : undefined;

    if (!token) {
      // 交互式输入 token
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const input = await new Promise<string>((resolve) => {
        rl.question('请输入 Auth Token（留空取消）: ', (answer: string) => {
          rl.close();
          resolve(answer.trim());
        });
      });
      if (!input) {
        console.log('[mcp] 已取消');
        process.exit(0);
      }
      setAuthToken(input);
      updateMcpAuthHeaders(input);
      console.log('[mcp] ✅ Auth Token 已设置');
      console.log(`[mcp] 服务端: ~/.wecom-aibot-mcp/server.json`);
      console.log(`[mcp] 客户端: ~/.claude.json MCP headers 已同步`);
      console.log(`[mcp] Token: ${input.slice(0, 8)}...${input.slice(-4)}`);
    } else {
      setAuthToken(token);
      updateMcpAuthHeaders(token);
      console.log('[mcp] ✅ Auth Token 已设置');
      console.log(`[mcp] Token: ${token.slice(0, 8)}...${token.slice(-4)}`);
    }
    process.exit(0);
  }

  if (args.includes('--add')) {
    await addMcpConfig();
    process.exit(0);
  }

  // --delete 命令：删除单个机器人配置
  const deleteIndex = args.indexOf('--delete');
  if (deleteIndex !== -1) {
    const robotName = args[deleteIndex + 1]; // 可选参数：机器人名称
    await deleteRobotConfigInteractive(robotName);
    process.exit(0);
  }

  // --start --foreground：前台启动（内部调用，输出到日志文件）
  if (args.includes('--start') && args.includes('--foreground')) {
    await startMcpServerForeground();
    return; // 保持运行，不 exit
  }

  // --setup：统一安装向导
  //   --setup                    → 交互式（询问本地 / 远程）
  //   --setup --server           → 服务器端（机器人配置 + Token）
  //   --setup --channel          → Channel 客户端（写入 Channel MCP）
  //   --setup --server --channel → 本地完整安装（HTTP + Channel）
  if (args.includes('--setup')) {
    const wantServer = args.includes('--server');
    const wantChannel = args.includes('--channel');

    if (wantServer && wantChannel) {
      // 本地完整安装
      console.log('\n[setup] 本地完整安装模式\n');
      const savedConfig = loadConfig();
      if (!savedConfig?.botId) await runConfigWizard();
      ensureGlobalConfigs('full');
      startMcpServerBackground();
      console.log('[setup] 安装完成！请重启 Claude Code 以加载配置');

    } else if (wantServer) {
      // 服务器端：分两步——先完成 Server 安装，再配置机器人
      console.log('\n[setup] ─── 步骤 1/2：Server 安装 ───\n');
      console.log('  Server 负责运行 HTTP MCP 服务，Bot 配置在下一步单独完成\n');
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const token = await new Promise<string>(resolve =>
        rl.question('Auth Token（Client 端连接时需填写相同 Token，留空跳过）: ', a => { rl.close(); resolve(a.trim()); })
      );
      if (token) setAuthToken(token);

      // HTTPS 证书配置
      const defaultCertPath = path.join(os.homedir(), '.wecom-aibot-mcp', 'cert.pem');
      console.log('\n  HTTPS 证书配置（留空跳过，保持 HTTP 模式）');
      console.log('  请输入完整路径含文件名（.pem / .crt / .key 均可），例如:');
      console.log(`    ${defaultCertPath}`);
      console.log('    /etc/letsencrypt/live/example.com/fullchain.pem');
      console.log('    /etc/gitlab/ssl/gitlab.example.com.crt\n');

      const checkFile = (p: string, label: string): boolean => {
        if (!fs.existsSync(p)) { console.log(`[setup] ⚠️  ${label}文件不存在: ${p}`); return false; }
        if (fs.statSync(p).isDirectory()) { console.log(`[setup] ⚠️  ${label}路径是目录而非文件: ${p}`); return false; }
        return true;
      };

      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const certInput = await new Promise<string>(resolve =>
        rl2.question(`SSL 证书文件完整路径（留空跳过）: `, a => { rl2.close(); resolve(a.trim()); })
      );

      if (certInput) {
        if (!checkFile(certInput, '证书')) {
          console.log('[setup] 跳过 HTTPS 配置');
        } else {
          const rl3 = readline.createInterface({ input: process.stdin, output: process.stdout });
          const keyInput = await new Promise<string>(resolve =>
            rl3.question(`SSL 私钥文件完整路径: `, a => { rl3.close(); resolve(a.trim()); })
          );
          if (keyInput && checkFile(keyInput, '私钥')) {
            setHttpsConfig(certInput, keyInput);
            console.log(`[setup] HTTPS 已配置`);
            console.log(`  证书: ${certInput}`);
            console.log(`  私钥: ${keyInput}`);
          } else if (!keyInput) {
            console.log('[setup] 私钥路径不能为空，跳过 HTTPS 配置');
          }
        }
      } else {
        console.log(`[setup] 跳过 HTTPS，使用 HTTP 模式`);
        console.log(`[setup] 如需启用 HTTPS，配置证书后重新运行 --setup --server`);
      }

      console.log('\n[setup] Server 配置完成！');
      console.log('  启动: npx @vrs-soft/wecom-aibot-mcp --http-only --start');
      console.log('\n[setup] ─── 步骤 2/2：配置企业微信机器人 ───\n');
      await addMcpConfig();

    } else if (wantChannel) {
      // Channel 客户端
      console.log('\n[setup] Channel Client 安装模式\n');
      // 交互式安装必须每次都提示，不能直接用已有的环境变量（可能是旧值）
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const existingUrl = process.env.MCP_URL || '';
      const urlPrompt = existingUrl
        ? `远程服务器地址（当前: ${existingUrl}，直接回车保持不变）: `
        : `远程服务器地址（如 https://your-server:18963）: `;
      const urlInput = await new Promise<string>(resolve =>
        rl.question(urlPrompt, a => { rl.close(); resolve(a.trim()); })
      );
      const mcpUrl = urlInput || existingUrl;
      if (!mcpUrl) { console.log('[setup] ❌ 地址不能为空'); process.exit(1); }
      process.env.MCP_URL = mcpUrl;
      if (!getAuthToken()) {
        const readline2 = await import('readline');
        const rl2 = readline2.createInterface({ input: process.stdin, output: process.stdout });
        const token = await new Promise<string>(resolve =>
          rl2.question('Auth Token: ', a => { rl2.close(); resolve(a.trim()); })
        );
        if (token) setAuthToken(token);
      }
      ensureGlobalConfigs('channel-only');
      console.log('[setup] Channel MCP 配置完成！请重启 Claude Code 以加载配置');

    } else {
      // 交互式：1/2 模式选择
      console.log('\n请选择安装模式：\n');
      console.log('  1. 本地安装（完整功能：HTTP + Channel MCP）');
      console.log('  2. 远程服务器（连接远程 HTTP MCP）\n');
      const readline = await import('readline');
      const modeChoice = await new Promise<string>((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('请选择 (1/2，默认 1): ', a => { rl.close(); resolve(a.trim() || '1'); });
      });
      if (modeChoice === '2') {
        await runRemoteInstallWizard();
      } else {
        await runConfigWizard();
        ensureGlobalConfigs('full');
        startMcpServerBackground();
      }
    }
    process.exit(0);
  }

  // --channel：启动 Channel MCP 代理（stdio）
  // 注意：必须在 --debug 之前检查，否则 --channel --debug 会先触发 HTTP Server
  // --setup --channel 已在上方处理，这里不拦截
  if (args.includes('--channel') && !args.includes('--setup')) {
    // 检查 HTTP MCP 的 debug 标记文件
    const debugFile = path.join(os.homedir(), '.wecom-aibot-mcp', 'debug');
    const isDebug = fs.existsSync(debugFile) || args.includes('--debug');

    if (isDebug) {
      console.log('[channel] Debug 模式：日志输出到 stderr（跟随 HTTP MCP debug）');
      if (!fs.existsSync(debugFile)) {
        fs.writeFileSync(debugFile, 'true');
      }
    }

    console.log('[channel] Starting Channel MCP Proxy...');
    const { startChannelServer } = await import('./channel-server.js');
    await startChannelServer();

    // Channel MCP 退出时不删除 debug 文件（由 HTTP MCP 管理）
    return; // 保持运行，不 exit
  }

  // --debug：前台启动，日志直接输出到终端
  if (args.includes('--debug')) {
    console.log('[mcp] Debug 模式：前台运行，Ctrl+C 退出');
    await startMcpServerForeground(true);
    return;
  }

  // --http-only：仅启动 HTTP Server（远程部署场景）
  if (args.includes('--http-only') && !args.includes('--start')) {
    console.log('[mcp] HTTP-only 模式：仅启动 HTTP Server');
    console.log('[mcp] 不写入 MCP 配置（远程部署场景）');
    console.log('[mcp] 使用 --http-only --start 启动服务');
    process.exit(0);
  }

  // --channel-only：仅配置 Channel MCP（本地连接远程 HTTP Server）
  if (args.includes('--channel-only')) {
    const mcpUrl = process.env.MCP_URL;
    if (!mcpUrl) {
      console.log('[mcp] ❌ Channel-only 模式需要指定远程 HTTP MCP 地址');
      console.log('[mcp] 请设置环境变量 MCP_URL:');
      console.log('[mcp]   MCP_URL=http://远程IP:18963 npx @vrs-soft/wecom-aibot-mcp --channel-only');
      process.exit(1);
    }
    console.log(`[mcp] Channel-only 模式：Channel MCP 已配置`);
    console.log(`[mcp] 连接地址: ${mcpUrl}`);
    console.log('[mcp] 请确保远程 HTTP Server 已启动');
    console.log('[mcp] 启动 Channel: npx @vrs-soft/wecom-aibot-mcp --channel');
    process.exit(0);
  }

  // --start：后台启动
  if (args.includes('--start')) {
    startMcpServerBackground();
    process.exit(0);
  }

  const reconfig = args.includes('--config');
  const isInteractive = process.stdin.isTTY; // 是否为用户交互模式

  logger.log('');
  logger.log('  ╔════════════════════════════════════════════════════════╗');
  logger.log(`  ║   企业微信智能机器人 MCP 服务 v${VERSION}                   ║`);
  logger.log('  ║   Claude Code 审批通道                                 ║');
  logger.log('  ╚════════════════════════════════════════════════════════╝');
  logger.log('');

  // 加载统计并清理旧日志（保留 1 小时）
  loadStats();
  cleanupOldLogs(1 / 24);

  // 获取或初始化配置
  let config: WecomConfig;
  let ranWizard = false; // 是否运行了配置向导
  let instanceName = 'wecom-aibot';

  if (reconfig) {
    console.log('[config] 重新配置模式\n');
    const result = await runConfigWizard();
    config = result.config;
    instanceName = result.instanceName;
    ranWizard = true;
  } else {
    // 检查是否已有配置
    const savedConfig = loadConfig();
    if (savedConfig && savedConfig.botId && savedConfig.secret && savedConfig.targetUserId) {
      config = savedConfig;
    } else if (isInteractive) {
      // TTY 模式下没有配置：提示使用 --setup，不再隐式弹向导
      console.log('[config] 未找到机器人配置。');
      console.log('[config] 请运行: npx @vrs-soft/wecom-aibot-mcp --setup');
      process.exit(1);
    } else {
      // 非 TTY 模式（MCP HTTP），必须有配置
      logger.error('[config] 未找到配置，且当前为非交互模式。');
      logger.error('[config] 请在终端运行: npx @vrs-soft/wecom-aibot-mcp --config');
      process.exit(1);
    }
  }

  // 确保 hook 已安装（幂等，每次启动检查）
  ensureHookInstalled();

  // 配置向导模式：验证连接并识别用户 ID
  if (isInteractive && (ranWizard || reconfig)) {
    console.log('[mcp] 验证机器人连接...');

    // 临时建立连接验证凭证
    const tempClient = initClient(config.botId, config.secret, config.targetUserId || 'placeholder', 'temp-validation');
    const connected = await waitForConnection(tempClient, 10000);

    if (!connected) {
      console.log('[mcp] ❌ 连接失败，请检查：');
      console.log('  1. Bot ID 和 Secret 是否正确');
      console.log('  2. 新建机器人需等待约 2 分钟同步');
      console.log('  3. 是否已完成授权（机器人详情 → 可使用权限 → 授权）');
      console.log('\n修复后重新运行: npx @vrs-soft/wecom-aibot-mcp --config');

      tempClient.disconnect();
      process.exit(1);
    }

    // 连接成功
    logger.log('\n[mcp] ✅ 机器人凭证验证成功！');

    // 保存配置（使用原用户 ID 或等待识别）
    if (!config.targetUserId || config.targetUserId === 'placeholder' || config.targetUserId === '') {
      // 新机器人，需要识别用户 ID
      const userId = await detectUserIdFromMessage(tempClient, 180);

      if (!userId) {
        logger.log('\n[mcp] 未能在规定时间内识别用户 ID');
        console.log('[mcp] 请重新运行配置：npx @vrs-soft/wecom-aibot-mcp --config');
        tempClient.disconnect();
        process.exit(1);
      }

      config.targetUserId = userId;
    }

    // 保存最终配置
    saveConfig(config, instanceName);

    logger.log('\n[mcp] ✅ 配置完成！');
    logger.log(`[mcp] 用户 ID: ${config.targetUserId}`);

    // 配置完成后断开连接
    tempClient.disconnect();

    // 首次安装后自动后台启动服务
    logger.log('\n[mcp] 正在后台启动 MCP Server...');
    startMcpServerBackground();
    console.log('[mcp] 请重启 Claude Code 以加载 MCP 服务\n');
    process.exit(0);
  }

  // 已有配置，显示状态并提示启动命令
  showStatus();
  logger.log('\n[mcp] 使用 --start 启动服务，--stop 停止服务');
  console.log('[mcp] 命令: npx @vrs-soft/wecom-aibot-mcp --start\n');
}

main().catch((err) => {
  logger.error('[mcp] 启动失败:', err);
  process.exit(1);
});