/**
 * Headless 模式工具
 * - enter_headless_mode
 * - exit_headless_mode
 * - check_headless_status
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listAllRobots } from '../config-wizard.js';
import { connectRobot, getClient } from '../connection-manager.js';
import {
  enterHeadlessMode,
  exitHeadlessMode,
  loadHeadlessState,
} from '../headless-state.js';
import {
  registerCcId,
  unregisterCcId,
  isCcIdRegistered,
  getCcIdBinding,
} from '../cc-registry.js';
import { registerActiveCcId, unregisterActiveCcId } from '../http-server.js';

// 项目级 wecom-config.json 接口
interface WecomAibotConfig {
  projectDir: string;
  ccId: string;
  robotName: string;
  autoApprove: boolean;
}

// 写入项目级 wecom-config.json
function writeWecomAibotConfig(projectDir: string, ccId: string, robotName: string, autoApprove: boolean): void {
  const configDir = path.join(projectDir, '.claude');
  const configFile = path.join(configDir, 'wecom-config.json');

  const config: WecomAibotConfig = {
    projectDir,
    ccId,
    robotName,
    autoApprove,
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
}

// 更新 wecom-config.json 的 autoApprove 字段
function updateAutoApprove(projectDir: string, autoApprove: boolean): void {
  const configFile = path.join(projectDir, '.claude', 'wecom-config.json');

  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as WecomAibotConfig;
      config.autoApprove = autoApprove;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
    } catch {
      // 忽略错误
    }
  }
}

// 读取项目级 wecom-config.json
function readWecomAibotConfig(projectDir: string): WecomAibotConfig | null {
  const configFile = path.join(projectDir, '.claude', 'wecom-config.json');

  if (fs.existsSync(configFile)) {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as WecomAibotConfig;
    } catch {
      return null;
    }
  }
  return null;
}

export function registerHeadlessTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // enter_headless_mode
  // ────────────────────────────────────────────
  server.tool(
    'enter_headless_mode',
    '进入微信模式。注册 ccId，绑定机器人，开启消息接收。ccId 建议使用当前项目名称作为唯一标识。',
    {
      ccId: z.string().describe('CC 身份标识（建议使用项目名称，如 my-project）'),
      robotName: z.string().optional().describe('指定机器人名称或序号（多机器人时使用）'),
      projectDir: z.string().optional().describe('项目目录（用于写入 wecom-config.json，默认使用 MCP server cwd）'),
    },
    async ({ ccId, robotName, projectDir }) => {
      const cwd = projectDir || process.cwd();

      // 检查 wecom-config.json 是否有保存的配置
      const savedConfig = readWecomAibotConfig(cwd);
      let finalCcId = ccId;
      let finalRobotName = robotName;

      // 如果配置文件存在，使用保存的 ccId 和 robotName（除非用户明确指定了不同的值）
      if (savedConfig) {
        if (!ccId || ccId === 'auto') {
          finalCcId = savedConfig.ccId;
        }
        if (!robotName) {
          finalRobotName = savedConfig.robotName;
        }
      }

      // 获取可用机器人列表
      const robots = listAllRobots();
      if (robots.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', errorType: 'no_robots', message: '未配置任何机器人，请先运行安装向导' })
          }]
        };
      }

      // 确定要使用的机器人
      let selectedRobot = robots[0].name;

      if (finalRobotName) {
        // 支持按名称或序号选择
        const byIndex = parseInt(finalRobotName);
        if (!isNaN(byIndex) && byIndex >= 1 && byIndex <= robots.length) {
          selectedRobot = robots[byIndex - 1].name;
        } else {
          const found = robots.find(r => r.name === finalRobotName || r.name.includes(finalRobotName!));
          if (!found) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'select_robot',
                  robots: robots.map((r, i) => ({ index: i + 1, name: r.name, status: 'available' })),
                  hint: `未找到机器人「${finalRobotName}」，请从列表中选择`,
                })
              }]
            };
          }
          selectedRobot = found.name;
        }
      } else if (robots.length > 1) {
        // 多机器人时需要选择
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'select_robot',
              robots: robots.map((r, i) => ({ index: i + 1, name: r.name, status: 'available' })),
              hint: '有多个机器人，请调用 enter_headless_mode(ccId, robotName) 指定一个',
            })
          }]
        };
      }

      // 注册 ccId
      const result = registerCcId(finalCcId, selectedRobot);
      if (result === 'occupied') {
        const binding = getCcIdBinding(finalCcId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              errorType: 'ccid_occupied',
              message: `ccId「${finalCcId}」已被占用（绑定机器人：${binding?.robotName}），请换一个 ccId`,
            })
          }]
        };
      }

      // 确保机器人已连接
      const connectResult = await connectRobot(selectedRobot);
      if (!connectResult.success) {
        unregisterCcId(finalCcId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', errorType: 'connect_failed', message: connectResult.error })
          }]
        };
      }

      // 写入 headless 状态文件（供 /approve 端点路由使用）
      enterHeadlessMode(cwd, finalCcId, selectedRobot);

      // 注册到 http-server 的活跃 ccId 列表
      registerActiveCcId(finalCcId);

      // 写入项目级 wecom-config.json（autoApprove: true）
      writeWecomAibotConfig(cwd, finalCcId, selectedRobot, true);

      // 发送确认消息
      const client = connectResult.client!;
      try {
        await client.sendText(`【${finalCcId}】【进度】已进入微信模式，可以开始通过微信交互。`);
      } catch (err) {
        console.warn('[enter_headless_mode] 发送确认消息失败:', err);
      }

      const action = result === 'renewed' ? 'renewed' : 'entered';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: action,
            ccId: finalCcId,
            robotName: selectedRobot,
            message: `已进入微信模式，ccId=${finalCcId}，机器人=${selectedRobot}`,
            heartbeat: { pollTimeout: 30000 },
          })
        }]
      };
    }
  );

  // ────────────────────────────────────────────
  // exit_headless_mode
  // ────────────────────────────────────────────
  server.tool(
    'exit_headless_mode',
    '退出微信模式。注销 ccId，删除 headless 状态文件。',
    {
      ccId: z.string().describe('CC 身份标识'),
      projectDir: z.string().optional().describe('项目目录（用于更新 wecom-config.json，默认使用 MCP server cwd）'),
    },
    async ({ ccId, projectDir }) => {
      if (!isCcIdRegistered(ccId)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', message: `ccId「${ccId}」未注册，可能已退出` })
          }]
        };
      }

      const binding = getCcIdBinding(ccId);
      const robotName = binding?.robotName ?? '';

      // 发送退出通知
      if (robotName) {
        const client = await getClient(robotName);
        if (client) {
          try {
            await client.sendText(`【${ccId}】【进度】已退出微信模式，恢复终端交互。`);
          } catch { /* ignore */ }
        }
      }

      // 清理状态
      unregisterCcId(ccId);
      exitHeadlessMode();

      // 从 http-server 注销 ccId
      unregisterActiveCcId(ccId);

      // 更新项目级 wecom-config.json（autoApprove: false）
      const cwd = projectDir || process.cwd();
      updateAutoApprove(cwd, false);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'exited',
            ccId,
            robotName,
            message: '已退出微信模式',
          })
        }]
      };
    }
  );

  // ────────────────────────────────────────────
  // check_headless_status
  // ────────────────────────────────────────────
  server.tool(
    'check_headless_status',
    '检查 headless 模式状态（调试用）。',
    {
      ccId: z.string().describe('CC 身份标识'),
    },
    async ({ ccId }) => {
      const unregistered = !isCcIdRegistered(ccId);
      const hs = loadHeadlessState();
      const headlessCleared = !hs || hs.agentName !== ccId;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: unregistered && headlessCleared ? 'verified' : 'active',
            ccId,
            checks: { unregistered, headlessCleared },
            currentState: hs,
          })
        }]
      };
    }
  );
}
