import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbPool, createSourceTargetPool } from '@/lib/db/connection';

export default async function handler(
    req: NextApiRequest,
    res: NextApiResponse
) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: `Method ${req.method} not allowed` });
    }

    const { slotName, limit = 10 } = req.body;

    if (!slotName) {
        return res.status(400).json({ error: 'Slot name is required' });
    }

    let sourcePool;

    try {
        // Connect to SOURCE database (where the slot lives)
        // We need to get the source connection string. 
        // For now, we'll assume the default source pool from getDbPool() is NOT the source, 
        // but usually the "monitoring" db. 
        // We need the actual source DB connection.
        // In this project, it seems `getDbPool` returns the monitoring pool?
        // Let's check how other endpoints get the source pool.
        // Usually they get it from a subscription or a saved connection string.
        // Since this is a debug tool, we might need the user to select a subscription or provide a connection string.
        // For simplicity, let's try to find *any* subscription that uses this slot, or just use the default source if defined in env.

        // Strategy: Look up the slot in the `subscriptions` table to find the source connection?
        // Or just use the environment variable `SOURCE_DATABASE_URL` if it exists (common pattern).

        const monitoringPool = getDbPool();

        // Try to find a subscription with this slot to get the connection string
        const subResult = await monitoringPool.query(`
      SELECT source_db_connection FROM subscriptions WHERE slot_name = $1
    `, [slotName]);

        let connectionString = process.env.SOURCE_DATABASE_URL;

        if (subResult.rows.length > 0) {
            connectionString = subResult.rows[0].source_db_connection;
        }

        if (!connectionString) {
            return res.status(400).json({ error: 'Could not determine source database connection. Please ensure a subscription exists for this slot or SOURCE_DATABASE_URL is set.' });
        }

        sourcePool = createSourceTargetPool(connectionString);

        // Check if slot is active
        const slotCheck = await sourcePool.query(`
      SELECT active, active_pid FROM pg_replication_slots WHERE slot_name = $1
    `, [slotName]);

        if (slotCheck.rows.length === 0) {
            return res.status(404).json({ error: `Slot '${slotName}' not found on source database` });
        }

        if (slotCheck.rows[0].active) {
            return res.status(409).json({
                error: `Slot '${slotName}' is currently ACTIVE (PID: ${slotCheck.rows[0].active_pid}). You cannot peek at an active slot. Stop the subscription first.`
            });
        }

        // Peek changes
        // pg_logical_slot_peek_changes(slot_name, up_to_lsn, upto_nchanges, options VARIADIC text[])
        const peekResult = await sourcePool.query(`
      SELECT * FROM pg_logical_slot_peek_changes($1, NULL, $2)
    `, [slotName, limit]);

        res.status(200).json({
            slot: slotName,
            active: false,
            count: peekResult.rows.length,
            changes: peekResult.rows
        });

    } catch (error: any) {
        console.error('Error peeking slot:', error);
        res.status(500).json({
            error: 'Failed to peek slot',
            details: error.message
        });
    } finally {
        if (sourcePool) {
            await sourcePool.end();
        }
    }
}
