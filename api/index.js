
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { put, del } = require('@vercel/blob');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// PostgreSQL Connection
let pool;

const getDB = () => {
    if (!pool) {
        if (!process.env.DATABASE_URL) {
            console.error("DATABASE_URL is missing. API will fail.");
            return null;
        }
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' || process.env.DATABASE_URL.includes('sslmode=require')
                ? { rejectUnauthorized: false }
                : false,
            // Serverless-friendly defaults
            max: parseInt(process.env.PGPOOL_MAX || '3', 10),
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 10000
        });
    }
    return pool;
};

// --- Server-Side Asset Definitions for Normalization ---
const KNOWN_ASSETS = [
    "XAUUSD", "EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF",
    "EURJPY", "GBPJPY", "EURAUD", "EURGBP", "AUDJPY", "CADJPY", "CHFJPY",
    "USOIL", "UKOIL", "XAGUSD", "BTCUSD", "ETHUSD", "XRPUSD", "LTCUSD", "ADAUSD", "SOLUSD", "BNBUSD",
    "US30", "NAS100", "SPX500", "GER30", "UK100", "JP225"
];

// Helper to convert snake_case DB result to camelCase for frontend
const toCamelCase = (row) => {
    const newRow = {};
    for (const key in row) {
        const camelKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
        newRow[camelKey] = row[key];
    }
    return newRow;
};

// Helper to parse trade rows
const parseTradeRow = (row) => {
    const t = toCamelCase(row);
    t.entryPrice = parseFloat(t.entryPrice);
    t.exitPrice = t.exitPrice ? parseFloat(t.exitPrice) : undefined;
    t.pnl = parseFloat(t.pnl);
    t.quantity = parseFloat(t.quantity);
    t.fees = parseFloat(t.fees || '0');
    t.mainPnl = t.mainPnl ? parseFloat(t.mainPnl) : undefined;
    t.stopLoss = t.stopLoss ? parseFloat(t.stopLoss) : undefined;
    t.takeProfit = t.takeProfit ? parseFloat(t.takeProfit) : undefined;
    t.finalStopLoss = t.finalStopLoss ? parseFloat(t.finalStopLoss) : undefined;
    t.finalTakeProfit = t.finalTakeProfit ? parseFloat(t.finalTakeProfit) : undefined;
    t.leverage = t.leverage ? parseFloat(t.leverage) : undefined;
    t.riskPercentage = t.riskPercentage ? parseFloat(t.riskPercentage) : undefined;
    t.balance = t.balance ? parseFloat(t.balance) : undefined;
    
    // New fields
    t.quoteCurrency = row.quote_currency;
    t.fxRateToUsd = row.fx_rate_to_usd ? parseFloat(row.fx_rate_to_usd) : undefined;
    t.plannedRiskQuote = row.planned_risk_quote ? parseFloat(row.planned_risk_quote) : undefined;
    t.plannedRewardQuote = row.planned_reward_quote ? parseFloat(row.planned_reward_quote) : undefined;
    t.plannedRiskUsd = row.planned_risk_usd ? parseFloat(row.planned_risk_usd) : undefined;
    t.plannedRewardUsd = row.planned_reward_usd ? parseFloat(row.planned_reward_usd) : undefined;
    
    // EA Fields
    t.externalTradeId = row.external_trade_id;
    t.rawSymbol = row.raw_symbol;
    t.isPending = row.is_pending;
    t.isBalanceUpdated = row.is_balance_updated;

    return t;
};

const sanitizeNumber = (val) => {
    if (val === '' || val === null || val === undefined) return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
};

// --- EA Helpers ---

const normalizeNumber = (val) => {
    if (val === undefined || val === null || val === '') return null;
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
};

const roundNumber = (val, decimals = 5) => {
    const n = normalizeNumber(val);
    if (n === null) return 0;
    // Handle float precision issues
    return Number(Math.round(n + 'e' + decimals) + 'e-' + decimals);
};

const normalizeSymbolToAssetPair = (rawSymbol) => {
    if (!rawSymbol || typeof rawSymbol !== 'string') return 'UNKNOWN';
    const s = rawSymbol.trim().toUpperCase();

    // 1. Exact Match
    if (KNOWN_ASSETS.includes(s)) return s;

    // 2. Prefix Match (Longest First)
    // Sort assets by length desc to match "US30" before "US" (if that existed)
    const sortedAssets = [...KNOWN_ASSETS].sort((a, b) => b.length - a.length);
    for (const asset of sortedAssets) {
        if (s.startsWith(asset)) {
            return asset;
        }
    }

    // 3. Fallback: Clean and return
    // Remove non-alphanumeric chars (e.g. "EUR/USD" -> "EURUSD")
    const clean = s.replace(/[^A-Z0-9]/g, '');
    
    // Try matching cleaned version
    for (const asset of sortedAssets) {
        if (clean.startsWith(asset)) {
            return asset;
        }
    }

    return clean || s;
};

const normalizeEATag = (tag) => {
    if (typeof tag !== 'string') return null;
    const clean = tag.trim();
    if (!clean) return null;
    
    let bare = clean;
    if (bare.startsWith('#')) {
        bare = bare.substring(1);
    }
    
    const knownSetups = ['PDH', 'PDL', 'EQH', 'EQL', 'AsiaH', 'AsiaL', 'IntH', 'IntL'];
    // Check if clean tag matches a known setup (case-insensitive)
    const match = knownSetups.find(k => k.toLowerCase() === bare.toLowerCase());
    
    // If matched, force canonical casing and # prefix
    if (match) {
        return '#' + match;
    }
    
    return clean;
};

const getOrCreateTradeByExternalId = async (db, accountId, externalTradeId, rawSymbol) => {
    const res = await db.query(
        'SELECT * FROM trades WHERE account_id = $1 AND external_trade_id = $2',
        [accountId, externalTradeId]
    );
    if (res.rows.length > 0) return parseTradeRow(res.rows[0]);

    // Create new pending trade if not found (Resilience for out-of-order events)
    const internalId = 'trade_ea_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    const now = new Date().toISOString();
    
    // Normalize Symbol
    const normalizedSymbol = normalizeSymbolToAssetPair(rawSymbol);
    
    // Insert with defaults for required columns
    // Default is_pending to FALSE to handle out-of-order terminal events correctly
    await db.query(
        `INSERT INTO trades (
            id, account_id, external_trade_id, 
            symbol, raw_symbol, type, status, outcome, 
            entry_price, quantity, fees, pnl, 
            created_at, entry_date, 
            tags, screenshots, partials, is_pending
        ) VALUES (
            $1, $2, $3, 
            $4, $5, 'LONG', 'OPEN', 'Open', 
            0, 0, 0, 0, 
            $6, $6, 
            '[]', '[]', '[]', false
        )`,
        [internalId, accountId, externalTradeId, normalizedSymbol, rawSymbol, now]
    );
    
    const newTrade = await db.query('SELECT * FROM trades WHERE id = $1', [internalId]);
    return parseTradeRow(newTrade.rows[0]);
};

