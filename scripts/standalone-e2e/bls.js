// Minimal Business Logic Server used by the container-based standalone E2E
// test. Accepts POST /handle-packet, auto-fulfills, and tracks received
// requests in memory. GET /received returns the captured list so the test can
// assert what was forwarded.
//
// Stdlib-only — runs on any `node:22-alpine` container without `npm install`.

'use strict';

const http = require('http');

const PORT = Number.parseInt(process.env.PORT || '3100', 10);
const received = [];

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/received') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: received.length, received }));
    return;
  }

  if (req.method === 'POST' && req.url === '/handle-packet') {
    try {
      const body = await readJson(req);
      received.push({
        destination: body.destination,
        amount: body.amount,
        paymentId: body.paymentId,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accept: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ accept: false, rejectReason: { code: 'F01', message: String(err) } })
      );
    }
    return;
  }

  // Tier-3 proof endpoint: the BLS forwards an admin-API call to the connector
  // over the docker-compose bridge network. The connector's IP allowlist must
  // accept the BLS's bridge IP; its admin port is NOT published on the host.
  // Set CONNECTOR_ADMIN_URL at container start to point at the connector.
  if (req.method === 'POST' && req.url === '/trigger-admin-send') {
    try {
      const body = await readJson(req);
      const adminUrl = process.env.CONNECTOR_ADMIN_URL;
      if (!adminUrl) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CONNECTOR_ADMIN_URL not set' }));
        return;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.ADMIN_API_KEY) {
        headers['X-Api-Key'] = process.env.ADMIN_API_KEY;
      }
      const adminRes = await fetch(`${adminUrl}/admin/ilp/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          destination: body.destination,
          amount: body.amount ?? '0',
          data: body.data ?? '',
        }),
      });
      const text = await adminRes.text();
      res.writeHead(adminRes.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'admin call failed', message: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`BLS listening on 0.0.0.0:${PORT}`);
});
