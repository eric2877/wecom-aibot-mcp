#!/usr/bin/env node
/**
 * 测试 MCP 工具调用
 */

const http = require('http');

const PORT = 18963;

// 完整的 MCP 初始化流程
async function initSession() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    });

    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const sessionId = res.headers['mcp-session-id'];
        console.log('Init response:', data.substring(0, 200));
        resolve(sessionId);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callTool(toolName, args, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });

    const options = {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Tool response:', data.substring(0, 500));
        resolve(data);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Step 1: 初始化 Session ===');
  const sessionId = await initSession();
  
  if (!sessionId) {
    console.error('ERROR: 未获取到 Session ID');
    return;
  }
  
  console.log('Session ID:', sessionId);

  console.log('\n=== Step 2: 调用 enter_headless_mode ===');
  await callTool('enter_headless_mode', { agent_name: 'Claude' }, sessionId);
}

main().catch(console.error);
