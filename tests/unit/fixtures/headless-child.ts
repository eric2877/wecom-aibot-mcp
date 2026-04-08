/**
 * 子进程测试夹具
 * 用于测试进程退出时的自动清理
 */

import { enterHeadlessMode } from '../../src/headless-state.js';

// 进入 headless 模式
enterHeadlessMode('/test/project', 'test-cc', 'test-robot');

// 通知父进程已进入
if (process.send) {
  process.send('entered');
}

// 保持进程运行直到被终止
setInterval(() => {}, 10000);