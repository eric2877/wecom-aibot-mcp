#!/bin/bash

# 心跳检测功能测试脚本
# 测试场景：CC 离线检测与微信通知

set -e

MCP_URL="http://127.0.0.1:18963"
CONFIG_DIR="$HOME/.wecom-aibot-mcp"
REGISTRY_FILE="$CONFIG_DIR/cc-registry.json"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查 MCP 服务是否运行
check_mcp_server() {
    log_info "检查 MCP 服务..."
    if curl -s "$MCP_URL/health" > /dev/null 2>&1; then
        log_info "✅ MCP 服务运行中"
        return 0
    else
        log_error "❌ MCP 服务未运行，请先启动: npm start"
        return 1
    fi
}

# 检查 cc-registry.json
check_registry() {
    log_info "检查注册表文件..."
    if [ -f "$REGISTRY_FILE" ]; then
        log_info "✅ 注册表文件存在: $REGISTRY_FILE"
        log_info "当前注册内容:"
        cat "$REGISTRY_FILE" | jq '.'
    else
        log_warn "注册表文件不存在"
    fi
}

# 模拟 CC 进入微信模式
enter_headless_mode() {
    local ccId="$1"
    local robotName="$2"

    log_info "模拟 CC 进入微信模式: ccId=$ccId, robot=$robotName"

    # 手动写入注册表（模拟 enter_headless_mode）
    cat > "$REGISTRY_FILE" <<EOF
{
  "$ccId": {
    "robotName": "$robotName",
    "lastActive": $(date +%s)000,
    "createdAt": $(date +%s)000
  }
}
EOF

    log_info "✅ 已写入注册表"
    cat "$REGISTRY_FILE" | jq '.'
}

# 模拟 CC 心跳（更新 lastActive）
touch_heartbeat() {
    local ccId="$1"

    log_info "更新心跳时间: ccId=$ccId"

    # 更新 lastActive
    jq --arg ccId "$ccId" \
       --argjson now "$(date +%s)000" \
       '.[$ccId].lastActive = $now' \
       "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"

    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"

    log_info "✅ 心跳已更新: $(date -r $(jq -r '.["'$ccId'"].lastActive' "$REGISTRY_FILE" | sed 's/...$//') '+%Y-%m-%d %H:%M:%S')"
}

# 模拟 CC 离线（不更新 lastActive）
simulate_offline() {
    local ccId="$1"
    local minutes="$2"

    log_warn "模拟 CC 离线: ccId=$ccId, 时长=${minutes}分钟"
    log_info "将 lastActive 设置为 ${minutes} 分钟前"

    # 计算 ${minutes} 分钟前的时间戳
    local past_time=$(($(date +%s) - minutes * 60))000

    # 更新 lastActive 为过去时间
    jq --arg ccId "$ccId" \
       --argjson past "$past_time" \
       '.[$ccId].lastActive = $past' \
       "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"

    mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"

    log_info "✅ lastActive 已设置为 ${minutes} 分钟前"
    cat "$REGISTRY_FILE" | jq '.'
}

# 等待心跳检测触发
wait_for_heartbeat_check() {
    local max_wait="${1:-360}"  # 默认等待 6 分钟（心跳检测每 5 分钟一次）

    log_info "等待心跳检测触发（最长 ${max_wait} 秒）..."
    log_info "请监控微信，应该收到离线通知消息"

    local waited=0
    local interval=10

    while [ $waited -lt $max_wait ]; do
        echo -n "."
        sleep $interval
        waited=$((waited + interval))
    done

    echo ""
    log_info "已等待 $((waited / 60)) 分钟"
}

# 清理测试数据
cleanup() {
    local ccId="$1"

    log_info "清理测试数据..."

    if [ -f "$REGISTRY_FILE" ]; then
        # 删除测试 ccId
        jq --arg ccId "$ccId" 'del(.[$ccId])' "$REGISTRY_FILE" > "$REGISTRY_FILE.tmp"
        mv "$REGISTRY_FILE.tmp" "$REGISTRY_FILE"
        log_info "✅ 已删除 ccId: $ccId"
    fi
}

# 主测试流程
main() {
    local TEST_CC_ID="test-heartbeat-$$"

    # 获取当前连接的机器人名称
    local TEST_ROBOT=$(curl -s "$MCP_URL/health" | jq -r '.websocket.robotName // empty')

    if [ -z "$TEST_ROBOT" ]; then
        log_error "无法获取机器人名称，请检查 MCP 服务状态"
        exit 1
    fi

    echo "======================================"
    echo "  心跳检测功能测试"
    echo "======================================"
    echo ""
    log_info "使用机器人: $TEST_ROBOT"

    # 1. 检查前置条件
    check_mcp_server || exit 1
    echo ""

    check_registry
    echo ""

    # 2. 准备测试
    log_info "========== 测试场景 1: CC 离线 10 分钟 =========="
    enter_headless_mode "$TEST_CC_ID" "$TEST_ROBOT"
    echo ""

    read -p "$(echo -e ${YELLOW}按回车继续：模拟 CC 离线 10 分钟${NC})"
    simulate_offline "$TEST_CC_ID" 10
    echo ""

    # 3. 等待心跳检测
    log_info "等待心跳检测（5 分钟扫描一次，10 分钟阈值）..."
    log_warn "请在微信中观察是否收到离线通知"
    log_warn "预期消息：【系统警告】CC \"$TEST_CC_ID\" 已超过 10 分钟无心跳..."
    echo ""

    wait_for_heartbeat_check 360
    echo ""

    # 4. 验证结果
    log_info "请检查："
    echo "  1. 是否在微信收到离线通知？"
    echo "  2. 通知内容是否包含 ccId: $TEST_CC_ID"
    echo "  3. lastNotified 字段是否已更新？"
    echo ""
    cat "$REGISTRY_FILE" | jq '.'
    echo ""

    read -p "$(echo -e ${GREEN}测试通过？按回车继续测试场景 2${NC})"
    echo ""

    # 5. 测试场景 2: 避免重复通知
    log_info "========== 测试场景 2: 避免重复通知（30 分钟内） =========="
    log_info "CC 仍然离线，但应该不发送重复通知"
    echo ""

    read -p "$(echo -e ${YELLOW}按回车继续：等待 5 分钟（心跳检测周期）${NC})"
    wait_for_heartbeat_check 300
    echo ""

    log_info "请检查："
    echo "  1. 是否未收到重复的离线通知？"
    echo "  2. lastNotified 字段是否保持不变？"
    echo ""
    cat "$REGISTRY_FILE" | jq '.'
    echo ""

    read -p "$(echo -e ${GREEN}测试通过？按回车继续测试场景 3${NC})"
    echo ""

    # 6. 测试场景 3: CC 恢复心跳
    log_info "========== 测试场景 3: CC 恢复心跳 =========="
    read -p "$(echo -e ${YELLOW}按回车继续：模拟 CC 恢复心跳${NC})"
    touch_heartbeat "$TEST_CC_ID"
    echo ""

    log_info "等待心跳检测..."
    wait_for_heartbeat_check 360
    echo ""

    log_info "请检查："
    echo "  1. CC 恢复心跳后，是否未收到任何通知？"
    echo "  2. lastActive 字段是否已更新？"
    echo ""
    cat "$REGISTRY_FILE" | jq '.'
    echo ""

    read -p "$(echo -e ${GREEN}测试通过？按回车清理测试数据${NC})"
    echo ""

    # 7. 清理
    cleanup "$TEST_CC_ID"

    echo ""
    log_info "======================================"
    log_info "  测试完成！"
    log_info "======================================"
}

# 执行测试
main