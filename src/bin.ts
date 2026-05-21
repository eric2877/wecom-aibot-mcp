#!/usr/bin/env node
/**
 * wecom-aibot-mcp - 企业微信智能机器人 MCP 客户端
 *
 * 连接远程 wecom-aibot-server daemon，为 Claude Code 提供微信消息通道。
 *
 * 运行模式:
 *   --channel   Channel MCP 代理（SSE 唤醒，推荐）
 *   --install   交互式安装向导（配置 daemon 地址 + Token）
 *   --version   版本号
 *   --help      帮助
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { VERSION, runRemoteInstallWizard, uninstall, ensureHookInstalled, getInstalledMode } from './config-wizard.js';
import { startChannelServer } from './channel-server.js';
import { logger } from './logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.wecom-aibot-mcp');

function showHelp() {
  console.log(`
企业微信智能机器人 MCP 客户端 v${VERSION}

安装:
  npx @vrs-soft/wecom-aibot-mcp --install

用法:
  npx @vrs-soft/wecom-aibot-mcp [选项]

选项:
  --help, -h      显示帮助
  --version, -v   显示版本号
  --install       交互式安装向导（配置 daemon 地址 + Auth Token）
  --channel       启动 Channel MCP 代理（stdio，日志写 channel.log）
  --uninstall     卸载并清除所有本地配置

连接模式:
  Channel（推荐）: SSE 长连接，消息到达即唤醒 agent
    配置写入 ~/.claude.json: wecom-aibot-channel
    环境变量: MCP_URL=<daemon 地址>, MCP_AUTH_TOKEN=<token>

  HTTP（直连）: Claude Code 直接连接 daemon /mcp 端点
    安装时选择 HTTP 模式，或手动写入 ~/.claude.json

前提条件:
  需要运行中的 wecom-aibot-server daemon（私有部署）
  daemon 地址示例: https://your-server:18963

更多信息: https://github.com/eric2877/wecom-aibot-mcp
`);
}

function showVersion() {
  console.log(`wecom-aibot-mcp v${VERSION}`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  if (args.includes('--channel')) {
    // Channel MCP 代理模式（由 Claude Code 通过 stdio 启动）
    logger.setLogFile(path.join(CONFIG_DIR, 'channel.log'));
    await startChannelServer();
    return;
  }

  if (args.includes('--install')) {
    await runRemoteInstallWizard();
    process.exit(0);
  }

  if (args.includes('--uninstall')) {
    uninstall();
    process.exit(0);
  }

  // 无参数：检查是否已有配置，否则引导安装
  if (!process.stdin.isTTY) {
    // 非交互式（stdio MCP 模式）：不应出现这种情况，但安全起见给出提示
    logger.error('[mcp] 请通过 --channel 参数启动 Channel MCP 代理');
    process.exit(1);
  }

  // TTY 模式：直接进入安装向导
  const { mode } = getInstalledMode();
  if (mode) {
    console.log(`\n已配置（模式: ${mode}）。重新配置请运行 --install，卸载请运行 --uninstall\n`);
  } else {
    await runRemoteInstallWizard();
  }
}

main().catch((err) => {
  logger.error('[mcp] Fatal error:', err);
  process.exit(1);
});
