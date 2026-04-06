/**
 * 断线重连测试脚本
 *
 * 用法: node test-disconnect.ts
 */

import { WecomClient } from './dist/client.js';

const config = {
  botId: 'aibOxGWAfCtyLvh8jE_wIMc7LvPrfAGJBvq',
  secret: 'kyYBv1bJqExhNqTEXG7yRGJxJ9Ux956lIwPjjEp8tbO',
  targetUserId: 'LiuYang',
  robotName: 'ClaudeCode'
};

async function main() {
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

  // 等待连接
  console.log('3. 等待连接建立...');
  await new Promise<void>((resolve, reject) => {
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
  const result = await client.sendText('【测试】WebSocket 连接成功，准备开始断线测试。\n\n请回复 "准备好" 后断开网络。');
  console.log(`消息发送结果: ${result}\n`);

  // 保持运行，等待断线测试
  console.log('5. 等待断线测试...');
  console.log('   - 现在可以断开网络');
  console.log('   - 断开后发送消息会加入队列');
  console.log('   - 恢复网络后会自动重连并发送队列消息');
  console.log('   - 按 Ctrl+C 结束测试\n');

  // 保持进程运行
  process.stdin.resume();
}

main().catch(err => {
  console.error('错误:', err);
  process.exit(1);
});