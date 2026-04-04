#!/usr/bin/env node
/**
 * test-dialog.mjs
 * 手动测试 MCP 对话框闭环：连接 SSE → 发送 tools/call → 等待用户响应 → 打印结果
 *
 * 使用方法：
 *   node scripts/test-dialog.mjs [port]
 *   默认 port: 3456
 */

const PORT = process.argv[2] ?? '3456';
const BASE = `http://127.0.0.1:${PORT}`;

console.log(`[test-dialog] 连接到 ${BASE}/sse ...`);

// Step 1: 连接 SSE 获取 sessionId
let sessionId = '';
const sseRes = await fetch(`${BASE}/sse`, {
  headers: { Accept: 'text/event-stream' }
});

if (!sseRes.ok) {
  console.error(`[test-dialog] SSE 连接失败: ${sseRes.status}`);
  process.exit(1);
}

const reader = sseRes.body.getReader();
const dec = new TextDecoder();
let buffer = '';

// 读取 SSE 直到拿到 endpoint event
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += dec.decode(value, { stream: true });

  // 解析 SSE events
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';

  let eventType = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (eventType === 'endpoint') {
        // data 格式: /message?sessionId=<sid>
        const m = data.match(/sessionId=([^\s&]+)/);
        if (m) {
          sessionId = m[1];
          console.log(`[test-dialog] 获得 sessionId: ${sessionId}`);
        }
      }
    } else if (line === '') {
      eventType = '';
    }
  }

  if (sessionId) break;
}

if (!sessionId) {
  console.error('[test-dialog] 未能获取 sessionId，桥接服务器可能未运行');
  process.exit(1);
}

// Step 2: 发送 initialize
console.log('[test-dialog] 发送 MCP initialize ...');
await fetch(`${BASE}/message?sessionId=${sessionId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-dialog-script', version: '1.0' }
    }
  })
});

// Step 3: 发送 notifications/initialized
await fetch(`${BASE}/message?sessionId=${sessionId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  })
});

// Step 4: 发送 tools/call 触发对话框
console.log('[test-dialog] 发送 tools/call（触发对话框）...');
const toolsCallRes = await fetch(`${BASE}/message?sessionId=${sessionId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: '__TOOL_NAME__',  // 实际工具名由桥接服务器自动匹配
      arguments: {
        summary: '## 测试对话框\n\n这是来自 `test-dialog.mjs` 的测试请求。\n\n请选择一个选项或输入自定义回复：',
        options: ['✅ 确认', '❌ 取消', '🔄 重试'],
        is_markdown: true
      }
    }
  })
});

console.log(`[test-dialog] tools/call HTTP 状态: ${toolsCallRes.status}`);
console.log('[test-dialog] 对话框已弹出，等待用户在侧边栏回复 ...\n');

// Step 5: 监听 SSE 接收工具调用的响应
console.log('[test-dialog] 监听 SSE 响应（Ctrl+C 取消）...');
let responseBuffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) {
    console.log('[test-dialog] SSE 连接已关闭');
    break;
  }

  responseBuffer += dec.decode(value, { stream: true });
  const lines2 = responseBuffer.split('\n');
  responseBuffer = lines2.pop() ?? '';

  for (const line of lines2) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      try {
        const json = JSON.parse(data);
        if (json.id === 2 && json.result) {
          // 这是 tools/call 的响应
          const text = json.result?.content?.[0]?.text ?? JSON.stringify(json.result);
          console.log(`\n[test-dialog] ✅ 用户回复: "${text}"`);
          console.log('[test-dialog] 测试完成！');
          process.exit(0);
        } else if (json.id === 2 && json.error) {
          console.error(`\n[test-dialog] ❌ 工具调用出错: ${JSON.stringify(json.error)}`);
          process.exit(1);
        }
      } catch {
        // 非 JSON 数据（如 status 事件），忽略
      }
    }
  }
}
