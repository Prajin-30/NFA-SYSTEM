import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { securityService } from './securityService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupsDir = path.join(__dirname, '..', '..', 'data', 'backups');

export interface BackupMetadata {
  timestamp: string;
  backup_id: string;
  filename: string;
  sha256_checksum: string;
  total_records: number;
  table_counts: Record<string, number>;
  rpo_target_hours: number;
  rto_target_hours: number;
  financial_integrity_check: {
    total_allocated: number;
    total_approved: number;
    total_pending: number;
    total_available: number;
    balanced: boolean;
  };
}

export async function createDatabaseBackup(): Promise<{ backupPath: string; metadata: BackupMetadata }> {
  if (store.initPromise) {
    await store.initPromise;
  }

  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `bkp_${Date.now()}`;
  const filename = `nfa_backup_${timestamp}.json`;
  const backupPath = path.join(backupsDir, filename);

  const snapshot = JSON.parse(JSON.stringify(store.data));

  // Calculate table record counts
  const tableCounts: Record<string, number> = {};
  let totalRecords = 0;
  for (const [key, val] of Object.entries(snapshot)) {
    if (Array.isArray(val)) {
      tableCounts[key] = val.length;
      totalRecords += val.length;
    }
  }

  // Financial integrity check
  const budgets = snapshot.budgets || [];
  let totalAllocated = 0;
  let totalApproved = 0;
  let totalPending = 0;
  let totalAvailable = 0;
  let balanced = true;

  for (const b of budgets) {
    const allocated = Number(b.allocated_amount || 0);
    const approved = Number(b.approved_amount || 0);
    const pending = Number(b.pending_amount || 0);
    const available = Number(b.available_amount || 0);

    totalAllocated += allocated;
    totalApproved += approved;
    totalPending += pending;
    totalAvailable += available;

    const expectedAvailable = allocated - approved - pending;
    if (Math.abs(available - expectedAvailable) > 0.01) {
      balanced = false;
    }
  }

  const backupData = {
    backup_id: backupId,
    timestamp: new Date().toISOString(),
    schema_version: '12_enterprise_rls_hardening',
    institution: 'CHRIST (Deemed to be University) - CU-NFA System',
    tables: snapshot,
  };

  const jsonString = JSON.stringify(backupData, null, 2);
  const sha256 = crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');

  fs.writeFileSync(backupPath, jsonString, 'utf8');
  fs.writeFileSync(`${backupPath}.sha256`, sha256, 'utf8');

  const metadata: BackupMetadata = {
    timestamp: backupData.timestamp,
    backup_id: backupId,
    filename,
    sha256_checksum: sha256,
    total_records: totalRecords,
    table_counts: tableCounts,
    rpo_target_hours: 24,
    rto_target_hours: 4,
    financial_integrity_check: {
      total_allocated: totalAllocated,
      total_approved: totalApproved,
      total_pending: totalPending,
      total_available: totalAvailable,
      balanced,
    },
  };

  fs.writeFileSync(path.join(backupsDir, 'latest_backup_metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  await securityService.logEvent({
    action: 'BACKUP_CREATED',
    resource: 'database',
    resource_id: backupId,
    status: 'SUCCESS',
    severity: 'LOW',
    details: {
      filename,
      sha256,
      total_records: totalRecords,
      financial_balanced: balanced,
    },
  });

  return { backupPath, metadata };
}
