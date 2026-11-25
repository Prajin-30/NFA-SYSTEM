import path from 'path';
import { fileURLToPath } from 'url';
import { createDatabaseBackup, type BackupMetadata } from '../src/services/backupService.js';

export { createDatabaseBackup, type BackupMetadata };

// CLI Execution support
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectCli) {
  createDatabaseBackup()
    .then(({ backupPath, metadata }) => {
      console.log('Database backup successfully generated:');
      console.log(`  Path: ${backupPath}`);
      console.log(`  Checksum (SHA-256): ${metadata.sha256_checksum}`);
      console.log(`  Total Records: ${metadata.total_records}`);
      console.log(`  Financial Balanced: ${metadata.financial_integrity_check.balanced}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Backup generation failed:', err);
      process.exit(1);
    });
}
