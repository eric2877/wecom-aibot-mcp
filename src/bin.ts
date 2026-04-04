#!/usr/bin/env node
/**
 * wecom-aibot-mcp - 企业微信智能机器人 MCP 服务
 *
 * npx 运行入口
 */
import * as readline from 'readline';
import { getOrInitConfig, runConfigWizard, loadConfig, saveConfig, deleteConfig, uninstall, ensureHookInstalled, WecomConfig } from './config-wizard.js';
import { initClient, WecomClient } from './client.js';
import { registerTools } from './tools/index.js';
import { startHttpServer } from './http-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const VERSION = '1.0.0';

// 等待连接验证（最多等待 10 秒）
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
  --config        重新配置（修改 Bot ID / Secret / 目标用户）
  --status        显示当前配置状态
  --uninstall     卸载并删除所有配置（包括 MCP 配置、hook、skill）

配置方式（按优先级）:
  1. 环境变量（推荐多实例场景）:
     WECOM_BOT_ID      机器人 ID
     WECOM_SECRET      机器人密钥
     WECOM_TARGET_USER 默认目标用户 ID

  2. 首次运行时自动启动配置向导

Claude Code 配置示例:
  在 ~/.claude.json 中添加：

  {
    "mcpServers": {
      "wecom-aibot": {
        "command": "npx",
        "args": ["@vrs-soft/wecom-aibot-mcp"],
        "env": {
          "WECOM_BOT_ID": "your_bot_id",
          "WECOM_SECRET": "your_secret",
          "WECOM_TARGET_USER": "your_userid"
        }
      }
    }
  }

多用户/多机器人配置:
  不同用户使用不同机器人，配置多个实例：

  {
    "mcpServers": {
      "wecom-aibot-user1": {
        "command": "npx",
        "args": ["@vrs-soft/wecom-aibot-mcp"],
        "env": {
          "WECOM_BOT_ID": "bot_user1",
          "WECOM_SECRET": "secret_user1",
          "WECOM_TARGET_USER": "user1"
        }
      },
      "wecom-aibot-user2": {
        "command": "npx",
        "args": ["@vrs-soft/wecom-aibot-mcp"],
        "env": {
          "WECOM_BOT_ID": "bot_user2",
          "WECOM_SECRET": "secret_user2",
          "WECOM_TARGET_USER": "user2"
        }
      }
    }
  }

更多信息: https://github.com/eric2877/wecom-aibot-mcp
`);
}

function showVersion() {
  console.log(`wecom-aibot-mcp v${VERSION}`);
}

function showStatus() {
  const config = loadConfig();
  if (config) {
    console.log('当前配置:');
    console.log(`  Bot ID:     ${config.botId}`);
    console.log(`  Secret:     ${config.secret.slice(0, 8)}...${config.secret.slice(-4)}`);
    console.log(`  目标用户:   ${config.targetUserId}`);
  } else {
    console.log('尚未配置，请运行 npx wecom-aibot-mcp 启动配置向导');
  }
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

  if (args.includes('--status')) {
    showStatus();
    process.exit(0);
  }

  if (args.includes('--uninstall')) {
    uninstall();
    process.exit(0);
  }

  const reconfig = args.includes('--config');

  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════╗');
  console.log(`  ║   企业微信智能机器人 MCP 服务 v${VERSION}                   ║`);
  console.log('  ║   Claude Code 审批通道                                 ║');
  console.log('  ╚════════════════════════════════════════════════════════╝');
  console.log('');

  // 获取或初始化配置
  let config: WecomConfig;

  if (reconfig) {
    console.log('[config] 重新配置模式\n');
    config = await runConfigWizard();
  } else {
    config = await getOrInitConfig();
  }

  // 确保 hook 已安装（幂等，每次启动检查）
  ensureHookInstalled();

  // 初始化 WebSocket 客户端
  console.log(`[mcp] 初始化企业微信客户端...`);
  console.log(`[mcp] 默认目标用户: ${config.targetUserId}`);

  const wecomClient = initClient(config.botId, config.secret, config.targetUserId);

  // 等待连接验证
  console.log('[mcp] 等待连接验证...');
  const connected = await waitForConnection(wecomClient, 10000);

  if (!connected) {
    console.log('[mcp] 连接失败，可能是配置错误或机器人未授权');
    console.log('[mcp] 请检查上面的错误提示，修复后重新配置');

    // 删除无效配置，让用户重新输入
    deleteConfig();

    // 非 TTY 模式直接退出
    if (!process.stdin.isTTY) {
      console.log('[mcp] 当前为非交互模式，请手动修复配置后重试');
      process.exit(1);
    }

    // TTY 模式询问是否重新配置
    console.log('\n是否重新配置？(Y/n): ');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('', (a) => resolve(a.trim().toLowerCase()));
    });
    rl.close();

    if (answer !== 'n') {
      console.log('\n[mcp] 启动重新配置...\n');
      config = await runConfigWizard();
      // 重新初始化并验证连接
      const newClient = initClient(config.botId, config.secret, config.targetUserId);
      const newConnected = await waitForConnection(newClient, 10000);
      if (!newConnected) {
        console.log('[mcp] 连接仍然失败，请稍后再试（新建机器人需等待约 2 分钟同步）');
        deleteConfig();
        process.exit(1);
      }
      wecomClient.disconnect();
      // 替换客户端引用（需要重新初始化后续服务）
      await startHttpServer(newClient);
      const server = new McpServer({
        name: 'wecom-aibot-mcp',
        version: VERSION,
      });
      registerTools(server, newClient);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      setInterval(() => newClient.cleanupMessages(), 60000);
      console.log('[mcp] MCP Server 已就绪');
      return;
    } else {
      process.exit(1);
    }
  }

  // 启动本地 HTTP 服务（用于 hooks 审批）
  await startHttpServer(wecomClient);

  // 创建 MCP Server
  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: VERSION,
  });

  // 注册工具
  registerTools(server, wecomClient);

  // 启动 MCP 服务（stdio 模式）
  console.log('[mcp] 启动 MCP Server (stdio)...');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 定期清理过期消息
  setInterval(() => {
    wecomClient.cleanupMessages();
  }, 60000);

  console.log('[mcp] MCP Server 已就绪');
}

main().catch((err) => {
  console.error('[mcp] 启动失败:', err);
  process.exit(1);
});