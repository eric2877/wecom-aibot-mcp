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
  deleteConfig,
  deleteRobotConfigInteractive,
  uninstall,
  addMcpConfig,
  detectUserIdFromMessage,
  ensureHookInstalled,
  listAllRobots,
  ensureGlobalConfigs,
  WecomConfig,
} from './config-wizard.js';
import { initClient, WecomClient } from './client.js';
import { registerTools } from './tools/index.js';
import { startHttpServer, stopHttpServer, HTTP_PORT } from './http-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getAllConnectionStates } from './connection-manager.js';
import { loadStats, cleanupOldLogs } from './connection-log.js';
import { startKeepaliveMonitor, stopKeepaliveMonitor } from './keepalive-monitor.js';
import { logger } from './logger.js';

const VERSION = '1.6.0';
const PID_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'server.pid');

function showHelp() {
  logger.log(`
企业微信智能机器人 MCP 服务 v${VERSION}

安装:
  npx @vrs-soft/wecom-aibot-mcp

用法:
  npx @vrs-soft/wecom-aibot-mcp [选项]

选项:
  --help, -h      显示帮助信息
  --version, -v   显示版本号
  --upgrade       强制升级全局配置（覆盖 MCP 配置、权限、skill）
  --reinstall     重新安装全局配置（删除后重新写入，保留机器人配置）
  --start         启动 MCP Server（后台服务模式）
  --stop          停止 MCP Server
  --debug         前台启动 MCP Server（日志直接输出到终端，用于调试）
  --status        显示服务状态和机器人配置
  --config        重新配置默认机器人（修改 Bot ID / Secret / 目标用户）
  --add           添加新的机器人配置（多机器人场景）
  --list          列出所有已配置的机器人及其占用状态
  --delete [名称] 删除指定的机器人配置（保留 MCP 配置）
  --uninstall     卸载并删除所有配置（包括 MCP 配置、hook、skill）

使用流程:
  1. 首次安装: npx @vrs-soft/wecom-aibot-mcp
     （进入配置向导，完成后自动后台启动服务）

  2. 已有配置: npx @vrs-soft/wecom-aibot-mcp
     （显示状态，提示使用 --start 启动）

  3. 启动服务: npx @vrs-soft/wecom-aibot-mcp --start
     （后台启动 MCP HTTP Server）

  4. 停止服务: npx @vrs-soft/wecom-aibot-mcp --stop

MCP 配置（HTTP Transport）:

  编辑 ~/.claude.json：

  {
    "mcpServers": {
      "wecom-aibot": {
        "type": "http",
        "url": "http://127.0.0.1:18963/mcp"
      }
    }
  }

更多信息: https://github.com/eric2877/wecom-aibot-mcp
`);
}

function showVersion() {
  logger.log(`wecom-aibot-mcp v${VERSION}`);
}

