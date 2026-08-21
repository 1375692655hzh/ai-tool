// 本地 mock：模拟 new-api/OpenAI 兼容计费接口 + DeepSeek 余额接口，用于验证嗅探
// 运行：npm run mock （监听 127.0.0.1:4789）
const http = require('http');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');

  if (req.headers.authorization !== 'Bearer sk-test') {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  if (u.pathname === '/v1/dashboard/billing/subscription') {
    res.end(JSON.stringify({ hard_limit_usd: 50, plan: { title: 'test' } }));
  } else if (u.pathname === '/v1/dashboard/billing/usage') {
    res.end(JSON.stringify({ total_usage: 1234 })); // 美分 → $12.34，即 24.68%
  } else if (u.pathname === '/user/balance') {
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '36.50', granted_balance: '6.50', topped_up_balance: '30.00' }],
    }));
  } else if (u.pathname === '/api/custom/quota') {
    res.end(JSON.stringify({ code: 0, data: { used: 7.5, total: 30 } }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(4789, '127.0.0.1', () => console.log('mock 服务已启动: http://127.0.0.1:4789 （key: sk-test）'));
