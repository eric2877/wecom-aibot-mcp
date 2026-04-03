/**
 * MCP Server 模块入口
 *
 * 可作为库导入使用
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initClient, WecomClient } from './client.js';
import { registerTools } from './tools/index.js';

export interface WecomMcpOptions {
  botId: string;
  secret: string;
  targetUserId: string;
}

export { WecomClient, initClient, registerTools };

/**
 * 创建并启动 MCP Server
 */
export async function createMcpServer(options: WecomMcpOptions): Promise<{
  server: McpServer;
  client: WecomClient;
}> {
  const { botId, secret, targetUserId } = options;

  console.log(`[mcp] 初始化企业微信客户端...`);
  console.log(`[mcp] 默认目标用户: ${targetUserId}`);

  const wecomClient = initClient(botId, secret, targetUserId);

  const server = new McpServer({
    name: 'wecom-aibot-mcp',
    version: '1.0.0',
  });

  registerTools(server, wecomClient);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 定期清理过期消息
  setInterval(() => {
    wecomClient.cleanupMessages();
  }, 60000);

  console.log('[mcp] MCP Server 已就绪');

  return { server, client: wecomClient };
}