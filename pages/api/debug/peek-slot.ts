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

    const { slotName, publicationName, limit = 10 } = req.body;

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

        // Check if slot exists and get details
        const slotCheck = await sourcePool.query(`
      SELECT slot_name, plugin, slot_type, active, active_pid, restart_lsn, confirmed_flush_lsn 
      FROM pg_replication_slots 
      WHERE slot_name = $1
    `, [slotName]);

        if (slotCheck.rows.length === 0) {
            return res.status(404).json({ error: `Slot '${slotName}' not found on source database` });
        }

        const slot = slotCheck.rows[0];

        if (slot.active) {
            return res.status(409).json({
                error: `Slot '${slotName}' is currently ACTIVE (PID: ${slot.active_pid}). You cannot peek at an active slot. Stop the subscription first.`,
                slot: slot
            });
        }

        let changes = [];

        // Handle pgoutput plugin which requires options
        if (slot.plugin === 'pgoutput') {
            if (!publicationName) {
                // If no publication provided, we can't peek pgoutput
                // But we can still return the slot details which is valuable
                return res.status(200).json({
                    slot: slot.slot_name,
                    plugin: slot.plugin,
                    active: false,
                    restart_lsn: slot.restart_lsn,
                    confirmed_flush_lsn: slot.confirmed_flush_lsn,
                    count: 0,
                    changes: [],
                    message: 'Cannot peek changes for pgoutput plugin without a publication name. Slot details returned.'
                });
            }

            // Peek binary changes for pgoutput
            // Note: pg_logical_slot_peek_binary_changes returns bytea data. 
            // We might not be able to decode it easily to text, but we can show the LSNs.
            // Actually, let's try peek_changes first, sometimes it works if we pass proto_version
            try {
                const peekResult = await sourcePool.query(`
          SELECT * FROM pg_logical_slot_peek_binary_changes($1, NULL, $2, 'proto_version', '1', 'publication_names', $3)
        `, [slotName, limit, publicationName]);

                changes = peekResult.rows.map(row => ({
                    lsn: row.lsn,
                    xid: row.xid,
                    data: '[Binary Data] (pgoutput)' // We can't easily decode binary pgoutput here without a parser
                }));
            } catch (err: any) {
                console.warn('Failed to peek pgoutput changes:', err);
                // Fallback to just returning slot details
            }
        } else {
            // Default for test_decoding or wal2json
            const peekResult = await sourcePool.query(`
        SELECT * FROM pg_logical_slot_peek_changes($1, NULL, $2)
      `, [slotName, limit]);
            changes = peekResult.rows;
        }

        res.status(200).json({
            slot: slot.slot_name,
            plugin: slot.plugin,
            active: false,
            restart_lsn: slot.restart_lsn,
            confirmed_flush_lsn: slot.confirmed_flush_lsn,
            count: changes.length,
            changes: changes
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
