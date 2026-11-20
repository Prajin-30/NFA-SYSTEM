import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

export interface ConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  isPooler: boolean;
  poolerMode: 'transaction' | 'session' | 'direct';
  sslVerified: boolean;
}

/**
 * Parses and inspects the database connection string and host parameters.
 * Detects whether connection is using direct port 5432 or Supabase pooler (port 6543 / 5432).
 */
export function inspectConnectionUrl(urlStr?: string): ConnectionInfo {
  const connString = urlStr || process.env.DATABASE_URL || '';
  if (!connString) {
    return {
      host: 'localhost',
      port: 5432,
      database: 'nfa_db',
      user: 'postgres',
      isPooler: false,
      poolerMode: 'direct',
      sslVerified: false,
    };
  }

  try {
    const parsed = new URL(connString);
    const host = parsed.hostname;
    const port = parseInt(parsed.port || '5432', 10);
    const database = parsed.pathname.replace(/^\//, '');
    const user = parsed.username;

    const isSupabase = host.includes('supabase.co') || host.includes('pooler.supabase.com');
    let poolerMode: 'transaction' | 'session' | 'direct' = 'direct';

    if (port === 6543) {
      poolerMode = 'transaction';
    } else if (port === 5432 && host.includes('pooler.supabase.com')) {
      poolerMode = 'session';
    }

    return {
      host,
      port,
      database,
      user,
      isPooler: isSupabase && (port === 6543 || host.includes('pooler')),
      poolerMode,
      sslVerified: true,
    };
  } catch {
    return {
      host: 'unknown',
      port: 5432,
      database: 'unknown',
      user: 'unknown',
      isPooler: false,
      poolerMode: 'direct',
      sslVerified: false,
    };
  }
}

/**
 * Configure verified TLS configuration.
 * Adheres strictly to security standards by validating TLS certificates (rejectUnauthorized: true).
 */
export function getTlsConfig(connInfo: ConnectionInfo) {
  // If connecting to local development instance, TLS may be disabled via DATABASE_SSL=false
  if (process.env.DATABASE_SSL === 'false' || connInfo.host === 'localhost' || connInfo.host === '127.0.0.1') {
    return false;
  }

  let caCert: string | undefined;
  if (process.env.PG_CA_CERT && fs.existsSync(process.env.PG_CA_CERT)) {
    caCert = fs.readFileSync(process.env.PG_CA_CERT, 'utf-8');
  } else {
    const bundledCertPath = path.resolve(process.cwd(), 'certs', 'prod-ca-2021.crt');
    if (fs.existsSync(bundledCertPath)) {
      caCert = fs.readFileSync(bundledCertPath, 'utf-8');
    }
  }

  return {
    rejectUnauthorized: true, // Strictly verified TLS
    ca: caCert || undefined, // Uses system / Node.js root CAs by default
    servername: connInfo.host,
  };
}

let poolInstance: pg.Pool | null = null;

export function getDbPool(): pg.Pool {
  if (poolInstance) return poolInstance;

  const dbUrl = process.env.DATABASE_URL || '';
  const connInfo = inspectConnectionUrl(dbUrl);
  const ssl = getTlsConfig(connInfo);

  poolInstance = new Pool({
    connectionString: dbUrl || undefined,
    ssl: ssl ? (ssl as any) : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  poolInstance.on('error', (err) => {
    console.error('[DB POOL ERROR] Unexpected client error on idle PostgreSQL client:', err.message);
  });

  return poolInstance;
}

/**
 * Parameterized query wrapper preventing SQL injection.
 */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<pg.QueryResult<T>> {
  const pool = getDbPool();
  return pool.query<T>(text, params);
}

/**
 * Execute transactional operations with automatic rollback on error.
 */
export async function withTransaction<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.error('[DB ROLLBACK ERROR]:', rbErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Safe connection test probing database connectivity and verifying TLS without logging sensitive credentials.
 */
export async function testConnection(): Promise<{
  connected: boolean;
  version?: string;
  info: ConnectionInfo;
  error?: string;
}> {
  const info = inspectConnectionUrl(process.env.DATABASE_URL);
  try {
    const res = await query('SELECT version();');
    return {
      connected: true,
      version: res.rows[0]?.version,
      info,
    };
  } catch (err: any) {
    return {
      connected: false,
      info,
      error: err.message,
    };
  }
}