const mergePendingTradeIntoPositionTrade = async (db, accountId, pendingId, positionId, rawSymbol) => {
    const res = await db.query(
        'SELECT * FROM trades WHERE account_id = $1 AND external_trade_id = $2',
        [accountId, pendingId]
    );
    
    if (res.rows.length > 0) {
        const trade = res.rows[0];
        // Ensure symbol is up to date if we have a rawSymbol passed in
        const normalized = rawSymbol ? normalizeSymbolToAssetPair(rawSymbol) : trade.symbol;
        
        await db.query(
            'UPDATE trades SET external_trade_id = $1, symbol = $2, raw_symbol = $3 WHERE id = $4',
            [positionId, normalized, rawSymbol || trade.raw_symbol, trade.id]
        );
        const updated = await db.query('SELECT * FROM trades WHERE id = $1', [trade.id]);
        return parseTradeRow(updated.rows[0]);
    } else {
        return getOrCreateTradeByExternalId(db, accountId, positionId, rawSymbol);
    }
};

const safeJson = (val) => {
    try {
        return JSON.stringify(val || []);
    } catch (e) {
        console.error("JSON Stringify Error", e);
        return '[]';
    }
};

const mapTradeToParams = (t) => [
    t.id, t.accountId, t.symbol, t.type, t.status, t.outcome,
    sanitizeNumber(t.entryPrice), sanitizeNumber(t.exitPrice), 
    sanitizeNumber(t.stopLoss), sanitizeNumber(t.takeProfit), sanitizeNumber(t.quantity),
    sanitizeNumber(t.fees) || 0, sanitizeNumber(t.mainPnl), sanitizeNumber(t.pnl) || 0, sanitizeNumber(t.balance),
    t.createdAt, t.entryDate, t.exitDate, t.entryTime, t.exitTime,
    t.entrySession, t.exitSession, t.orderType, t.setup,
    sanitizeNumber(t.leverage), sanitizeNumber(t.riskPercentage), t.notes, t.emotionalNotes,
    safeJson(t.tags),
    safeJson(t.screenshots),
    safeJson(t.partials),
    t.isDeleted || false, t.deletedAt, t.isBalanceUpdated || false,
    sanitizeNumber(t.finalStopLoss), sanitizeNumber(t.finalTakeProfit),
    t.quoteCurrency || null, sanitizeNumber(t.fxRateToUsd),
    sanitizeNumber(t.plannedRiskQuote), sanitizeNumber(t.plannedRewardQuote),
    sanitizeNumber(t.plannedRiskUsd), sanitizeNumber(t.plannedRewardUsd)
];

// --- Blob Cleanup Helper ---
const deleteBlobImages = async (urls) => {
    if (!urls || !Array.isArray(urls) || urls.length === 0) return;
    
    // Filter for valid non-empty string URLs and de-dupe
    const validUrls = [...new Set(urls.filter(u => typeof u === 'string' && u.trim().length > 0))];
    
    if (validUrls.length === 0) return;

    try {
        await del(validUrls, { token: process.env.BLOB_READ_WRITE_TOKEN });
        console.log(`[Blob] Successfully deleted ${validUrls.length} images.`);
    } catch (e) {
        console.error("[Blob] Failed to delete images:", e.message);
        // Continue execution, do not throw
    }
};

// --- Purge Logic ---
let lastPurgeCheck = 0;
const PURGE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

const purgeOldTrashedTrades = async (db) => {
    try {
        // Find trades trashed more than 30 days ago
        // Limit to 100 to prevent long-running queries in a single request
        const result = await db.query(
            "SELECT id, screenshots FROM trades WHERE is_deleted = true AND deleted_at < NOW() - INTERVAL '30 days' LIMIT 100"
        );

        if (result.rows.length === 0) return;

        const idsToDelete = [];
        let urlsToDelete = [];

        for (const row of result.rows) {
            idsToDelete.push(row.id);
            if (Array.isArray(row.screenshots)) {
                urlsToDelete = urlsToDelete.concat(row.screenshots);
            }
        }

        // 1. Delete associated blobs (Best effort)
        if (urlsToDelete.length > 0) {
            await deleteBlobImages(urlsToDelete);
        }

        // 2. Permanently delete from DB
        if (idsToDelete.length > 0) {
            await db.query('DELETE FROM trades WHERE id = ANY($1)', [idsToDelete]);
            console.log(`[Purge] Permanently deleted ${idsToDelete.length} old trades.`);
        }

    } catch (e) {
        console.error("[Purge] Error during opportunistic purge:", e);
    }
};

// --- Middleware ---
app.use(async (req, res, next) => {
    // Skip DB check for upload route to allow it to function even if DB is connecting
    if (req.path === '/api/upload' || req.path === '/api/blob/delete') return next();

    const db = getDB();
    if (!db) {
        return res.status(500).json({ error: "Database configuration missing (DATABASE_URL)." });
    }
    req.db = db;
    next();
});

// --- Auto-Migration Helper ---
let isSchemaChecked = false;

