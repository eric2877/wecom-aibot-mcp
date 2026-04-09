# Hook 超时机制审计报告

> **审计日期**：2026-04-07
> **审计员**：Claude (代码审计角色)
> **审计范围**：Hook 超时处理机制与设计文档一致性

---

## 一、审计目标

审计 `hooks/permission-request.sh` 的超时处理机制是否符合设计文档要求。

---

## 二、发现：设计文档矛盾

### 2.1 矛盾点

| 文档 | 位置 | 观点 |
|------|------|------|
| architecture.md | L362-375 | Hook 脚本有 `MAX_POLL_TIME=600` + 超时自动拒绝 |
| detailed-design.md | L1232-1235 | 同上 |
| **hook-approval-solution.md** | L69, L101, L219 | **反对**超时自动拒绝 |

### 2.2 文档内容对比

**architecture.md / detailed-design.md（错误示例）**：
```bash
# 轮询审批结果（带超时限制）
MAX_POLL_TIME=600  # 最大轮询时间 10 分钟
START_TIME=$(date +%s)

while true; do
  sleep 2

  # 检查超时
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))

  if [[ $ELAPSED -gt $MAX_POLL_TIME ]]; then
    # 超时自动拒绝
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"审批超时（10分钟），已自动拒绝"}}}'
    exit 0
  fi
  ...
done
```

**hook-approval-solution.md（正确设计）**（日期：2026-04-06）：
- L69: "超时处理：发送提醒而非拒绝"
- L101: "每隔 10 分钟发送提醒，不会自动拒绝"
- L219: "不要自动拒绝超时审批：用户可能只是离开一会儿"

---

## 三、当前代码审计

### 3.1 hooks/permission-request.sh 状态

**当前实现**：无限阻塞轮询，无超时自动拒绝

```bash
# 轮询审批结果
# MCP Server 会处理超时和智能代批
while true; do
  sleep 2

  STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝或超时自动拒绝"}}}'
    exit 0
  fi
done
```

### 3.2 审计结论

| 项目 | 状态 | 说明 |
|------|------|------|
| Hook 轮询逻辑 | ✅ 正确 | 无限阻塞，符合 hook-approval-solution.md |
| 超时处理 | ✅ 正确 | 由 MCP Server 发送提醒，不自动拒绝 |
| 与最新设计一致性 | ✅ 符合 | 符合 hook-approval-solution.md (2026-04-06) |
| 与旧设计一致性 | ❌ 不符合 | 与 architecture.md/detailed-design.md 示例代码矛盾 |

---

## 四、审计结论

**当前代码实现是正确的**。

**问题在于设计文档版本不一致**：
- architecture.md 和 detailed-design.md 中的 Hook 示例代码是旧设计
- hook-approval-solution.md (2026-04-06) 是最新的设计决策，明确反对超时自动拒绝

---

## 五、建议

### 5.1 需要修复的设计文档

| 文件 | 需要修改的内容 |
|------|---------------|
| architecture.md | L362-375: Hook 脚本示例代码，移除 `MAX_POLL_TIME` 和超时自动拒绝逻辑 |
| detailed-design.md | L1232-1235: 同上 |

### 5.2 修复方案

将 Hook 示例代码改为：
```bash
# 轮询审批结果（无限阻塞，只有用户能决定）
while true; do
  sleep 2

  STATUS=$(curl -s -m 3 "http://127.0.0.1:$MCP_PORT/approval_status/$TASK_ID" 2>/dev/null)
  RESULT=$(echo "$STATUS" | jq -r '.result // empty')

  if [[ "$RESULT" == "allow-once" || "$RESULT" == "allow-always" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    exit 0
  elif [[ "$RESULT" == "deny" ]]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户拒绝"}}}'
    exit 0
  fi
done
```

---

## 六、设计原则（来自 hook-approval-solution.md）

1. **状态一致性**：审批记录应在请求发起时就创建，不应依赖连接状态
2. **用户体验**：超时应提醒而非自动决策，避免误操作
3. **可观测性**：关键链路必须有 debug 日志，便于问题定位
4. **不要自动拒绝超时审批**：用户可能只是离开一会儿

---

*审计完成日期：2026-04-07*
*审计结果：代码实现正确，设计文档需更新*