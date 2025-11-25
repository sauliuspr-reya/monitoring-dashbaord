import type { NextApiRequest, NextApiResponse } from 'next';
import { promises as fs } from 'fs';
import path from 'path';
import { getDbPool } from '@/lib/db/connection';

const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { filename, filenames } = req.body;

  // Handle bulk delete
  if (filenames && Array.isArray(filenames)) {
    const results: { filename: string; success: boolean; error?: string }[] = [];
    
    for (const file of filenames) {
      try {
        await deleteBackupFile(file);
        results.push({ filename: file, success: true });
      } catch (err: any) {
        results.push({ filename: file, success: false, error: err.message });
      }
    }

    const allSuccess = results.every(r => r.success);
    return res.status(allSuccess ? 200 : 207).json({
      success: allSuccess,
      results,
      deleted: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });
  }

  // Handle single delete
  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ error: 'Filename required' });
  }

  try {
    await deleteBackupFile(filename);
    res.status(200).json({ success: true, message: `Deleted ${filename}` });
  } catch (err: any) {
    console.error('[delete-file] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete backup file' });
  }
}

async function deleteBackupFile(filename: string): Promise<void> {
  // Validate filename - prevent path traversal
  const sanitized = path.basename(filename);
  if (sanitized !== filename) {
    throw new Error('Invalid filename');
  }

  const filepath = path.join(BACKUP_DIR, sanitized);

  // Check file exists
  try {
    await fs.access(filepath);
  } catch {
    // File doesn't exist on disk, still try to clean up DB records
    console.warn(`[delete-file] File not found on disk: ${filepath}`);
  }

  // Delete the file
  try {
    await fs.unlink(filepath);
    console.log(`[delete-file] Deleted file: ${filepath}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }

  // Update any associated backup tasks in the database
  try {
    const pool = getDbPool();
    await pool.query(`
      UPDATE backup_tasks 
      SET status = 'deleted', filepath = NULL, file_size = NULL
      WHERE filename = $1 AND task_type = 'backup'
    `, [sanitized]);
  } catch (dbErr) {
    console.warn('[delete-file] Failed to update database:', dbErr);
    // Don't fail the delete if DB update fails
  }
}
