// 本地模拟 OpenAI Responses 流式服务（POST /v1/responses），供真实 dsh web 契约验证使用。
// 零外部依赖，仅使用 Node 内置 http/crypto 模块。
import http from 'node:http';
import { randomUUID } from 'node:crypto';

function extractInputSummary(input) {
  const userTexts = [];
  const toolOutputs = [];
  if (!Array.isArray(input)) return { userTexts, toolOutputs };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    if (item.role === 'user') {
      if (typeof item.content === 'string') {
        userTexts.push(item.content);
      } else if (Array.isArray(item.content)) {
        const parts = item.content
          .filter(p => p && (p.type === 'input_text' || p.type === 'text') && typeof p.text === 'string')
          .map(p => p.text);
        if (parts.length) userTexts.push(parts.join('\n'));
      }
    } else if (item.type === 'function_call_output') {
      toolOutputs.push({ callId: item.call_id, output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
    }
  }
  return { userTexts, toolOutputs };
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendResponsesStream(res, reply) {
  const responseId = `resp_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeSse(res, 'response.created', {
    type: 'response.created',
    response: { id: responseId, status: 'in_progress', output: [] },
  });

  const outputItems = [];
  let outputIndex = 0;

  if (reply.text) {
    const msgId = `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] },
    });
    writeSse(res, 'response.output_text.delta', {
      type: 'response.output_text.delta',
      output_index: outputIndex,
      delta: reply.text,
    });
    const doneItem = {
      type: 'message',
      id: msgId,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: reply.text, annotations: [] }],
    };
    writeSse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: doneItem,
    });
    outputItems.push(doneItem);
    outputIndex += 1;
  }

  for (const call of reply.toolCalls || []) {
    const itemId = `fc_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const callId = call.callId || `call_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const argsJson = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
    writeSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'function_call', id: itemId, call_id: callId, name: call.name, arguments: '' },
    });
    writeSse(res, 'response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      output_index: outputIndex,
      delta: argsJson,
    });
    writeSse(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      output_index: outputIndex,
      arguments: argsJson,
    });
    const doneItem = {
      type: 'function_call',
      id: itemId,
      call_id: callId,
      name: call.name,
      arguments: argsJson,
      status: 'completed',
    };
    writeSse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: doneItem,
    });
    outputItems.push(doneItem);
    outputIndex += 1;
  }

  writeSse(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      output: outputItems,
      usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
    },
  });
  res.end();
}

export async function startMockResponsesServer() {
  const requests = [];
  const auxRequests = [];
  let handler = () => ({ text: 'OK' });
  const waiters = new Set();

  function notifyWaiters() {
    for (const w of [...waiters]) {
      if (w.pred(requests)) {
        waiters.delete(w);
        w.resolve(requests.slice());
      }
    }
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'contract-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !pathname.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${pathname}` } }));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
        return;
      }
      // 过滤 Harness 后台自动标题生成等无工具辅助请求（session-title-llm），避免干扰对话轮次计数与步骤编排。
      const isAuxiliary = !Array.isArray(body.tools) || body.tools.length === 0;
      const { userTexts, toolOutputs } = extractInputSummary(body.input);
      if (isAuxiliary) {
        auxRequests.push({ at: Date.now(), body, userTexts });
        if (!res.writableEnded && !res.destroyed) {
          sendResponsesStream(res, { text: 'Contract Session' });
        }
        return;
      }
      const record = {
        seq: requests.length + 1,
        at: Date.now(),
        body,
        userTexts,
        toolOutputs,
        aborted: false,
      };
      req.on('close', () => {
        if (!res.writableEnded) record.aborted = true;
      });
      requests.push(record);
      notifyWaiters();
      try {
        const reply = await handler(record, requests);
        if (res.writableEnded || res.destroyed) return;
        if (reply && reply.delayMs > 0) {
          await new Promise(r => setTimeout(r, reply.delayMs));
          if (res.writableEnded || res.destroyed) return;
        }
        sendResponsesStream(res, reply || { text: 'OK' });
      } catch (err) {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: String(err) } }));
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    v1Url: `${baseUrl}/v1`,
    requests,
    auxRequests,
    reset(nextHandler) {
      requests.length = 0;
      auxRequests.length = 0;
      handler = nextHandler || (() => ({ text: 'OK' }));
    },
    waitForRequestCount(count, timeoutMs = 15000) {
      if (requests.length >= count) return Promise.resolve(requests.slice());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(entry);
          reject(new Error(`timed out waiting for ${count} mock LLM requests (saw ${requests.length})`));
        }, timeoutMs);
        const entry = {
          pred: list => list.length >= count,
          resolve: list => {
            clearTimeout(timer);
            resolve(list);
          },
        };
        waiters.add(entry);
      });
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}