const ensureSchema = async (db) => {
    if (isSchemaChecked) return;
    try {
        // 1. Create Users Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                gemini_api_key TEXT,
                twelve_data_api_key TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. Ensure Start User Exists (Keys removed for security)
        const userCheck = await db.query("SELECT * FROM users WHERE id = 'start_user'");
        if (userCheck.rows.length === 0) {
            await db.query(`
                INSERT INTO users (id, name, gemini_api_key, twelve_data_api_key) 
                VALUES ('start_user', 'Start User', '', '')
            `);
        }

        // 3. Create Accounts Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                balance DECIMAL(20, 2) DEFAULT 0,
                is_demo BOOLEAN DEFAULT false,
                type VARCHAR(50) DEFAULT 'Real'
            );
        `);

        // 4. Safer Migration for user_id column
        try {
            await db.query(`ALTER TABLE accounts ADD COLUMN user_id VARCHAR(255)`);
        } catch (e) {
            // Ignore "column already exists" error
        }

        // 5. Link orphan accounts to Start User
        await db.query("UPDATE accounts SET user_id = 'start_user' WHERE user_id IS NULL");

        // 6. Create Other Tables
        await db.query(`
            CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(255) PRIMARY KEY, value JSONB);
            CREATE TABLE IF NOT EXISTS monthly_notes (
                month_key VARCHAR(20) PRIMARY KEY,
                goals TEXT,
                notes TEXT,
                review TEXT
            );
            CREATE TABLE IF NOT EXISTS trades (
                id VARCHAR(255) PRIMARY KEY,
                account_id VARCHAR(255) REFERENCES accounts(id) ON DELETE CASCADE
            );
        `);

        // 7. Add missing columns to trades safely
        const columns = [
            "symbol VARCHAR(20)", "type VARCHAR(20)", "status VARCHAR(20)", "outcome VARCHAR(20)",
            "entry_price DECIMAL(20, 5)", "exit_price DECIMAL(20, 5)", 
            "stop_loss DECIMAL(20, 5)", "take_profit DECIMAL(20, 5)", 
            "quantity DECIMAL(20, 5)", "fees DECIMAL(20, 2)", "main_pnl DECIMAL(20, 2)", 
            "pnl DECIMAL(20, 2)", "balance DECIMAL(20, 2)",
            "created_at TIMESTAMP", "entry_date TIMESTAMP", "exit_date TIMESTAMP",
            "entry_time VARCHAR(20)", "exit_time VARCHAR(20)",
            "entry_session VARCHAR(50)", "exit_session VARCHAR(50)",
            "order_type VARCHAR(50)", "setup VARCHAR(100)",
            "leverage DECIMAL(10, 2)", "risk_percentage DECIMAL(10, 2)",
            "notes TEXT", "emotional_notes TEXT",
            "tags JSONB DEFAULT '[]'", "screenshots JSONB DEFAULT '[]'", "partials JSONB DEFAULT '[]'",
            "is_deleted BOOLEAN DEFAULT false", "deleted_at TIMESTAMP", "is_balance_updated BOOLEAN DEFAULT false",
            "final_stop_loss DECIMAL(20, 5)", "final_take_profit DECIMAL(20, 5)",
            "quote_currency VARCHAR(10)", "fx_rate_to_usd DECIMAL(20, 10)",
            "planned_risk_quote DECIMAL(20, 2)", "planned_reward_quote DECIMAL(20, 2)",
            "planned_risk_usd DECIMAL(20, 2)", "planned_reward_usd DECIMAL(20, 2)",
            "external_trade_id VARCHAR(255)",
            "raw_symbol VARCHAR(50)",
            "is_pending BOOLEAN DEFAULT false"
        ];

        for (const colDef of columns) {
            try {
                await db.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ${colDef}`);
            } catch (e) {
                // Ignore errors
            }
        }

        // 8. Enforce USD Currency
        try {
            // Update NULL or empty currency to USD
            await db.query("UPDATE accounts SET currency = 'USD' WHERE currency IS NULL OR currency = ''");
            // Set Default
            await db.query("ALTER TABLE accounts ALTER COLUMN currency SET DEFAULT 'USD'");
        } catch (e) {
            console.warn("Currency update warning (non-fatal):", e.message);
        }

        // 9. Create EA Event Logs Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS ea_event_logs (
                event_id VARCHAR(255) PRIMARY KEY,
                account_id VARCHAR(255) NOT NULL,
                external_trade_id VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        isSchemaChecked = true;
    } catch (err) {
        console.error("Schema init failed:", err);
    }
};

// ROUTES

// Upload Route for Vercel Blob
app.post('/api/upload', async (req, res) => {
    const { filename, data } = req.body;
    if (!data || !filename) return res.status(400).json({ error: "Missing data or filename" });

    try {
        // data is expected to be a Base64 Data URI
        const base64Data = data.split(';base64,').pop();
        const buffer = Buffer.from(base64Data, 'base64');

        const blob = await put(filename, buffer, { 
            access: 'public',
            token: process.env.BLOB_READ_WRITE_TOKEN 
        });

        res.json({ url: blob.url });
    } catch (err) {
        console.error("Blob Upload Error:", err);
        res.status(500).json({ error: "Upload failed: " + err.message });
    }
});

// Delete Route for Vercel Blob
app.post('/api/blob/delete', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: "Invalid payload. 'urls' must be an array." });
    }

    // Filter to only Vercel Blob URLs to prevent errors or misuse
    const blobUrls = urls.filter(u => typeof u === 'string' && u.includes('vercel-storage.com'));

    if (blobUrls.length === 0) {
        return res.json({ success: true, deleted: 0 });
    }

    try {
        await del(blobUrls, { token: process.env.BLOB_READ_WRITE_TOKEN });
        res.json({ success: true, deleted: blobUrls.length });
    } catch (err) {
        console.error("Blob Deletion Error:", err);
        res.status(500).json({ error: "Failed to delete blobs: " + err.message });
    }
});

app.get('/api/init', async (req, res) => {
    await ensureSchema(req.db);
    res.status(200).send("Database initialized and migrated.");
});

