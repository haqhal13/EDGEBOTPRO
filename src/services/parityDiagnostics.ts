/**
 * Parity diagnostics - compare PAPER vs WATCH trades
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TradeMatch {
    watch_timestamp: number;
    paper_timestamp: number;
    dt_ms: number;
    market: string;
    watch_side: string;
    paper_side: string;
    same_side: boolean;
    watch_shares: number;
    paper_shares: number;
    size_ratio: number;
    watch_fill_px: number;
    paper_fill_px: number;
    fill_px_diff: number;
    watch_notes: string;
    paper_notes: string;
}

export interface ParityStats {
    market: string;
    matched_count: number;
    watch_total: number;
    paper_total: number;
    matched_percent: number;
    same_side_percent: number;
    median_dt_ms: number;
    median_size_ratio: number;
    median_abs_size_ratio_error: number;
    median_fill_px_diff: number;
    worst_mismatches: Array<{
        dt_ms: number;
        same_side: boolean;
        size_ratio: number;
        fill_px_diff: number;
        watch_notes: string;
        paper_notes: string;
        timestamp: string;
    }>;
}

/**
 * Parse trade from CSV row
 */
function parseTrade(row: any, market: string): {
    timestamp: number;
    side: string;
    shares: number;
    fill_px: number;
    notes: string;
} | null {
    try {
        const timestamp = parseInt(row[0]); // First column is timestamp
        const notes = row[row.length - 1] || ''; // Last column is Notes
        
        if (!notes || (!notes.includes('WATCH:') && !notes.includes('PAPER:'))) {
            return null;
        }

        // Parse notes: "WATCH: UP 12.5000 shares @ $0.2300"
        const match = notes.match(/(WATCH|PAPER):\s*(UP|DOWN)\s+([\d.]+)\s+shares\s+@\s+\$([\d.]+)/);
        if (!match) {
            return null;
        }

        return {
            timestamp,
            side: match[2],
            shares: parseFloat(match[3]),
            fill_px: parseFloat(match[4]),
            notes
        };
    } catch (error) {
        return null;
    }
}

/**
 * Match PAPER trades to WATCH trades within time window
 */
