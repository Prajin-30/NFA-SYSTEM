import 'dotenv/config';
import http from 'http';
import { Socket } from 'net';
import { app } from '../src/server.js';
import { getDbPool } from '../src/db/pool.js';

function request(options: { method: string; url: string; headers?: Record<string, string>; body?: any }): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const req = new http.IncomingMessage(socket);
    req.method = options.method || 'GET';
    req.url = options.url || '/';
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.headers || {})) {
      hdrs[k.toLowerCase()] = v;
    }
    req.headers = hdrs;
    (req as any).body = options.body;

    const res = new http.ServerResponse(req);
    let chunks: Buffer[] = [];
    res.write = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return true;
    } as any;
    res.end = function (chunk: any) {
      if (chunk) chunks.push(Buffer.from(chunk));
      const str = Buffer.concat(chunks).toString('utf8');
      let parsed: any = str;
      try { parsed = JSON.parse(str); } catch (e) { }
      resolve({ status: res.statusCode, body: parsed });
      return this;
    } as any;

    app.handle(req, res, (err: any) => {
      if (err) reject(err);
    });
  });
}

async function verifyExpressLogin() {
  console.log('=== TESTING EXPRESS POST /api/auth/login WITH INSTITUTIONAL USER ===');
  const pool = getDbPool();
  try {
    const res = await request({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'Content-Type': 'application/json' },
      body: {
        email: 'maryanita.ea@christuniversity.in',
        password: 'Password@123'
      }
    });

    console.log(`HTTP Status: ${res.status}`);
    console.log('Response Body:', {
      tokenReceived: Boolean(res.body?.token),
      user: res.body?.user,
      must_change_password: res.body?.must_change_password
    });

    if (res.status !== 200 || !res.body?.token) {
      throw new Error(`Expected HTTP 200 with JWT token, got ${res.status}: ${JSON.stringify(res.body)}`);
    }

    console.log('EXPRESS POST /api/auth/login VERIFIED SUCCESSFULLY!');
  } finally {
    await pool.end();
  }
}

verifyExpressLogin().catch(console.error);
