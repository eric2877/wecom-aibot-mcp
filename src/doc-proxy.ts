/**
 * 文档 MCP 代理模块
 *
 * 将文档工具调用代理转发到机器人专属的企业微信文档 MCP 服务（StreamableHTTP）。
 * 每次调用建立独立连接，无需维护长连接状态。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from './logger.js';

export interface DocToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * 调用机器人文档 MCP 工具
 *
 * @param docMcpUrl  机器人专属的文档 MCP URL（含 uaKey）
 * @param toolName   工具名称，如 create_doc、smartsheet_add_records 等
 * @param args       工具参数
 */
export async function callDocTool(
  docMcpUrl: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<DocToolResult> {
  const client = new Client(
    { name: 'wecom-aibot-doc-proxy', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    const transport = new StreamableHTTPClientTransport(new URL(docMcpUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: toolName, arguments: args });

    return {
      content: (result.content as Array<{ type: string; text: string }>) ?? [
        { type: 'text', text: JSON.stringify(result) },
      ],
      isError: result.isError as boolean | undefined,
    };
  } catch (err: any) {
    logger.error(`[doc-proxy] 调用 ${toolName} 失败:`, err);
    const message = err?.message ?? String(err);
    return {
      content: [{ type: 'text', text: `文档工具调用失败: ${message}\n\n请检查机器人的文档 MCP URL 是否正确，或该机器人是否已授权文档能力。` }],
      isError: true,
    };
  } finally {
    try {
      await client.close();
    } catch {
      // 关闭时忽略错误
    }
  }
}
