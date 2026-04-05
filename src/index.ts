/**
 * MCP Server 模块入口
 *
 * 可作为库导入使用
 *
 * 使用 HTTP Transport，支持多客户端连接
 */

// Client 模块
export { WecomClient, initClient } from './client.js';

// ClientPool 模块
export {
  getOrCreateClient,
  getClient,
  getAllClients,
  getAllProjectDirs,
  setConfig,
  getConfig,
  removeClient,
  clearAll,
  getStats,
} from './client-pool.js';
export type { WecomConfig } from './client-pool.js';

// 项目配置模块
export {
  loadProjectConfig,
  saveProjectConfig,
  deleteProjectConfig,
  loadGlobalConfig,
  getConfig as getProjectConfig,
  hasProjectConfig,
  getConfigSource,
  listConfiguredProjects,
  validateConfig,
} from './project-config.js';
export type { ProjectConfig } from './project-config.js';

// Headless 状态模块
export {
  enterHeadlessMode,
  exitHeadlessMode,
  loadHeadlessState,
  isHeadlessMode,
  cleanupOrphanFiles,
  getAllHeadlessStates,
  getHeadlessFilePath,
} from './headless-state.js';
export type { HeadlessState } from './headless-state.js';

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