// USERS
app.get('/api/users', async (req, res) => {
    try {
        const result = await req.db.query('SELECT * FROM users ORDER BY created_at ASC');
        res.json(result.rows.map(toCamelCase));
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json([]); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', async (req, res) => {
    const { id, name, geminiApiKey, twelveDataApiKey } = req.body;
    try {
        await req.db.query(
            `INSERT INTO users (id, name, gemini_api_key, twelve_data_api_key)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, gemini_api_key = EXCLUDED.gemini_api_key, twelve_data_api_key = EXCLUDED.twelve_data_api_key`,
            [id, name, geminiApiKey, twelveDataApiKey]
        );
        const result = await req.db.query('SELECT * FROM users ORDER BY created_at ASC');
        res.json(result.rows.map(toCamelCase));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        // 1. Get Accounts to identify trades and blobs
        const accRes = await client.query('SELECT id FROM accounts WHERE user_id = $1', [id]);
        const accountIds = accRes.rows.map(r => r.id);

        if (accountIds.length > 0) {
            // 2. Get Screenshots from Trades (for blob cleanup)
            //    We must do this before deleting accounts because deleting accounts cascades to trades.
            const tradeRes = await client.query('SELECT screenshots FROM trades WHERE account_id = ANY($1)', [accountIds]);
            
            let urlsToDelete = [];
            tradeRes.rows.forEach(row => {
                if (Array.isArray(row.screenshots)) {
                    urlsToDelete = urlsToDelete.concat(row.screenshots);
                }
            });

            // 3. Delete Blobs (Best effort, non-blocking on failure)
            if (urlsToDelete.length > 0) {
                await deleteBlobImages(urlsToDelete);
            }

            // 4. Delete Accounts
            //    Trades reference accounts with ON DELETE CASCADE, so they will be removed automatically.
            await client.query('DELETE FROM accounts WHERE user_id = $1', [id]);
        }

        // 5. Delete User
        await client.query('DELETE FROM users WHERE id = $1', [id]);

        await client.query('COMMIT');

        const result = await client.query('SELECT * FROM users ORDER BY created_at ASC');
        res.json(result.rows.map(toCamelCase));
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Delete user failed:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// GENERIC SETTINGS
app.get('/api/settings/:key', async (req, res) => {
    const { key } = req.params;
    try {
        const result = await req.db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
        res.json(result.rows.length > 0 ? result.rows[0].value : null);
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json(null); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    const { key, value } = req.body;
    try {
        await req.db.query(
            "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [key, JSON.stringify(value)]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ACCOUNTS
app.get('/api/accounts', async (req, res) => {
    const userId = req.query.userId;
    try {
        let query = 'SELECT * FROM accounts';
        const params = [];
        if (userId) {
            query += ' WHERE user_id = $1';
            params.push(userId);
        }
        query += ' ORDER BY name ASC';
        
        const result = await req.db.query(query, params);
        res.json(result.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            name: row.name,
            currency: row.currency,
            balance: parseFloat(row.balance),
            isDemo: row.is_demo,
            type: row.type
        })));
    } catch (err) {
        if (err.code === '42P01' || err.code === '42703') { await ensureSchema(req.db); return res.json([]); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/accounts', async (req, res) => {
    const { id, userId, name, currency, balance, isDemo, type } = req.body;
    try {
        await req.db.query(
            `INSERT INTO accounts (id, user_id, name, currency, balance, is_demo, type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
             user_id = EXCLUDED.user_id, name = EXCLUDED.name, currency = EXCLUDED.currency, 
             balance = EXCLUDED.balance, is_demo = EXCLUDED.is_demo, type = EXCLUDED.type`,
            [id, userId, name, currency, balance, isDemo, type]
        );
        const result = await req.db.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY name ASC', [userId]);
        res.json(result.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            name: row.name,
            currency: row.currency,
            balance: parseFloat(row.balance),
            isDemo: row.is_demo,
            type: row.type
        })));
    } catch (err) {
        if (err.code === '42703') { await ensureSchema(req.db); return res.status(500).json({ error: "Schema updated. Retry." }); }
        res.status(500).json({ error: err.message });
    }
});

// Atomic Balance Adjustment
app.post('/api/accounts/:id/adjust-balance', async (req, res) => {
    const { id } = req.params;
    const { amount } = req.body;
    
    if (amount === undefined || isNaN(amount)) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    try {
        await req.db.query(
            'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
            [amount, id]
        );
        // Return updated list for the user of this account
        const accResult = await req.db.query('SELECT user_id FROM accounts WHERE id = $1', [id]);
        if (accResult.rows.length === 0) return res.status(404).json({ error: "Account not found" });
        
        const userId = accResult.rows[0].user_id;
        const result = await req.db.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY name ASC', [userId]);
        
        res.json(result.rows.map(row => ({
            id: row.id,
            userId: row.user_id,
            name: row.name,
            currency: row.currency,
            balance: parseFloat(row.balance),
            isDemo: row.is_demo,
            type: row.type
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/accounts/:id', async (req, res) => {
    const { id } = req.params;
    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        // 1. Fetch images to delete from trades belonging to this account
        const blobRes = await client.query('SELECT screenshots FROM trades WHERE account_id = $1', [id]);
        let urls = [];
        blobRes.rows.forEach(row => {
            if (Array.isArray(row.screenshots)) urls = urls.concat(row.screenshots);
        });

        // 2. Delete blobs (best effort)
        if (urls.length > 0) {
            await deleteBlobImages(urls);
        }

        // 3. Delete Account
        await client.query('DELETE FROM accounts WHERE id = $1', [id]);
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// EA PING
app.get('/api/ea/ping', (req, res) => {
    const secret = req.headers['x-ea-secret'];
    const expectedSecret = process.env.EA_SHARED_SECRET;

    if (!expectedSecret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    res.status(200).json({ ok: true, timeUtc: new Date().toISOString() });
});

// EA WEBHOOK
app.post('/api/ea/events', async (req, res) => {
    // STRICT ISOLATION NOTE: This handler must NOT call external APIs (TwelveData/Gemini).
    // It relies solely on the payload provided by the EA and existing DB data.

    const secret = req.headers['x-ea-secret'];
    const expectedSecret = process.env.EA_SHARED_SECRET;

    // 1. Auth
    if (!expectedSecret || secret !== expectedSecret) {
        console.warn(`[EA] Unauthorized access attempt. IP: ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // 2. Validate Body
    const { eventId, accountId, externalTradeId, type, payload } = req.body;
    
    if (!eventId || typeof eventId !== 'string') return res.status(400).json({ error: 'Invalid or missing eventId' });
    if (!accountId || typeof accountId !== 'string') return res.status(400).json({ error: 'Invalid or missing accountId' });
    if (!externalTradeId || typeof externalTradeId !== 'string') return res.status(400).json({ error: 'Invalid or missing externalTradeId' });
    if (!type || typeof type !== 'string') return res.status(400).json({ error: 'Invalid or missing type' });
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'Invalid or missing payload' });

    // Use a fresh client for transaction safety
    const client = await req.db.connect();

    try {
        await client.query('BEGIN');

        // 3. Idempotency Check (Check before processing)
        const existCheck = await client.query('SELECT 1 FROM ea_event_logs WHERE event_id = $1', [eventId]);
        if (existCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(200).json({ message: 'Event already processed' });
        }

        // 4. Account Scoping
        const accCheck = await client.query('SELECT id FROM accounts WHERE id = $1', [accountId]);
        if (accCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Account not found' });
        }

        // 5. Handle Event Types
        if (type === 'ORDER_PLACED') {
            const p = payload;
            
            // Ensure trade record exists (creates with default 0/nulls if new)
            const t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, p.symbol);
            
            // Helpers
            const val = (curr, next) => (curr !== null && curr !== undefined && curr !== '' && curr !== 0) ? curr : next;
            
            const nextSymbol = normalizeSymbolToAssetPair(p.symbol);
            const nextRawSymbol = p.symbol;
            const nextType = p.direction; 
            const nextOrderType = p.orderType; 
            const nextEntryPrice = normalizeNumber(p.plannedEntryPrice);
            const nextSL = normalizeNumber(p.entryStopLoss);
            const nextTP = normalizeNumber(p.entryTakeProfit);
            const nextQty = normalizeNumber(p.quantity);
            const nextDate = p.orderPlacedTimeUtc;
            
            const existingTags = t.tags || [];
            const newTags = Array.isArray(p.tags) ? p.tags : [];
            const tagSet = new Set(existingTags.map(tag => tag.toLowerCase().trim()));
            const mergedTags = [...existingTags];
            
            newTags.forEach(rawTag => {
                const clean = normalizeEATag(rawTag);
                if (clean && !tagSet.has(clean.toLowerCase())) {
                    tagSet.add(clean.toLowerCase());
                    mergedTags.push(clean);
                }
            });

            const nextNotes = (t.notes && t.notes.trim()) ? t.notes : (p.technicalNotes || '');

            await client.query(
                `UPDATE trades SET
                    symbol = $1,
                    raw_symbol = $2,
                    type = $3,
                    order_type = $4,
                    entry_price = $5,
                    stop_loss = $6,
                    take_profit = $7,
                    quantity = $8,
                    entry_date = $9,
                    notes = $10,
                    tags = $11,
                    is_pending = true,
                    status = 'OPEN',
                    outcome = 'Open'
                 WHERE id = $12`,
                [
                    val(t.symbol, nextSymbol),
                    val(t.rawSymbol, nextRawSymbol),
                    val(t.type, nextType),
                    val(t.orderType, nextOrderType),
                    val(t.entryPrice, nextEntryPrice),
                    val(t.stopLoss, nextSL),
                    val(t.takeProfit, nextTP),
                    val(t.quantity, nextQty),
                    val(t.entryDate, nextDate),
                    nextNotes,
                    JSON.stringify(mergedTags),
                    t.id
                ]
            );
        } else if (type === 'TRADE_OPENED') {
            const p = payload;
            let t;

            // 1. Merge Pending if applicable
            if (p.pendingExternalTradeId) {
                t = await mergePendingTradeIntoPositionTrade(client, accountId, p.pendingExternalTradeId, externalTradeId, p.symbol);
            } else {
                t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, p.symbol);
            }

            const nextSymbol = normalizeSymbolToAssetPair(p.symbol);
            const nextRawSymbol = p.symbol;
            
            const nextEntryPrice = normalizeNumber(p.entryPrice);
            const nextSL = normalizeNumber(p.entryStopLoss);
            const nextTP = normalizeNumber(p.entryTakeProfit);
            const nextQty = normalizeNumber(p.quantity);
            const nextDate = p.entryTimeUtc;
            
            const nextType = p.direction;
            const nextOrderType = p.orderType;

            const existingTags = t.tags || [];
            const newTags = Array.isArray(p.tags) ? p.tags : [];
            const tagSet = new Set(existingTags.map(tag => tag.toLowerCase().trim()));
            const mergedTags = [...existingTags];
            
            newTags.forEach(rawTag => {
                const clean = normalizeEATag(rawTag);
                if (clean && !tagSet.has(clean.toLowerCase())) {
                    tagSet.add(clean.toLowerCase());
                    mergedTags.push(clean);
                }
            });

            const nextNotes = (t.notes && t.notes.trim()) ? t.notes : (p.technicalNotes || '');
            const nextEmotional = (t.emotionalNotes && t.emotionalNotes.trim()) ? t.emotionalNotes : (p.emotionalNotes || '');

            await client.query(
                `UPDATE trades SET
                    symbol = $1,
                    raw_symbol = $2,
                    type = $3,
                    order_type = $4,
                    entry_price = $5,
                    stop_loss = $6,
                    take_profit = $7,
                    quantity = $8,
                    entry_date = $9,
                    notes = $10,
                    emotional_notes = $11,
                    tags = $12,
                    is_pending = false,
                    status = 'OPEN',
                    outcome = 'Open'
                 WHERE id = $13`,
                [
                    nextSymbol,
                    nextRawSymbol,
                    nextType,
                    nextOrderType,
                    nextEntryPrice,
                    nextSL,
                    nextTP,
                    nextQty,
                    nextDate,
                    nextNotes,
                    nextEmotional,
                    JSON.stringify(mergedTags),
                    t.id
                ]
            );
        } else if (type === 'SLTP_UPDATED') {
            const p = payload;
            
            // Resilience: Create trade if missing (late event)
            const t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, null);
            const tradeId = t.id;
            const currentTags = t.tags || [];
            
            const newFinalSL = normalizeNumber(p.finalStopLoss);
            const newFinalTP = normalizeNumber(p.finalTakeProfit);
            
            const entrySL = parseFloat(t.stopLoss);
            const entryTP = parseFloat(t.takeProfit);

            const tagSet = new Set(currentTags.map(tag => tag.toLowerCase().trim()));
            const nextTags = [...currentTags];

            const addTag = (tagName) => {
                const clean = tagName.trim();
                if (!tagSet.has(clean.toLowerCase())) {
                    tagSet.add(clean.toLowerCase());
                    nextTags.push(clean);
                }
            };

            // Epsilon check (1e-6) and value check (> 0)
            const epsilon = 0.000001;

            if (!isNaN(entrySL) && newFinalSL !== null && entrySL > 0 && newFinalSL > 0) {
                if (Math.abs(entrySL - newFinalSL) > epsilon) {
                    addTag('#SL-Moved');
                }
            }

            if (!isNaN(entryTP) && newFinalTP !== null && entryTP > 0 && newFinalTP > 0) {
                if (Math.abs(entryTP - newFinalTP) > epsilon) {
                    addTag('#TP-Moved');
                }
            }

            await client.query(
                `UPDATE trades SET
                    final_stop_loss = $1,
                    final_take_profit = $2,
                    tags = $3
                 WHERE id = $4`,
                [
                    newFinalSL,
                    newFinalTP,
                    JSON.stringify(nextTags),
                    tradeId
                ]
            );
        } else if (type === 'PARTIAL_CLOSED') {
            const p = payload;
            
            // Resilience: Create trade if missing
            const t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, null);
            const tradeId = t.id;
            
            let currentPartials = t.partials || [];
            if (typeof currentPartials === 'string') {
                try { currentPartials = JSON.parse(currentPartials); } catch (e) { currentPartials = []; }
            }
            if (!Array.isArray(currentPartials)) currentPartials = [];

            const partialExists = currentPartials.some(part => part.id === p.partialId);
            
            if (!partialExists) {
                const newPnl = normalizeNumber(p.partialPnL);
                
                const newPartial = {
                    id: p.partialId,
                    quantity: normalizeNumber(p.closedVolume),
                    price: normalizeNumber(p.closePrice),
                    pnl: newPnl,
                    date: p.partialTimeUtc
                };
                
                const nextPartials = [...currentPartials, newPartial];
                
                let nextTags = t.tags || [];
                if (typeof nextTags === 'string') {
                     try { nextTags = JSON.parse(nextTags); } catch (e) { nextTags = []; }
                }
                if (!Array.isArray(nextTags)) nextTags = [];
                
                const tagSet = new Set(nextTags.map(tag => tag.toLowerCase().trim()));
                const partialTagName = '#Partial';
                if (!tagSet.has(partialTagName.toLowerCase())) {
                    nextTags.push(partialTagName);
                }

                // IMPORTANT: Only update PnL if trade is already CLOSED.
                // If open, we just store partials for reference/metrics, but main pnl is not finalized.
                let nextPnl = t.pnl;
                if (t.outcome === 'Closed') {
                    const currentMainPnl = parseFloat(t.mainPnl || 0);
                    const currentFees = parseFloat(t.fees || 0);
                    const totalPartialsPnl = nextPartials.reduce((sum, part) => sum + (part.pnl || 0), 0);
                    nextPnl = currentMainPnl + totalPartialsPnl - currentFees;
                }

                await client.query(
                    `UPDATE trades SET
                        partials = $1,
                        tags = $2,
                        pnl = $3
                     WHERE id = $4`,
                    [
                        JSON.stringify(nextPartials),
                        JSON.stringify(nextTags),
                        nextPnl,
                        tradeId
                    ]
                );
            }
        } else if (type === 'TRADE_CLOSED') {
            const p = payload;
            
            // Resilience: Create trade if missing
            const t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, null);
            const tradeId = t.id;

            let currentPartials = t.partials || [];
            if (typeof currentPartials === 'string') {
                try { currentPartials = JSON.parse(currentPartials); } catch (e) { currentPartials = []; }
            }
            if (!Array.isArray(currentPartials)) currentPartials = [];
            
            const partialsSum = currentPartials.reduce((sum, part) => sum + (parseFloat(part.pnl) || 0), 0);

            const exitPrice = normalizeNumber(p.exitPrice);
            const exitDate = p.exitTimeUtc; 
            const totalGrossPnL = normalizeNumber(p.totalPnL) || 0;
            const fees = normalizeNumber(p.feesUsd) || 0;
            const finalSL = normalizeNumber(p.finalStopLoss);
            const finalTP = normalizeNumber(p.finalTakeProfit);

            const corePnL = totalGrossPnL - partialsSum;
            const netPnL = totalGrossPnL - fees;

            let status = 'BREAK_EVEN';
            if (netPnL > 0) status = 'WIN';
            else if (netPnL < 0) status = 'LOSS';

            // Idempotent Balance Update
            if (!t.isBalanceUpdated) {
                await client.query(
                    'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
                    [netPnL, accountId]
                );
            }

            // Calculate moved tags (SL/TP Moved) redundancy check
            let currentTags = t.tags || [];
            if (typeof currentTags === 'string') {
                 try { currentTags = JSON.parse(currentTags); } catch (e) { currentTags = []; }
            }
            if (!Array.isArray(currentTags)) currentTags = [];

            const tagSet = new Set(currentTags.map(tag => tag.toLowerCase().trim()));
            const nextTags = [...currentTags];
            const addTag = (tagName) => {
                const clean = tagName.trim();
                if (!tagSet.has(clean.toLowerCase())) {
                    tagSet.add(clean.toLowerCase());
                    nextTags.push(clean);
                }
            };

            const entrySL = parseFloat(t.stopLoss);
            const entryTP = parseFloat(t.takeProfit);
            const epsilon = 0.000001;

            if (!isNaN(entrySL) && finalSL !== null && entrySL > 0 && finalSL > 0) {
                if (Math.abs(entrySL - finalSL) > epsilon) {
                    addTag('#SL-Moved');
                }
            }

            if (!isNaN(entryTP) && finalTP !== null && entryTP > 0 && finalTP > 0) {
                if (Math.abs(entryTP - finalTP) > epsilon) {
                    addTag('#TP-Moved');
                }
            }

            await client.query(
                `UPDATE trades SET
                    exit_price = $1,
                    exit_date = $2,
                    final_stop_loss = $3,
                    final_take_profit = $4,
                    fees = $5,
                    main_pnl = $6,
                    pnl = $7,
                    status = $8,
                    tags = $9,
                    outcome = 'Closed',
                    is_balance_updated = true,
                    is_pending = false
                 WHERE id = $10`,
                [
                    exitPrice,
                    exitDate,
                    finalSL,
                    finalTP,
                    fees,
                    corePnL,
                    netPnL,
                    status,
                    JSON.stringify(nextTags),
                    tradeId
                ]
            );
        } else if (type === 'ORDER_CANCELED') {
            const p = payload;
            const t = await getOrCreateTradeByExternalId(client, accountId, externalTradeId, null);
            
            let currentNotes = t.notes || '';
            const appendMsg = 'closed trade by EA';
            
            if (!currentNotes.includes(appendMsg)) {
                // Ensure clean newline handling
                currentNotes = currentNotes ? `${currentNotes}\n${appendMsg}` : appendMsg;
            }

            await client.query(
                `UPDATE trades SET
                    outcome = 'Missed',
                    status = 'MISSED',
                    exit_date = $1,
                    notes = $2,
                    is_pending = false
                 WHERE id = $3`,
                [
                    p.canceledTimeUtc,
                    currentNotes,
                    t.id
                ]
            );
        }
        
        // 6. Log Event (Success)
        await client.query(
            'INSERT INTO ea_event_logs (event_id, account_id, external_trade_id, type) VALUES ($1, $2, $3, $4)',
            [eventId, accountId, externalTradeId, type]
        );

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Event accepted' });

    } catch (err) {
        await client.query('ROLLBACK');
        
        // Handle Idempotency / Constraint Violation gracefully if race condition occurs
        if (err.code === '23505') { 
            return res.status(200).json({ message: 'Event already processed (concurrent)' });
        }
        
        if (err.code === '42P01') { 
            await ensureSchema(req.db);
            return res.status(500).json({ error: "Database schema updating. Please retry." });
        }

        console.error("[EA] Error processing event:", err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// TRADES
app.get('/api/trades', async (req, res) => {
    const { accountId, userId } = req.query;

    // Opportunistic Purge of Old Trash (Run once every 24h)
    const now = Date.now();
    if (now - lastPurgeCheck > PURGE_INTERVAL) {
        lastPurgeCheck = now;
        // Run without awaiting to keep response fast, but handle error inside function
        purgeOldTrashedTrades(req.db); 
    }

    try {
        let query = 'SELECT * FROM trades';
        const params = [];
        const conditions = [];

        if (accountId) {
            conditions.push(`account_id = $${params.length + 1}`);
            params.push(accountId);
        } else if (userId) {
            // Filter by all accounts belonging to the user
            conditions.push(`account_id IN (SELECT id FROM accounts WHERE user_id = $${params.length + 1})`);
            params.push(userId);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }
        
        query += ' ORDER BY entry_date DESC';
        
        const result = await req.db.query(query, params);
        res.json(result.rows.map(parseTradeRow));
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json([]); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/trades', async (req, res) => {
    const { trade, balanceChange } = req.body;
    // Backwards compatibility if 'trade' wrapper is missing (direct post)
    const t = trade || req.body;
    const balanceAdj = parseFloat(balanceChange);

    const client = await req.db.connect();

    try {
        await client.query('BEGIN');

        const queryText = `
            INSERT INTO trades (
                id, account_id, symbol, type, status, outcome,
                entry_price, exit_price, stop_loss, take_profit, quantity,
                fees, main_pnl, pnl, balance,
                created_at, entry_date, exit_date, entry_time, exit_time,
                entry_session, exit_session, order_type, setup,
                leverage, risk_percentage, notes, emotional_notes,
                tags, screenshots, partials,
                is_deleted, deleted_at, is_balance_updated,
                final_stop_loss, final_take_profit,
                quote_currency, fx_rate_to_usd,
                planned_risk_quote, planned_reward_quote,
                planned_risk_usd, planned_reward_usd
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
                $29, $30, $31, $32, $33, $34, $35, $36,
                $37, $38, $39, $40, $41, $42
            ) ON CONFLICT (id) DO UPDATE SET
                symbol = EXCLUDED.symbol, type = EXCLUDED.type, status = EXCLUDED.status, outcome = EXCLUDED.outcome,
                entry_price = EXCLUDED.entry_price, exit_price = EXCLUDED.exit_price, 
                stop_loss = EXCLUDED.stop_loss, take_profit = EXCLUDED.take_profit, quantity = EXCLUDED.quantity,
                fees = EXCLUDED.fees, main_pnl = EXCLUDED.main_pnl, pnl = EXCLUDED.pnl, balance = EXCLUDED.balance,
                entry_date = EXCLUDED.entry_date, exit_date = EXCLUDED.exit_date,
                entry_time = EXCLUDED.entry_time, exit_time = EXCLUDED.exit_time,
                entry_session = EXCLUDED.entry_session, exit_session = EXCLUDED.exit_session,
                order_type = EXCLUDED.order_type, setup = EXCLUDED.setup,
                notes = EXCLUDED.notes, emotional_notes = EXCLUDED.emotional_notes,
                tags = EXCLUDED.tags, screenshots = EXCLUDED.screenshots, partials = EXCLUDED.partials,
                is_deleted = EXCLUDED.is_deleted, deleted_at = EXCLUDED.deleted_at, is_balance_updated = EXCLUDED.is_balance_updated,
                final_stop_loss = EXCLUDED.final_stop_loss, final_take_profit = EXCLUDED.final_take_profit,
                quote_currency = EXCLUDED.quote_currency, fx_rate_to_usd = EXCLUDED.fx_rate_to_usd,
                planned_risk_quote = EXCLUDED.planned_risk_quote, planned_reward_quote = EXCLUDED.planned_reward_quote,
                planned_risk_usd = EXCLUDED.planned_risk_usd, planned_reward_usd = EXCLUDED.planned_reward_usd
        `;
        
        await client.query(queryText, mapTradeToParams(t));

        if (!isNaN(balanceAdj) && balanceAdj !== 0 && t.accountId) {
            await client.query(
                'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
                [balanceAdj, t.accountId]
            );
        }

        await client.query('COMMIT');

        // Return ONLY the saved trade to avoid state wiping
        const savedTrade = await client.query('SELECT * FROM trades WHERE id = $1', [t.id]);
        res.json(parseTradeRow(savedTrade.rows[0]));

    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '42703' || err.code === '42P01') { 
            await ensureSchema(req.db);
            return res.status(500).json({ error: "Schema updated. Please retry." });
        }
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Atomic Trash
app.post('/api/trades/trash', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided' });
    }

    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        // Only trash trades that are not already deleted
        const tradesRes = await client.query(
            'SELECT * FROM trades WHERE id = ANY($1) AND is_deleted = false FOR UPDATE',
            [ids]
        );
        const rows = tradesRes.rows;

        if (rows.length === 0) {
            await client.query('COMMIT');
            return res.json([]);
        }

        // Guard: all selected trades must belong to the same account
        const derivedAccountId = rows[0].account_id;
        if (rows.some(r => r.account_id !== derivedAccountId)) {
            throw Object.assign(new Error('Selected trades span multiple accounts.'), { statusCode: 400 });
        }

        // Calculate balance reversal (undo previously-applied PnL)
        let totalReversal = 0;
        for (const row of rows) {
            const t = parseTradeRow(row);
            if (t.isBalanceUpdated && t.pnl !== 0) {
                totalReversal -= t.pnl;
            }
        }

        const now = new Date();
        await client.query(
            'UPDATE trades SET is_deleted = true, deleted_at = $1 WHERE id = ANY($2) AND is_deleted = false',
            [now, ids]
        );

        if (totalReversal !== 0) {
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [totalReversal, derivedAccountId]);
        }

        await client.query('COMMIT');

        const result = await client.query('SELECT * FROM trades WHERE id = ANY($1)', [ids]);
        res.json(result.rows.map(parseTradeRow));

    } catch (err) {
        await client.query('ROLLBACK');
        const status = err?.statusCode || 500;
        res.status(status).json({ error: err.message || 'Failed to trash trades.' });
    } finally {
        client.release();
    }
});

// Atomic Restore
app.post('/api/trades/restore', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided' });
    }

    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        // Only restore trades that are currently deleted
        const tradesRes = await client.query(
            'SELECT * FROM trades WHERE id = ANY($1) AND is_deleted = true FOR UPDATE',
            [ids]
        );
        const rows = tradesRes.rows;

        if (rows.length === 0) {
            await client.query('COMMIT');
            return res.json([]);
        }

        const derivedAccountId = rows[0].account_id;
        if (rows.some(r => r.account_id !== derivedAccountId)) {
            throw Object.assign(new Error('Selected trades span multiple accounts.'), { statusCode: 400 });
        }

        // Re-apply PnL for trades that previously affected balance
        let totalApplication = 0;
        for (const row of rows) {
            const t = parseTradeRow(row);
            if (t.isBalanceUpdated && t.pnl !== 0) {
                totalApplication += t.pnl;
            }
        }

        await client.query(
            'UPDATE trades SET is_deleted = false, deleted_at = NULL WHERE id = ANY($1) AND is_deleted = true',
            [ids]
        );

        if (totalApplication !== 0) {
            await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [totalApplication, derivedAccountId]);
        }

        await client.query('COMMIT');

        const result = await client.query('SELECT * FROM trades WHERE id = ANY($1)', [ids]);
        res.json(result.rows.map(parseTradeRow));

    } catch (err) {
        await client.query('ROLLBACK');
        const status = err?.statusCode || 500;
        res.status(status).json({ error: err.message || 'Failed to restore trades.' });
    } finally {
        client.release();
    }
});

// Batch Permanent Delete
app.post('/api/trades/batch', async (req, res) => {
    // Legacy route for saveTrades batch logic (upsert)
    // Renamed because previous implementation used this URL for saving
    const { trades } = req.body;
    if (!trades || !Array.isArray(trades) || trades.length === 0) {
        return res.status(400).json({ error: 'Invalid data format.' });
    }

    const client = await req.db.connect();
    try {
        await client.query('BEGIN');

        const queryText = `
            INSERT INTO trades (
                id, account_id, symbol, type, status, outcome, entry_price, exit_price, stop_loss, take_profit, quantity,
                fees, main_pnl, pnl, balance, created_at, entry_date, exit_date, entry_time, exit_time, entry_session,
                exit_session, order_type, setup, leverage, risk_percentage, notes, emotional_notes, tags, screenshots,
                partials, is_deleted, deleted_at, is_balance_updated, final_stop_loss, final_take_profit,
                quote_currency, fx_rate_to_usd, planned_risk_quote, planned_reward_quote,
                planned_risk_usd, planned_reward_usd
            )
            VALUES (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                $22,$23,$24,$25,$26,$27,$28,$29,$30,
                $31,$32,$33,$34,$35,$36,
                $37,$38,$39,$40,$41,$42
            )
            ON CONFLICT (id) DO UPDATE SET
                account_id=EXCLUDED.account_id, symbol=EXCLUDED.symbol, type=EXCLUDED.type, status=EXCLUDED.status,
                outcome=EXCLUDED.outcome, entry_price=EXCLUDED.entry_price, exit_price=EXCLUDED.exit_price,
                stop_loss=EXCLUDED.stop_loss, take_profit=EXCLUDED.take_profit, quantity=EXCLUDED.quantity,
                fees=EXCLUDED.fees, main_pnl=EXCLUDED.main_pnl, pnl=EXCLUDED.pnl, balance=EXCLUDED.balance,
                created_at=EXCLUDED.created_at, entry_date=EXCLUDED.entry_date, exit_date=EXCLUDED.exit_date,
                entry_time=EXCLUDED.entry_time, exit_time=EXCLUDED.exit_time, entry_session=EXCLUDED.entry_session,
                exit_session=EXCLUDED.exit_session, order_type=EXCLUDED.order_type, setup=EXCLUDED.setup,
                leverage=EXCLUDED.leverage, risk_percentage=EXCLUDED.risk_percentage, notes=EXCLUDED.notes,
                emotional_notes=EXCLUDED.emotional_notes, tags=EXCLUDED.tags, screenshots=EXCLUDED.screenshots,
                partials=EXCLUDED.partials, is_deleted=EXCLUDED.is_deleted, deleted_at=EXCLUDED.deleted_at,
                is_balance_updated=EXCLUDED.is_balance_updated, final_stop_loss=EXCLUDED.final_stop_loss,
                final_take_profit=EXCLUDED.final_take_profit,
                quote_currency=EXCLUDED.quote_currency, fx_rate_to_usd=EXCLUDED.fx_rate_to_usd,
                planned_risk_quote=EXCLUDED.planned_risk_quote, planned_reward_quote=EXCLUDED.planned_reward_quote,
                planned_risk_usd=EXCLUDED.planned_risk_usd, planned_reward_usd=EXCLUDED.planned_reward_usd
        `;

        for (const t of trades) {
            await client.query(queryText, mapTradeToParams(t));
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            updatedCount: trades.length,
            updatedIds: trades.map(t => t.id)
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '42P01' || err.code === '42703') {
            await ensureSchema(req.db);
            return res.status(500).json({ error: 'Schema updated. Please retry.' });
        }
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Permanent Delete (Batch)
app.delete('/api/trades/batch', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No IDs provided.' });
    }

    try {
        // 1. Fetch images to delete
        const blobRes = await req.db.query('SELECT screenshots FROM trades WHERE id = ANY($1)', [ids]);
        let urls = [];
        blobRes.rows.forEach(row => {
            if (Array.isArray(row.screenshots)) urls = urls.concat(row.screenshots);
        });
        
        // 2. Delete blobs (best effort)
        if (urls.length > 0) {
            await deleteBlobImages(urls);
        }

        // 3. Delete from DB
        const result = await req.db.query('DELETE FROM trades WHERE id = ANY($1)', [ids]);
        res.json({ success: true, deletedCount: result.rowCount || 0 });
    } catch (err) {
        if (err.code === '42P01') return res.json({ success: true, deletedCount: 0 });
        res.status(500).json({ error: err.message });
    }
});

// Permanent Delete (Single)
app.delete('/api/trades/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Fetch images
        const blobRes = await req.db.query('SELECT screenshots FROM trades WHERE id = $1', [id]);
        if (blobRes.rows.length > 0) {
             const screenshots = blobRes.rows[0].screenshots;
             if (Array.isArray(screenshots) && screenshots.length > 0) {
                 await deleteBlobImages(screenshots);
             }
        }

        // 2. Delete from DB
        const result = await req.db.query('DELETE FROM trades WHERE id = $1', [id]);
        res.json({ success: true, id, deleted: (result.rowCount || 0) > 0 });
    } catch (err) {
        if (err.code === '42P01') return res.json({ success: true, id, deleted: false });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tags', async (req, res) => {
    const userId = req.query.userId;
    try {
        const key = userId ? `tag_groups_${userId}` : 'tag_groups';
        const result = await req.db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
        res.json(result.rows.length > 0 ? result.rows[0].value : null);
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json(null); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags', async (req, res) => {
    const { groups, userId } = req.body;
    const key = userId ? `tag_groups_${userId}` : 'tag_groups';
    try {
        await req.db.query(
            "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [key, JSON.stringify(groups)]
        );
        res.json(groups);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/strategies', async (req, res) => {
    const userId = req.query.userId;
    try {
        const key = userId ? `strategies_${userId}` : 'strategies';
        const result = await req.db.query("SELECT value FROM app_settings WHERE key = $1", [key]);
        res.json(result.rows.length > 0 ? result.rows[0].value : null);
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json(null); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/strategies', async (req, res) => {
    const { strategies, userId } = req.body;
    const key = userId ? `strategies_${userId}` : 'strategies';
    try {
        await req.db.query(
            "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [key, JSON.stringify(strategies)]
        );
        res.json(strategies);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/monthly-notes/:key', async (req, res) => {
    const { key } = req.params;
    try {
        const result = await req.db.query('SELECT * FROM monthly_notes WHERE month_key = $1', [key]);
        res.json(result.rows.length > 0 ? result.rows[0] : {});
    } catch (err) {
        if (err.code === '42P01') { await ensureSchema(req.db); return res.json({}); }
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/monthly-notes', async (req, res) => {
    const { monthKey, data } = req.body;
    try {
        await req.db.query(
            `INSERT INTO monthly_notes (month_key, goals, notes, review)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (month_key) DO UPDATE SET
             goals = EXCLUDED.goals, notes = EXCLUDED.notes, review = EXCLUDED.review`,
            [monthKey, data.goals, data.notes, data.review]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Backend Server running on port ${PORT}`);
    });
}

module.exports = app;
