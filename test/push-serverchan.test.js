'use strict';

/**
 * Server 酱推送通道（push-serverchan）离线测试。
 *
 * 两条硬要求：
 *   ① 密钥不得出现在任何错误信息里（否则日志/告警就会泄露 SendKey）；
 *   ② 只有服务端明确 `code === 0` 才算「已被接受」，网络异常一律当成「送达状态未知」。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  PushError,
  endpoint,
  receiverId,
  validateResponse,
  defaultTransport,
  send
} = require('../extractor/lib/push-serverchan');

const TURBO_KEY = 'SCTabcdefghijklmn';
const SC3_KEY = 'sctp1234tabcdefghijklmn';

test('通道识别：按 SendKey 前缀选择接口', () => {
  assert.deepStrictEqual(endpoint(TURBO_KEY), {
    provider: 'Turbo',
    url: `https://sctapi.ftqq.com/${TURBO_KEY}.send`
  });
  assert.deepStrictEqual(endpoint(SC3_KEY), {
    provider: 'SC3',
    url: `https://1234.push.ft07.com/send/${SC3_KEY}.send`
  });
});

test('通道识别：非法/空密钥抛错', () => {
  for (const key of ['', '   ', 'not-a-key', 'SCT', 'sctp1234t']) {
    assert.throws(() => endpoint(key), PushError, `应当拒绝：${key}`);
  }
});

test('通道识别：错误信息是通用文案，不回显调用方传入的密钥', () => {
  // 用一段明显不是格式提示的子串，确保断言不会因为「SCT…」这类提示文案而误判。
  const weird = 'zzzz-leaked-key-zzzz';
  try {
    endpoint(weird);
    assert.fail('应当拒绝');
  } catch (error) {
    assert.ok(error instanceof PushError);
    assert.ok(!error.message.includes(weird), '错误信息不能包含密钥');
  }
});

test('接收方标识：稳定、不泄露原文、可用于去重', () => {
  const id = receiverId(TURBO_KEY);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.strictEqual(id, receiverId(TURBO_KEY));
  assert.notStrictEqual(id, receiverId(SC3_KEY));
  assert.ok(!id.includes('SCT'));
});

test('应答校验：只有 code=0 且 HTTP 200 才算成功', () => {
  assert.doesNotThrow(() => validateResponse(200, { code: 0 }));
  for (const [status, data] of [[200, { code: 1 }], [500, { code: 0 }], [200, null], [200, { code: '0' }]]) {
    assert.throws(() => validateResponse(status, data), PushError);
  }
});

test('发送：把 title/desp 表单编码后交给传输层', async () => {
  const calls = [];
  const transport = async (url, form) => {
    calls.push({ url, form });
    return { status: 200, data: { code: 0 } };
  };
  const result = await send(TURBO_KEY, '作业提醒：1 项待处理', '正文\n第二行', { transport });
  assert.strictEqual(result.provider, 'Turbo');
  assert.strictEqual(calls.length, 1);
  const params = new URLSearchParams(calls[0].form);
  assert.strictEqual(params.get('title'), '作业提醒：1 项待处理');
  assert.strictEqual(params.get('desp'), '正文\n第二行');
});

test('发送：服务端未确认成功 → 抛错', async () => {
  const transport = async () => ({ status: 200, data: { code: 40001 } });
  await assert.rejects(() => send(TURBO_KEY, '标题', '正文', { transport }), PushError);
});

test('发送：标题为空/含换行/超长都在本地拦下，不发请求', async () => {
  let called = 0;
  const transport = async () => {
    called += 1;
    return { status: 200, data: { code: 0 } };
  };
  for (const title of ['', '  ', '第一行\n第二行', 'x'.repeat(101)]) {
    await assert.rejects(() => send(TURBO_KEY, title, '正文', { transport }), PushError);
  }
  assert.strictEqual(called, 0);
});

test('发送：正文超过本地长度上限直接拒绝', async () => {
  let called = 0;
  const transport = async () => {
    called += 1;
    return { status: 200, data: { code: 0 } };
  };
  await assert.rejects(() => send(TURBO_KEY, '标题', 'x'.repeat(30001), { transport }), PushError);
  assert.strictEqual(called, 0);
});

/** 起一个本地桩服务，模拟 Server 酱的应答。 */
async function withStubServer(handler, work) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}/send`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('默认传输：以表单编码 POST，并解析 JSON 应答', async () => {
  let seen = null;
  await withStubServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen = { method: req.method, type: req.headers['content-type'], body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { pushid: 'x' } }));
    });
  }, async (url) => {
    const result = await defaultTransport(url, new URLSearchParams({ title: '标题', desp: '正文' }).toString());
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.data.code, 0);
  });
  assert.strictEqual(seen.method, 'POST');
  assert.match(seen.type, /application\/x-www-form-urlencoded/);
  assert.strictEqual(new URLSearchParams(seen.body).get('title'), '标题');
  assert.strictEqual(new URLSearchParams(seen.body).get('desp'), '正文');
});

test('默认传输：应答不是 JSON → 报「送达状态未知」', async () => {
  await withStubServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>502 Bad Gateway</html>');
  }, async (url) => {
    await assert.rejects(
      () => defaultTransport(url, 'title=x'),
      (error) => {
        assert.ok(error instanceof PushError);
        assert.match(error.message, /无法解析/);
        return true;
      }
    );
  });
});

test('默认传输：连不上时不把 URL（可能含密钥）带进错误信息', async () => {
  await assert.rejects(
    () => defaultTransport('http://127.0.0.1:1/SCTleakme123.send', 'title=x'),
    (error) => {
      assert.ok(error instanceof PushError);
      assert.ok(!error.message.includes('SCTleakme123'), '错误信息不能包含密钥');
      return true;
    }
  );
});

test('发送：传输层抛错时不泄露密钥', async () => {
  const transport = async () => {
    throw new Error(`fetch failed: https://sctapi.ftqq.com/${TURBO_KEY}.send`);
  };
  await assert.rejects(
    () => send(TURBO_KEY, '标题', '正文', { transport }),
    (error) => {
      assert.ok(error instanceof PushError);
      assert.ok(!error.message.includes(TURBO_KEY), '错误信息不能包含密钥');
      return true;
    }
  );
});