function showStatus() {
  const allRobots = listAllRobots();
  const connections = getAllConnectionStates();

  // 检查服务是否运行
  const serverRunning = isServerRunning();
  logger.log(`\n服务状态: ${serverRunning ? '✅ 运行中' : '❌ 未启动'}\n`);

  if (allRobots.length === 0) {
    logger.log('尚未配置机器人，请运行 npx @vrs-soft/wecom-aibot-mcp 启动配置向导');
    return;
  }

  // 构建机器人占用信息
  const robotUsage = new Map<string, { agentName: string }>();
  for (const conn of connections) {
    if (conn.agentName) {
      robotUsage.set(conn.robotName, { agentName: conn.agentName });
    }
  }

  logger.log(`已配置 ${allRobots.length} 个机器人:\n`);

  for (const robot of allRobots) {
    const usage = robotUsage.get(robot.name);
    const statusTag = usage ? ` [使用中]` : '';

    logger.log(`  ${robot.name}${statusTag}`);
    logger.log(`    Bot ID:     ${robot.botId}`);
    logger.log(`    目标用户:   ${robot.targetUserId}`);
    if (usage) {
      logger.log(`    使用者:     ${usage.agentName}`);
    }
    logger.log('');
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
    logger.log('[mcp] 服务未运行');
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
    logger.log('[mcp] 服务已停止');
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
async function startMcpServerForeground(): Promise<void> {
  const savedConfig = loadConfig();
  if (!savedConfig || !savedConfig.botId || !savedConfig.secret || !savedConfig.targetUserId) {
    logger.error('[mcp] 未找到配置，请先运行: npx @vrs-soft/wecom-aibot-mcp');
    process.exit(1);
  }

  // 写入 PID 文件
  fs.writeFileSync(PID_FILE, String(process.pid));

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

  logger.log(`[mcp] 启动 MCP HTTP Server (端口: ${HTTP_PORT})...`);
  await startHttpServer(server);

  startKeepaliveMonitor();

  logger.log(`[mcp] MCP Server 已就绪`);
  logger.log(`[mcp] HTTP endpoint: http://127.0.0.1:${HTTP_PORT}/mcp`);
  logger.log(`[mcp] 健康检查: http://127.0.0.1:${HTTP_PORT}/health`);
  logger.log(`[mcp] 微信模式：enter_headless_mode 时建立连接`);
  logger.log(`[mcp] PID: ${process.pid}`);

  // 退出处理
  const gracefulShutdown = () => {
    logger.log('[mcp] 正在关闭...');
    stopKeepaliveMonitor();
    stopHttpServer();
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
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
    logger.log('[mcp] 服务已在运行中');
    return;
  }

  const nodePath = process.execPath;
  const scriptPath = process.argv[1];

  const child = spawn(nodePath, [scriptPath, '--start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
  });

  child.unref();

  logger.log('[mcp] MCP Server 已在后台启动');
  logger.log(`[mcp] HTTP endpoint: http://127.0.0.1:18963/mcp`);
  logger.log('[mcp] 健康检查: curl http://127.0.0.1:18963/health');
  logger.log('[mcp] 停止服务: npx @vrs-soft/wecom-aibot-mcp --stop');
  logger.log('[mcp] 调试模式: npx @vrs-soft/wecom-aibot-mcp --debug');
}

async function main() {
  const args = process.argv.slice(2);

  // --reinstall 命令需要先删除再安装，跳过开头的 ensureGlobalConfigs
  if (!args.includes('--reinstall')) {
    // 强制覆盖所有全局配置（不依赖智能体）
    ensureGlobalConfigs();
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
    logger.log('\n[mcp] ✅ 全局配置已更新完成！');
    logger.log('[mcp] 配置位置:');
    logger.log('  - ~/.claude.json (MCP Server 配置)');
    logger.log('  - ~/.claude/settings.local.json (权限和 Hook)');
    logger.log('  - ~/.claude/skills/headless-mode/ (Skill)');
    logger.log('  - ~/.wecom-aibot-mcp/version.json (版本记录)');
    logger.log('\n[mcp] 请重启 Claude Code 以加载最新配置');
    process.exit(0);
  }

  // --reinstall 命令：删除所有全局配置（保留机器人配置）后重新安装
  if (args.includes('--reinstall')) {
    logger.log('\n[mcp] 重新安装全局配置...');
    logger.log('[mcp] 保留所有机器人配置: ~/.wecom-aibot-mcp/config.json 和 robot-*.json');

    const CLAUDE_CONFIG_FILE = path.join(os.homedir(), '.claude.json');
    const CLAUDE_SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.local.json');
    const SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'headless-mode');
    const VERSION_FILE = path.join(os.homedir(), '.wecom-aibot-mcp', 'version.json');
    const HOOK_SCRIPT = path.join(os.homedir(), '.wecom-aibot-mcp', 'permission-hook.sh');

    // 1. 删除 ~/.claude.json 中的 wecom-aibot 配置
    if (fs.existsSync(CLAUDE_CONFIG_FILE)) {
      const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
      const config = JSON.parse(content);
      if (config.mcpServers?.['wecom-aibot']) {
        delete config.mcpServers['wecom-aibot'];
        fs.writeFileSync(CLAUDE_CONFIG_FILE, JSON.stringify(config, null, 2));
        logger.log('[mcp] 已删除 ~/.claude.json 中的 wecom-aibot 配置');
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
        logger.log('[mcp] 已删除 wecom-aibot 工具权限');
      }
      if (config.hooks?.PermissionRequest) {
        config.hooks.PermissionRequest = config.hooks.PermissionRequest.filter(
          (h: any) => !h.hooks?.some?.((hook: any) => hook.command?.includes?.('wecom-aibot-mcp'))
        );
        if (config.hooks.PermissionRequest.length === 0) {
          delete config.hooks.PermissionRequest;
        }
        logger.log('[mcp] 已删除 PermissionRequest hook');
      }
      fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(config, null, 2));
    }

    // 3. 删除 skill 目录
    if (fs.existsSync(SKILL_DIR)) {
      fs.rmSync(SKILL_DIR, { recursive: true });
      logger.log('[mcp] 已删除 ~/.claude/skills/headless-mode/');
    }

    // 4. 删除版本文件
    if (fs.existsSync(VERSION_FILE)) {
      fs.unlinkSync(VERSION_FILE);
      logger.log('[mcp] 已删除 ~/.wecom-aibot-mcp/version.json');
    }

    // 5. 删除 hook 脚本
    if (fs.existsSync(HOOK_SCRIPT)) {
      fs.unlinkSync(HOOK_SCRIPT);
      logger.log('[mcp] 已删除 ~/.wecom-aibot-mcp/permission-hook.sh');
    }

    // 6. 重新安装全局配置
    logger.log('\n[mcp] 正在重新安装...');
    ensureGlobalConfigs();

    logger.log('\n[mcp] ✅ 重新安装完成！');
    logger.log('[mcp] 请重启 Claude Code 以加载最新配置');
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

  // --uninstall 命令：先停止服务再卸载
  if (args.includes('--uninstall')) {
    if (isServerRunning()) {
      logger.log('[mcp] 正在停止服务...');
      stopServer();
    }
    uninstall();
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

  // --debug：前台启动，日志直接输出到终端
  if (args.includes('--debug')) {
    logger.log('[mcp] Debug 模式：前台运行，Ctrl+C 退出');
    // 写入 debug 标记文件，hook 脚本检测后日志输出到 stderr
    const debugFile = path.join(os.homedir(), '.wecom-aibot-mcp', 'debug');
    fs.writeFileSync(debugFile, 'true');
    await startMcpServerForeground();
    // 退出时删除标记文件
    fs.unlinkSync(debugFile);
    return;
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
    logger.log('[config] 重新配置模式\n');
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
      // TTY 模式下没有配置，启动配置向导
      logger.log('[config] 未找到配置，启动配置向导...\n');
      const result = await runConfigWizard();
      config = result.config;
      instanceName = result.instanceName;
      ranWizard = true;
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
    logger.log('[mcp] 验证机器人连接...');

    // 临时建立连接验证凭证
    const tempClient = initClient(config.botId, config.secret, config.targetUserId || 'placeholder', 'temp-validation');
    const connected = await waitForConnection(tempClient, 10000);

    if (!connected) {
      logger.log('[mcp] 连接失败，可能是配置错误或机器人未授权');
      logger.log('[mcp] 请检查上面的错误提示，修复后重新配置');

      // 删除无效配置，让用户重新输入
      deleteConfig();

      logger.log('\n请检查：');
      logger.log('  1. Bot ID 和 Secret 是否正确');
      logger.log('  2. 新建机器人需等待约 2 分钟同步');
      logger.log('  3. 是否已完成授权（机器人详情 → 可使用权限 → 授权）');
      logger.log('\n修复后重新运行: npx @vrs-soft/wecom-aibot-mcp --config');

      tempClient.disconnect();
      process.exit(1);
    }

    // 连接成功
    logger.log('\n[mcp] ✅ 机器人连接成功！');

    // 提示用户发送消息来识别用户 ID
    const userId = await detectUserIdFromMessage(tempClient, 180);

    if (!userId) {
      logger.log('\n[mcp] 未能在规定时间内识别用户 ID');
      logger.log('[mcp] 请重新运行配置：npx @vrs-soft/wecom-aibot-mcp --config');
      tempClient.disconnect();
      process.exit(1);
    }

    // 更新配置中的用户 ID
    config.targetUserId = userId;

    // 保存最终配置
    saveConfig(config, instanceName);

    logger.log('\n[mcp] ✅ 配置完成！');
    logger.log(`[mcp] 用户 ID: ${userId}`);

    // 配置完成后断开连接
    tempClient.disconnect();

    // 首次安装后自动后台启动服务
    logger.log('\n[mcp] 正在后台启动 MCP Server...');
    startMcpServerBackground();
    logger.log('[mcp] 请重启 Claude Code 以加载 MCP 服务\n');
    process.exit(0);
  }

  // 已有配置，显示状态并提示启动命令
  showStatus();
  logger.log('\n[mcp] 使用 --start 启动服务，--stop 停止服务');
  logger.log('[mcp] 命令: npx @vrs-soft/wecom-aibot-mcp --start\n');
}

main().catch((err) => {
  logger.error('[mcp] 启动失败:', err);
  process.exit(1);
});