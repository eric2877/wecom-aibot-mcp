/**
 * MCP Server 模块入口
 *
 * 可作为库导入使用
 *
 * v2.0 架构变更：
 * - 使用 Session 管理
 * - 不再使用 projectDir
 * - robotName 作为连接索引
 */

// Client 模块
export { WecomClient, initClient } from './client.js';

// 连接管理模块
export {
  connectRobot,
  disconnectRobot,
  getClient,
  getConnectionState,
  getAllConnectionStates,
} from './connection-manager.js';

// HTTP 服务模块
export {
  startHttpServer,
  stopHttpServer,
  HTTP_PORT,
  HOOK_SCRIPT_PATH,
} from './http-server.js';
export type { ApprovalRequest } from './http-server.js';

// 工具注册
export { registerTools } from './tools/index.js';

// 配置向导
export { listAllRobots, runConfigWizard } from './config-wizard.js';