/**
 * 断线重连测试脚本
 *
 * 用法: node test-disconnect.mjs
 */

import { WecomClient } from './dist/client.js';

const config = {
  botId: 'aibOxGWAfCtyLvh8jE_wIMc7LvPrfAGJBvq',
  secret: 'kyYBv1bJqExhNqTEXG7yRGJxJ9Ux956lIwPjjEp8tbO',
  targetUserId: 'LiuYang',
  robotName: 'ClaudeCode'
};

console.log('=== 断线重连测试 ===\n');
console.log('1. 创建客户端...');
const client = new WecomClient(
  config.botId,
  config.secret,
  config.targetUserId,
  config.robotName
);

console.log('2. 建立 WebSocket 连接...');
client.connect();

console.log('3. 等待连接建立（最多 15 秒）...');

// 等待连接
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error('连接超时'));
  }, 15000);

  const check = () => {
    if (client.isConnected()) {
      clearTimeout(timeout);
      resolve();
    } else {
      setTimeout(check, 500);
    }
  };
  check();
});

console.log('✅ WebSocket 已连接!\n');

// 发送测试消息
console.log('4. 发送测试消息...');
const result = await client.sendText('【测试】WebSocket 连接成功！\n\n现在可以断开网络进行测试。断开后发送的消息会加入队列。');
console.log(`消息发送结果: ${result}\n`);

// 保持运行
console.log('5. 连接已建立，等待断线测试...');
console.log('   按 Ctrl+C 结束\n');

// 保持进程
setInterval(() => {
  if (client.isConnected()) {
    console.log(`[${new Date().toLocaleTimeString()}] 连接正常`);
  } else {
    console.log(`[${new Date().toLocaleTimeString()}] ⚠️ 连接已断开`);
  }
}, 10000);