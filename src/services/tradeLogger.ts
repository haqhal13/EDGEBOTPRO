import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import fetchData from '../utils/fetchData';
import priceStreamLogger from './priceStreamLogger';
import { getRunId } from '../utils/runId';

interface TradeLog {
    timestamp: number;
    date: string;
    traderAddress: string;
    traderName?: string;
    transactionHash: string;
    conditionId: string;
    marketName: string;
    marketSlug?: string;
    side: string; // BUY or SELL
    outcome: string; // UP or DOWN
    outcomeIndex: number;
    asset: string;
    size: number; // Shares
    price: number; // Price per share
    usdcSize: number; // Total USD value
    priceUp: number; // Market price for UP at time of trade
    priceDown: number; // Market price for DOWN at time of trade
    marketKey?: string;
}

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

class TradeLogger {
    private csvFilePath: string;
    private loggedTrades: Set<string> = new Set(); // Track trades already logged

    constructor() {
        // Initialize CSV file path in logs directory with run ID
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        const runId = getRunId();
        this.csvFilePath = path.join(logsDir, `watcher_trades_${runId}.csv`);
        this.initializeCsvFile();
    }

    /**
     * Initialize CSV file with headers (always create new file for each run)
     */
    private initializeCsvFile(): void {
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
            'Trader Address',
            'Trader Name',
            'Transaction Hash',
            'Condition ID',
            'Market Name',
            'Market Slug',
            'Market Key',
            'Side',
            'Outcome',
            'Outcome Index',
            'Asset',
            'Size (Shares)',
            'Price per Share ($)',
            'Total Value ($)',
            'Market Price UP ($)',
            'Market Price DOWN ($)',
            'Price Difference UP',
            'Price Difference DOWN',
            'Entry Type'
        ].join(',');
        fs.writeFileSync(this.csvFilePath, headers + '\n', 'utf8');
    }

    /**
     * Fetch market prices (UP and DOWN) for a condition ID
     */
    private async fetchMarketPrices(conditionId: string): Promise<{ priceUp: number; priceDown: number }> {
        if (!conditionId) {
            return { priceUp: 0.5, priceDown: 0.5 };
        }

        try {
            // Try Gamma API first (more reliable for prices)
            // Gamma's /markets/{id} expects a market ID, not a condition_id,
            // so we query the markets list and match on condition_id.
            const gammaUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500`;
            const marketList = await fetchData(gammaUrl).catch(() => null);

            if (Array.isArray(marketList)) {
                const marketData = marketList.find((m: any) => m.condition_id === conditionId);
                if (marketData && marketData.tokens && Array.isArray(marketData.tokens)) {
                let priceUp = 0.5;
                let priceDown = 0.5;
                let foundUp = false;
                let foundDown = false;

                for (const token of marketData.tokens) {
                    const outcome = (token.outcome || '').toLowerCase();
                    const price = parseFloat(token.price) || 0.5;

                    // Determine if this is UP or DOWN
                    if (outcome.includes('up') || outcome.includes('yes') || outcome.includes('higher') || outcome.includes('above')) {
                        priceUp = price;
                        foundUp = true;
                    } else if (outcome.includes('down') || outcome.includes('no') || outcome.includes('lower') || outcome.includes('below')) {
                        priceDown = price;
                        foundDown = true;
                    }
                }

                // If we found both prices, normalize them
                if (foundUp && foundDown) {
                    const total = priceUp + priceDown;
                    if (total > 0 && total !== 1.0) {
                        // Normalize if they don't sum to 1
                        priceUp = priceUp / total;
                        priceDown = priceDown / total;
                    }
                    return { priceUp, priceDown };
                } else if (foundUp || foundDown) {
                    // If we only found one, calculate the other
                    if (foundUp) {
                        priceDown = 1.0 - priceUp;
                    } else {
                        priceUp = 1.0 - priceDown;
                    }
                    return { priceUp, priceDown };
                }
            }
        } catch (error) {
            // Continue to fallback methods
        }

        // Fallback: try to get prices from positions API
        try {
            for (const traderAddress of ENV.USER_ADDRESSES) {
                try {
                    const positions = await fetchData(
                        `https://data-api.polymarket.com/positions?user=${traderAddress}`
                    ).catch(() => null);

                    if (Array.isArray(positions)) {
                        let priceUp = 0.5;
                        let priceDown = 0.5;
                        let foundUp = false;
                        let foundDown = false;

                        for (const pos of positions) {
                            if (pos.conditionId === conditionId && pos.curPrice !== undefined) {
                                const outcome = (pos.outcome || '').toLowerCase();
                                const price = parseFloat(pos.curPrice) || 0.5;

                                if (outcome.includes('up') || outcome.includes('yes')) {
                                    priceUp = price;
                                    foundUp = true;
                                } else if (outcome.includes('down') || outcome.includes('no')) {
                                    priceDown = price;
                                    foundDown = true;
                                }

                                if (foundUp && foundDown) {
                                    // Normalize
                                    const total = priceUp + priceDown;
                                    if (total > 0 && total !== 1.0) {
                                        priceUp = priceUp / total;
                                        priceDown = priceDown / total;
                                    }
                                    return { priceUp, priceDown };
                                }
                            }
                        }
                        
                        // If we found one, calculate the other
                        if (foundUp) {
                            priceDown = 1.0 - priceUp;
                            return { priceUp, priceDown };
                        } else if (foundDown) {
                            priceUp = 1.0 - priceDown;
                            return { priceUp, priceDown };
                        }
                    }
                } catch (e) {
                    // Continue to next trader
                }
            }
        } catch (error) {
            // Silently fail
        }

        // Default: return 0.5 for both if we can't fetch
        return { priceUp: 0.5, priceDown: 0.5 };
    }

    /**
     * Determine if outcome is UP or DOWN
     */
    private isUpOutcome(activity: any): boolean {
        // Primary method: use outcomeIndex (0 = UP/YES, 1 = DOWN/NO typically)
        if (activity.outcomeIndex !== undefined) {
            return activity.outcomeIndex === 0;
        }
        
        // Fallback: check outcome and asset strings
        const outcome = (activity.outcome || '').toLowerCase();
        const asset = (activity.asset || '').toLowerCase();
        
        // Check for UP indicators
        if (outcome.includes('up') || 
            outcome.includes('higher') ||
            outcome.includes('above') ||
            outcome.includes('yes') ||
            asset.includes('yes') ||
            asset.includes('up')) {
            return true;
        }
        
        // Check for DOWN indicators
        if (outcome.includes('down') ||
            outcome.includes('lower') ||
            outcome.includes('below') ||
            outcome.includes('no') ||
            asset.includes('no') ||
            asset.includes('down')) {
            return false;
        }
        
        // Default: assume first outcome is UP
        return true;
    }

    /**
     * Log a trade to CSV
     */
    async logTrade(activity: any, traderAddress: string): Promise<void> {
        // Create unique key for this trade
        const tradeKey = `${traderAddress}:${activity.transactionHash}:${activity.asset}`;
        
        // Skip if already logged
        if (this.loggedTrades.has(tradeKey)) {
            return;
        }

        try {
            // Fetch market prices at time of trade
            const prices = await this.fetchMarketPrices(activity.conditionId);
            
            const isUp = this.isUpOutcome(activity);
            const outcome = isUp ? 'UP' : 'DOWN';
            
            // Extract market key (similar to marketTracker logic)
            const marketKey = this.extractMarketKey(activity);
            
            const timestamp = activity.timestamp ? activity.timestamp * 1000 : Date.now();
            const date = new Date(timestamp).toISOString();
            const timeBreakdown = getTimestampBreakdown(timestamp);
            
            const tradePrice = parseFloat(activity.price || '0');
            const size = parseFloat(activity.size || '0');
            const usdcSize = parseFloat(activity.usdcSize || '0');
            
            // Calculate price differences (how much better/worse than market price)
            const priceDifferenceUp = isUp ? (tradePrice - prices.priceUp) : 0;
            const priceDifferenceDown = !isUp ? (tradePrice - prices.priceDown) : 0;
            
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
                traderAddress,
                activity.name || activity.pseudonym || '',
                activity.transactionHash || '',
                activity.conditionId || '',
                `"${(activity.title || activity.slug || 'Unknown').replace(/"/g, '""')}"`,
                activity.slug || '',
                marketKey,
                activity.side || 'BUY',
                outcome,
                activity.outcomeIndex ?? (isUp ? 0 : 1),
                activity.asset || '',
                size.toFixed(4),
                tradePrice.toFixed(4),
                usdcSize.toFixed(2),
                prices.priceUp.toFixed(4),
                prices.priceDown.toFixed(4),
                priceDifferenceUp.toFixed(4),
                priceDifferenceDown.toFixed(4),
                'WATCH' // Entry Type
            ].join(',');

            // Append to CSV file
            fs.appendFileSync(this.csvFilePath, row + '\n', 'utf8');
            this.loggedTrades.add(tradeKey);

            // Log to price stream with watch mode entry marker
            const marketTitle = activity.title || activity.slug || 'Unknown';
            priceStreamLogger.markWatchEntry(
                activity.slug || '',
                marketTitle,
                prices.priceUp,
                prices.priceDown,
                `Watch mode trade: ${outcome} ${size.toFixed(4)} shares @ $${tradePrice.toFixed(4)}`
            );
        } catch (error) {
            console.error(`Failed to log trade to CSV: ${error}`);
        }
    }

    /**
     * Extract market key from activity (similar to marketTracker logic)
     */
    private extractMarketKey(activity: any): string {
        const rawTitle =
            activity?.slug ||
            activity?.eventSlug ||
            activity?.title ||
            activity?.asset ||
            '';
        
        if (!rawTitle) return 'Unknown';
        
        const titleLower = rawTitle.toLowerCase();
        
        // Check for Bitcoin
        if (titleLower.includes('bitcoin') || titleLower.includes('btc')) {
            const has15Min = /\b15\s*min|\b15min/i.test(rawTitle);
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            if (has15Min) return 'BTC-UpDown-15';
            if (hasHourly) return 'BTC-UpDown-1h';
            return 'BTC';
        }
        
        // Check for Ethereum
        if (titleLower.includes('ethereum') || titleLower.includes('eth')) {
            const has15Min = /\b15\s*min|\b15min/i.test(rawTitle);
            const hasHourly = /\b1\s*h|\b1\s*hour|\bhourly/i.test(rawTitle);
            if (has15Min) return 'ETH-UpDown-15';
            if (hasHourly) return 'ETH-UpDown-1h';
            return 'ETH';
        }
        
        // Use condition ID if available
        if (activity.conditionId) {
            return `CID-${activity.conditionId.substring(0, 10)}`;
        }
        
        return 'Unknown';
    }
}

export default new TradeLogger();
