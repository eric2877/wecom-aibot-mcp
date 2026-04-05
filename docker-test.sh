#!/bin/bash
# Docker 测试脚本
# 测试完整的安装、配置、审批流程

set -e

echo "=== 构建测试镜像 ==="
docker build -t wecom-aibot-mcp-test .

echo ""
echo "=== 测试 1: 查看帮助 ==="
docker run --rm wecom-aibot-mcp-test --help

echo ""
echo "=== 测试 2: 查看状态（未配置） ==="
docker run --rm wecom-aibot-mcp-test --status

echo ""
echo "=== 测试 3: 配置向导（交互式） ==="
echo "需要在真实环境中手动测试，Docker 无法模拟微信消息识别"
echo "手动测试命令："
echo "  docker run -it --rm wecom-aibot-mcp-test --config"

echo ""
echo "=== 测试完成 ==="