export function matchPaperToWatch(
    csvDir: string,
    windowMs: number = 2000
): Map<string, ParityStats> {
    const stats = new Map<string, ParityStats>();

    // Find all CSV files
    const csvFiles = fs.readdirSync(csvDir)
        .filter(f => f.endsWith('.csv') && f.includes('prices'))
        .map(f => path.join(csvDir, f));

    if (csvFiles.length === 0) {
        throw new Error(`No CSV files found in ${csvDir}`);
    }

    // Parse all CSV files
    const allWatchTrades: Array<{ market: string; trade: any }> = [];
    const allPaperTrades: Array<{ market: string; trade: any }> = [];

    for (const csvFile of csvFiles) {
        // Infer market from filename
        const filename = path.basename(csvFile);
        let market = 'unknown';
        if (filename.includes('BTC') && filename.includes('15')) market = 'BTC_15m';
        else if (filename.includes('ETH') && filename.includes('15')) market = 'ETH_15m';
        else if (filename.includes('BTC') && (filename.includes('1h') || filename.includes('1 hour'))) market = 'BTC_1h';
        else if (filename.includes('ETH') && (filename.includes('1h') || filename.includes('1 hour'))) market = 'ETH_1h';

        try {
            const content = fs.readFileSync(csvFile, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());
            
            // Skip header row and parse manually
            for (let i = 1; i < lines.length; i++) {
                const row = lines[i].split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
                const trade = parseTrade(row, market);
                if (trade) {
                    if (trade.notes.includes('WATCH:')) {
                        allWatchTrades.push({ market, trade });
                    } else if (trade.notes.includes('PAPER:')) {
                        allPaperTrades.push({ market, trade });
                    }
                }
            }
        } catch (error) {
            console.error(`Error parsing ${csvFile}:`, error);
        }
    }

    // Match trades per market
    const markets = new Set([...allWatchTrades.map(t => t.market), ...allPaperTrades.map(t => t.market)]);

    for (const market of markets) {
        const watchTrades = allWatchTrades.filter(t => t.market === market).map(t => t.trade);
        const paperTrades = allPaperTrades.filter(t => t.market === market).map(t => t.trade);

        const matches: TradeMatch[] = [];

        // For each WATCH trade, find nearest PAPER trade within window
        for (const watchTrade of watchTrades) {
            let bestMatch: TradeMatch | null = null;
            let minDt = windowMs + 1;

            for (const paperTrade of paperTrades) {
                const dt = Math.abs(paperTrade.timestamp - watchTrade.timestamp);
                if (dt <= windowMs && dt < minDt) {
                    minDt = dt;
                    bestMatch = {
                        watch_timestamp: watchTrade.timestamp,
                        paper_timestamp: paperTrade.timestamp,
                        dt_ms: dt,
                        market,
                        watch_side: watchTrade.side,
                        paper_side: paperTrade.side,
                        same_side: watchTrade.side === paperTrade.side,
                        watch_shares: watchTrade.shares,
                        paper_shares: paperTrade.shares,
                        size_ratio: paperTrade.shares / watchTrade.shares,
                        watch_fill_px: watchTrade.fill_px,
                        paper_fill_px: paperTrade.fill_px,
                        fill_px_diff: Math.abs(watchTrade.fill_px - paperTrade.fill_px),
                        watch_notes: watchTrade.notes,
                        paper_notes: paperTrade.notes
                    };
                }
            }

            if (bestMatch) {
                matches.push(bestMatch);
            }
        }

        // Compute statistics
        const matchedPercent = watchTrades.length > 0 ? (matches.length / watchTrades.length) * 100 : 0;
        const sameSidePercent = matches.length > 0 
            ? (matches.filter(m => m.same_side).length / matches.length) * 100 
            : 0;

        const dtMs = matches.map(m => m.dt_ms).sort((a, b) => a - b);
        const medianDtMs = dtMs.length > 0 ? dtMs[Math.floor(dtMs.length / 2)] : 0;

        const sizeRatios = matches.map(m => m.size_ratio).sort((a, b) => a - b);
        const medianSizeRatio = sizeRatios.length > 0 ? sizeRatios[Math.floor(sizeRatios.length / 2)] : 0;
        const medianAbsSizeRatioError = sizeRatios.length > 0
            ? sizeRatios.map(r => Math.abs(r - 1.0)).sort((a, b) => a - b)[Math.floor(sizeRatios.length / 2)]
            : 0;

        const fillPxDiffs = matches.map(m => m.fill_px_diff).sort((a, b) => a - b);
        const medianFillPxDiff = fillPxDiffs.length > 0 ? fillPxDiffs[Math.floor(fillPxDiffs.length / 2)] : 0;

        // Find worst mismatches (by fill_px_diff)
        const worstMismatches = matches
            .map(m => ({
                dt_ms: m.dt_ms,
                same_side: m.same_side,
                size_ratio: m.size_ratio,
                fill_px_diff: m.fill_px_diff,
                watch_notes: m.watch_notes,
                paper_notes: m.paper_notes,
                timestamp: new Date(m.watch_timestamp).toISOString()
            }))
            .sort((a, b) => b.fill_px_diff - a.fill_px_diff)
            .slice(0, 10);

        stats.set(market, {
            market,
            matched_count: matches.length,
            watch_total: watchTrades.length,
            paper_total: paperTrades.length,
            matched_percent: matchedPercent,
            same_side_percent: sameSidePercent,
            median_dt_ms: medianDtMs,
            median_size_ratio: medianSizeRatio,
            median_abs_size_ratio_error: medianAbsSizeRatioError,
            median_fill_px_diff: medianFillPxDiff,
            worst_mismatches: worstMismatches
        });
    }

    return stats;
}

/**
 * Print parity diagnostics with expected thresholds
 */
