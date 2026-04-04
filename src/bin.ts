#!/usr/bin/env node
/**
 * wecom-aibot-mcp - 企业微信智能机器人 MCP 服务
 *
 * npx 运行入口
 */
import { getOrInitConfig, runConfigWizard, loadConfig, saveConfig, ensureHookInstalled, uninstall, WecomConfig } from './config-wizard.js';
import { initClient } from './client.js';
import { registerTools } from './tools/index.js';
import { startHttpServer } from './http-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const VERSION = '1.0.0';

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
  --uninstall     卸载并清除所有配置（彻底移除 MCP）

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

  // 卸载并彻底清除所有配置
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
    // --config 只用于修改已有配置，不能重新安装
    const existingConfig = loadConfig();
    if (!existingConfig) {
      console.log('[config] 未找到已保存的配置');
      console.log('[config] 如需安装，请直接运行: npx @vrs-soft/wecom-aibot-mcp');
      console.log('[config] 或设置环境变量: WECOM_BOT_ID, WECOM_SECRET, WECOM_TARGET_USER');
      process.exit(1);
    }
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