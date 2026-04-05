#!/usr/bin/env node
/**
 * wecom-aibot-mcp - 企业微信智能机器人 MCP 服务
 *
 * npx 运行入口
 *
 * 支持 HTTP Transport 模式：
 * - 固定端口 18963
 * - 支持多 Claude Code 同时连接
 *
 * 连接管理：
 * - 启动时不建立 WebSocket 连接
 * - enter_headless_mode 时按需建立连接
 * - exit_headless_mode 时断开连接
 */

import {
  runConfigWizard,
  loadConfig,
  saveConfig,
  deleteConfig,
  deleteMcpConfigInteractive,
  uninstall,
  addMcpConfig,
  detectUserIdFromMessage,
  ensureHookInstalled,
  listAllRobots,
  WecomConfig,
} from './config-wizard.js';
import { initClient, WecomClient } from './client.js';
import { registerTools } from './tools/index.js';
import { startHttpServer, HTTP_PORT } from './http-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clearAllProjectHooks, getAllHeadlessStates } from './headless-state.js';
import { loadStats, cleanupOldLogs } from './connection-log.js';
import { startKeepaliveMonitor, stopKeepaliveMonitor } from './keepalive-monitor.js';

const VERSION = '1.0.7';

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
  --config        重新配置默认机器人（修改 Bot ID / Secret / 目标用户）
  --add           添加新的机器人配置（多机器人场景）
  --list          列出所有已配置的机器人
  --delete [名称] 删除指定的机器人配置（无参数则显示列表选择）
  --uninstall     卸载并删除所有配置（包括 MCP 配置、hook、skill）

MCP 配置（HTTP Transport）:

  编辑 ~/.claude.json：

  {
    "mcpServers": {
      "wecom-aibot": {
        "type": "http",
        "url": "http://127.0.0.1:${HTTP_PORT}/mcp"
      }
    }
  }

  注意：使用 HTTP URL 连接，不再是 stdio transport。

项目级配置:
  每个项目可独立配置机器人：

  cd /path/to/your/project
  npx @vrs-soft/wecom-aibot-mcp --config

  配置文件：{项目}/.claude/wecom-aibot/config.json

