/**
 * wecom-aibot-mcp 公共 API
 *
 * 客户端模块入口（channel-server + config）
 */

export { startChannelServer } from './channel-server.js';
export { VERSION, runRemoteInstallWizard, uninstall, getInstalledMode } from './config-wizard.js';
export { logger } from './logger.js';