export function printParityDiagnostics(stats: Map<string, ParityStats>): void {
    console.log('\n=== PAPER vs WATCH Parity Diagnostics ===\n');
    console.log('Expected Metrics (from ChatGPT recommendations):');
    console.log('  ✅ Same-side rate: 95-98%');
    console.log('  ✅ Size ratio error: <5% median');
    console.log('  ✅ Missed trades: <3-5%');
    console.log('  ⚠️  Inventory curve: Visually identical (requires plotting)');
    console.log('  ⚠️  PnL direction: Same sign (requires PnL calculation)');
    console.log('');

    for (const [market, stat] of stats.entries()) {
        // Calculate missed trades percentage (inverse of matched)
        const missedTradesPercent = 100 - stat.matched_percent;
        
        // Size ratio error as percentage (multiply by 100)
        const sizeRatioErrorPercent = stat.median_abs_size_ratio_error * 100;
        
        // Check thresholds
        const sameSideOk = stat.same_side_percent >= 95 && stat.same_side_percent <= 98;
        const sizeRatioOk = sizeRatioErrorPercent < 5;
        const missedTradesOk = missedTradesPercent < 5;
        
        console.log(`${market}:`);
        console.log(`  📊 Matched: ${stat.matched_count}/${stat.watch_total} (${stat.matched_percent.toFixed(1)}%)`);
        console.log(`  ❌ Missed: ${stat.watch_total - stat.matched_count} trades (${missedTradesPercent.toFixed(1)}%) ${missedTradesOk ? '✅' : '❌'} ${missedTradesOk ? '' : '(Target: <5%)'}`);
        console.log(`  📍 Same Side: ${stat.same_side_percent.toFixed(1)}% ${sameSideOk ? '✅' : '❌'} ${sameSideOk ? '' : '(Target: 95-98%)'}`);
        console.log(`  📏 Size Ratio Error: ${sizeRatioErrorPercent.toFixed(2)}% median ${sizeRatioOk ? '✅' : '❌'} ${sizeRatioOk ? '' : '(Target: <5%)'}`);
        console.log(`  ⏱️  Median dt_ms: ${stat.median_dt_ms.toFixed(0)}ms`);
        console.log(`  💰 Median fill_px_diff: $${stat.median_fill_px_diff.toFixed(4)}`);
        console.log(`  📈 Median size_ratio: ${stat.median_size_ratio.toFixed(3)}`);

        // Overall status
        const allMetricsOk = sameSideOk && sizeRatioOk && missedTradesOk;
        console.log(`  ${allMetricsOk ? '✅ ALL METRICS PASS' : '⚠️  SOME METRICS FAIL'}`);
        
        if (stat.worst_mismatches.length > 0) {
            console.log(`  🔍 Top ${Math.min(10, stat.worst_mismatches.length)} worst mismatches:`);
            stat.worst_mismatches.forEach((m, i) => {
                console.log(`    ${i + 1}. dt=${m.dt_ms}ms, same_side=${m.same_side}, size_ratio=${m.size_ratio.toFixed(2)}, fill_diff=$${m.fill_px_diff.toFixed(4)}`);
                console.log(`       WATCH: ${m.watch_notes}`);
                console.log(`       PAPER: ${m.paper_notes}`);
                console.log(`       Time: ${m.timestamp}`);
            });
        }
        console.log('');
    }
    
    // Summary across all markets
    console.log('=== Summary ===');
    const markets = Array.from(stats.values());
    const avgSameSide = markets.reduce((sum, s) => sum + s.same_side_percent, 0) / markets.length;
    const avgMissed = markets.reduce((sum, s) => sum + (100 - s.matched_percent), 0) / markets.length;
    const avgSizeError = markets.reduce((sum, s) => sum + (s.median_abs_size_ratio_error * 100), 0) / markets.length;
    
    console.log(`Average Same-Side Rate: ${avgSameSide.toFixed(1)}% ${avgSameSide >= 95 && avgSameSide <= 98 ? '✅' : '❌'}`);
    console.log(`Average Missed Trades: ${avgMissed.toFixed(1)}% ${avgMissed < 5 ? '✅' : '❌'}`);
    console.log(`Average Size Ratio Error: ${avgSizeError.toFixed(2)}% ${avgSizeError < 5 ? '✅' : '❌'}`);
    console.log('');
    console.log('💡 If metrics don\'t meet targets, check:');
    console.log('   1. Missing inventory conditioning in size_params');
    console.log('   2. Wrong size bucket edges (bin_edges not matching actual price distribution)');
    console.log('   3. Fill price convention mismatch (execution price vs market price)');
    console.log('');
}

