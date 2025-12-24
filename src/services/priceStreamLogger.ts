/**
 * Price Stream Logger
 * 
 * Logs BTC and ETH prices at 15-minute and 1-hour intervals
 * Marks when watch mode and paper mode enter trades
 */

import * as fs from 'fs';
import * as path from 'path';
import { getRunId } from '../utils/runId';

/**
 * Helper function to break down timestamp into detailed components
 */
function getTimestampBreakdown(timestamp: number): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
} {
    const date = new Date(timestamp);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1, // 1-12
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
        millisecond: date.getUTCMilliseconds(),
    };
}

/**
 * Extract market key from market slug/title
 */
function extractMarketKey(slug: string, title: string): { type: 'BTC' | 'ETH' | null; timeframe: '15m' | '1h' | null } {
    const searchText = `${slug} ${title}`.toLowerCase();
    
    const isBTC = searchText.includes('bitcoin') || searchText.includes('btc');
    const isETH = searchText.includes('ethereum') || searchText.includes('eth');
    
    if (!isBTC && !isETH) {
        return { type: null, timeframe: null };
    }
    
    // Check for 15-minute timeframe
    const has15Min = /\b15\s*min|\b15min|updown.*?15|15.*?updown/i.test(searchText);
    
    // Check for hourly timeframe (explicit)
    const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(searchText);
    
    // Check for hourly markets by pattern: "Up or Down" with single time (e.g., "6AM ET") but NO time range
    // Hourly markets: "Bitcoin Up or Down - December 24, 6AM ET" (single time, no range)
    // 15min markets: "Bitcoin Up or Down - December 24, 6:00AM-6:15AM ET" (has time range with colon)
    // Also handle slug format: "bitcoin-up-or-down-december-24-9am-et" (with hyphens)
    const hasUpDown = /(?:up|down).*?(?:up|down)|updown/i.test(searchText);
    // Pattern like "6AM ET" or "7PM ET" (with spaces) OR "9am-et" (with hyphens in slug)
    const hasSingleTime = /\d{1,2}\s*(?:am|pm)\s*et/i.test(searchText) || /\d{1,2}(?:am|pm)-et/i.test(searchText);
    const hasTimeRange = /\d{1,2}:\d{2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}:\d{2}\s*(?:am|pm)/i.test(searchText); // Pattern like "6:00AM-6:15AM"
    const isHourlyPattern = hasUpDown && hasSingleTime && !hasTimeRange;
    
    const type = isBTC ? 'BTC' : 'ETH';
    // Prioritize 15min, then hourly (explicit or pattern), otherwise null
    const timeframe = has15Min ? '15m' : (hasHourly || isHourlyPattern) ? '1h' : null;
    
    return { type, timeframe };
}

class PriceStreamLogger {
    private btc15mPath: string;
    private eth15mPath: string;
    private btc1hPath: string;
    private eth1hPath: string;
    private lastLogged15m: Map<string, number> = new Map(); // Track last 15m log time per market
    private lastLogged1h: Map<string, number> = new Map(); // Track last 1h log time per market

    constructor() {
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        const runId = getRunId();
        this.btc15mPath = path.join(logsDir, `btc_15m_prices_${runId}.csv`);
        this.eth15mPath = path.join(logsDir, `eth_15m_prices_${runId}.csv`);
        this.btc1hPath = path.join(logsDir, `btc_1h_prices_${runId}.csv`);
        this.eth1hPath = path.join(logsDir, `eth_1h_prices_${runId}.csv`);

        this.initializeCsvFiles();
    }

    /**
     * Initialize CSV files with headers
     */
    private initializeCsvFiles(): void {
        const headers = [
            'Timestamp',
            'Date',
            'Year',
            'Month',
            'Day',
            'Hour',
            'Minute',
            'Second',
            'Millisecond',
            'Price UP ($)',
            'Price DOWN ($)',
            'Watch Mode Entry',
            'Paper Mode Entry',
            'Notes'
        ].join(',');

        // Always write headers for new run-specific files
        fs.writeFileSync(this.btc15mPath, headers + '\n', 'utf8');
        fs.writeFileSync(this.eth15mPath, headers + '\n', 'utf8');
        fs.writeFileSync(this.btc1hPath, headers + '\n', 'utf8');
        fs.writeFileSync(this.eth1hPath, headers + '\n', 'utf8');
    }

    /**
     * Log price for a market (called when prices update)
     */
    logPrice(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, entryType?: 'WATCH' | 'PAPER', notes?: string): void {
        const { type, timeframe } = extractMarketKey(marketSlug, marketTitle);
        
        if (!type || !timeframe) {
            return; // Not a BTC/ETH market we track
        }

        const timestamp = Date.now();
        const timeBreakdown = getTimestampBreakdown(timestamp);
        const date = new Date(timestamp).toISOString();

        // Determine which file to write to
        let filePath: string;
        let marketKey = `${type}-${timeframe}`;
        
        if (type === 'BTC' && timeframe === '15m') {
            filePath = this.btc15mPath;
        } else if (type === 'ETH' && timeframe === '15m') {
            filePath = this.eth15mPath;
        } else if (type === 'BTC' && timeframe === '1h') {
            filePath = this.btc1hPath;
        } else if (type === 'ETH' && timeframe === '1h') {
            filePath = this.eth1hPath;
        } else {
            return; // Unknown combination
        }

        // Check if we should log (15m = every 15 minutes, 1h = every hour)
        const lastLogged = timeframe === '15m' 
            ? this.lastLogged15m.get(marketKey) 
            : this.lastLogged1h.get(marketKey);
        
        const intervalMs = timeframe === '15m' ? 15 * 60 * 1000 : 60 * 60 * 1000;
        
        // Always log if there's an entry (WATCH or PAPER), otherwise log at intervals
        const shouldLog = entryType !== undefined || 
            lastLogged === undefined || 
            (timestamp - lastLogged) >= intervalMs;

        if (!shouldLog) {
            return;
        }

        // Update last logged time
        if (timeframe === '15m') {
            this.lastLogged15m.set(marketKey, timestamp);
        } else {
            this.lastLogged1h.set(marketKey, timestamp);
        }

        const watchEntry = entryType === 'WATCH' ? 'YES' : '';
        const paperEntry = entryType === 'PAPER' ? 'YES' : '';
        const notesField = notes ? `"${notes.replace(/"/g, '""')}"` : '';

        const row = [
            timestamp,
            date,
            timeBreakdown.year,
            timeBreakdown.month,
            timeBreakdown.day,
            timeBreakdown.hour,
            timeBreakdown.minute,
            timeBreakdown.second,
            timeBreakdown.millisecond,
            priceUp.toFixed(4),
            priceDown.toFixed(4),
            watchEntry,
            paperEntry,
            notesField,
        ].join(',');

        try {
            fs.appendFileSync(filePath, row + '\n', 'utf8');
        } catch (error) {
            console.error(`Failed to log price to ${filePath}:`, error);
        }
    }

    /**
     * Mark a watch mode entry
     */
    markWatchEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'WATCH', notes);
    }

    /**
     * Mark a paper mode entry
     */
    markPaperEntry(marketSlug: string, marketTitle: string, priceUp: number, priceDown: number, notes?: string): void {
        this.logPrice(marketSlug, marketTitle, priceUp, priceDown, 'PAPER', notes);
    }
}

export default new PriceStreamLogger();