更多信息: https://github.com/eric2877/wecom-aibot-mcp
`);
}

function showVersion() {
  console.log(`wecom-aibot-mcp v${VERSION}`);
}

function showStatus() {
  const allRobots = listAllRobots();
  const headlessStates = getAllHeadlessStates();

  if (allRobots.length === 0) {
    console.log('尚未配置，请运行 npx @vrs-soft/wecom-aibot-mcp 启动配置向导');
    return;
  }

  // 构建机器人占用信息
  const robotUsage = new Map<string, { agentName: string; projectDir: string }>();
  for (const { state } of headlessStates) {
    if (state.robotName) {
      robotUsage.set(state.robotName, {
        agentName: state.agentName || '未知',
        projectDir: state.projectDir,
      });
    }
  }

  console.log(`已配置 ${allRobots.length} 个机器人:\n`);

  for (const robot of allRobots) {
    const defaultTag = robot.isDefault ? ' (默认)' : '';
    const usage = robotUsage.get(robot.name);
    const statusTag = usage ? ` [使用中]` : '';

    console.log(`  ${robot.name}${defaultTag}${statusTag}`);
    console.log(`    Bot ID:     ${robot.botId}`);
    console.log(`    目标用户:   ${robot.targetUserId}`);
    if (usage) {
      console.log(`    使用者:     ${usage.agentName} (${usage.projectDir})`);
    }
    console.log('');
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

async function main() {
  const args = process.argv.slice(2);

  // 解析命令行参数
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  if (args.includes('--status') || args.includes('--list')) {
    showStatus();
    process.exit(0);
  }

  if (args.includes('--uninstall')) {
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
    const instanceName = args[deleteIndex + 1]; // 可选参数：实例名
    await deleteMcpConfigInteractive(instanceName);
    process.exit(0);
  }

  const reconfig = args.includes('--config');
  const isInteractive = process.stdin.isTTY; // 是否为用户交互模式

  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════╗');
  console.log(`  ║   企业微信智能机器人 MCP 服务 v${VERSION}                   ║`);
  console.log('  ║   Claude Code 审批通道                                 ║');
  console.log('  ╚════════════════════════════════════════════════════════╝');
  console.log('');

  // 加载统计并清理旧日志（保留 1 小时）
  loadStats();
  cleanupOldLogs(1 / 24);  // 保留 1 小时

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
      // TTY 模式下没有配置，启动配置向导
      console.log('[config] 未找到配置，启动配置向导...\n');
      const result = await runConfigWizard();
      config = result.config;
      instanceName = result.instanceName;
      ranWizard = true;
    } else {
      // 非 TTY 模式（MCP HTTP），必须有配置
      console.error('[config] 未找到配置，且当前为非交互模式。');
      console.error('[config] 请在终端运行: npx @vrs-soft/wecom-aibot-mcp --config');
      process.exit(1);
    }
  }

  // 确保 hook 已安装（幂等，每次启动检查）
  ensureHookInstalled();

  // 清理残留的 headless 状态和 Hook 配置
  clearAllProjectHooks();

  // 配置向导模式：验证连接并识别用户 ID
  if (isInteractive && (ranWizard || reconfig)) {
    console.log('[mcp] 验证机器人连接...');

    // 临时建立连接验证凭证
    const tempClient = initClient(config.botId, config.secret, config.targetUserId || 'placeholder');
    const connected = await waitForConnection(tempClient, 10000);

    if (!connected) {
      console.log('[mcp] 连接失败，可能是配置错误或机器人未授权');
      console.log('[mcp] 请检查上面的错误提示，修复后重新配置');

      // 删除无效配置，让用户重新输入
      deleteConfig();

      console.log('\n请检查：');
      console.log('  1. Bot ID 和 Secret 是否正确');
      console.log('  2. 新建机器人需等待约 2 分钟同步');
      console.log('  3. 是否已完成授权（机器人详情 → 可使用权限 → 授权）');
      console.log('\n修复后重新运行: npx @vrs-soft/wecom-aibot-mcp --config');

      tempClient.disconnect();
      process.exit(1);
    }

    // 连接成功
    console.log('\n[mcp] ✅ 机器人连接成功！');

    // 提示用户发送消息来识别用户 ID
    const userId = await detectUserIdFromMessage(tempClient, 180);

    if (!userId) {
      console.log('\n[mcp] 未能在规定时间内识别用户 ID');
      console.log('[mcp] 请重新运行配置：npx @vrs-soft/wecom-aibot-mcp --config');
      tempClient.disconnect();
      process.exit(1);
    }

    // 更新配置中的用户 ID
    config.targetUserId = userId;

    // 保存最终配置
    saveConfig(config, instanceName);

    console.log('\n[mcp] ✅ 配置完成！');
    console.log(`[mcp] 用户 ID: ${userId}`);
    console.log('[mcp] 请重启 Claude Code 以加载 MCP 服务\n');

    // 配置完成后断开连接
    tempClient.disconnect();
    process.exit(0);
  }

  // 创建 MCP Server（不建立 WebSocket 连接）
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  });

  // 注册工具（不传入 client，由 ConnectionManager 管理）
  registerTools(server);

  // 启动 HTTP 服务
  console.log(`[mcp] 启动 MCP HTTP Server (端口: ${HTTP_PORT})...`);
  await startHttpServer(server);

  // 启动保活监控
  startKeepaliveMonitor();

  console.log(`[mcp] MCP Server 已就绪`);
  console.log(`[mcp] HTTP endpoint: http://127.0.0.1:${HTTP_PORT}/mcp`);
  console.log(`[mcp] 健康检查: http://127.0.0.1:${HTTP_PORT}/health`);
  console.log(`[mcp] 微信模式：enter_headless_mode 时建立连接`);

  // 退出处理
  const gracefulShutdown = () => {
    console.log('[mcp] 正在关闭...');
    stopKeepaliveMonitor();
    process.exit(0);
  };

  // 监听进程信号
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

main().catch((err) => {
  console.error('[mcp] 启动失败:', err);
  process.exit(1);
});