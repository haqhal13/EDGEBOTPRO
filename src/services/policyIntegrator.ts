/**
 * Integrates policy engine into PAPER bot trading loop
 */
import { getParamLoader, MarketParams } from './paramLoader';
import { policyEngine, TapeState, PriceHistory, InventoryState, EntrySignal } from './policyEngine';
import Logger from '../utils/logger';

export interface PolicyState {
    // Price history per market (keep last N entries for feature computation)
    priceHistory: Map<string, PriceHistory[]>;
    // Inventory state per market
    inventory: Map<string, InventoryState>;
    // Last trade time per market
    lastTradeTime: Map<string, number>;
    // Recent trade times per market (for cadence)
    recentTradeTimes: Map<string, number[]>;
    // Decision ID counter (for tracing)
    decisionIdCounter: number;
}

class PolicyIntegrator {
    private policyState: PolicyState;
    private maxHistoryLength = 1000; // Keep last 1000 price points per market
    private maxRecentTrades = 100; // Keep last 100 trade timestamps per market

    constructor() {
        this.policyState = {
            priceHistory: new Map(),
            inventory: new Map(),
            lastTradeTime: new Map(),
            recentTradeTimes: new Map(),
            decisionIdCounter: 0
        };
    }

    /**
     * Update price history for a market
     */
    updatePriceHistory(market: string, timestamp: number, upPx: number, downPx: number): void {
        if (!this.policyState.priceHistory.has(market)) {
            this.policyState.priceHistory.set(market, []);
        }

        const history = this.policyState.priceHistory.get(market)!;
        history.push({ timestamp, up_px: upPx, down_px: downPx });

        // Trim to max length
        if (history.length > this.maxHistoryLength) {
            history.shift();
        }
    }

    /**
     * Get or initialize inventory state for a market
     */
    private getInventory(market: string): InventoryState {
        if (!this.policyState.inventory.has(market)) {
            this.policyState.inventory.set(market, {
                inv_up_shares: 0,
                inv_down_shares: 0
            });
        }
        return this.policyState.inventory.get(market)!;
    }

    /**
     * Update inventory after a trade
     */
    updateInventory(market: string, side: 'UP' | 'DOWN', shares: number, cost: number): void {
        const inventory = this.getInventory(market);
        
        if (side === 'UP') {
            const oldCost = (inventory.avg_cost_up || 0) * inventory.inv_up_shares;
            inventory.inv_up_shares += shares;
            inventory.avg_cost_up = (oldCost + cost) / inventory.inv_up_shares;
        } else {
            const oldCost = (inventory.avg_cost_down || 0) * inventory.inv_down_shares;
            inventory.inv_down_shares += shares;
            inventory.avg_cost_down = (oldCost + cost) / inventory.inv_down_shares;
        }
    }

    /**
     * Record trade time for cadence tracking
     */
    private recordTradeTime(market: string, timestamp: number): void {
        if (!this.policyState.recentTradeTimes.has(market)) {
            this.policyState.recentTradeTimes.set(market, []);
        }

        const recent = this.policyState.recentTradeTimes.get(market)!;
        recent.push(timestamp);
        this.policyState.lastTradeTime.set(market, timestamp);

        // Trim to max length
        if (recent.length > this.maxRecentTrades) {
            recent.shift();
        }
    }

    /**
     * Main decision function - determines if we should trade
     */
    shouldTrade(
        market: string,
        timestamp: number,
        upPx: number,
        downPx: number,
        marketParams: MarketParams
    ): { shouldTrade: boolean; side: 'UP' | 'DOWN' | null; shares: number; reason: string; decisionId: number } {
        const decisionId = ++this.policyState.decisionIdCounter;

        // Update price history
        this.updatePriceHistory(market, timestamp, upPx, downPx);

        // Get current state
        const state: TapeState = {
            timestamp,
            up_px: upPx,
            down_px: downPx,
            market
        };

        const history = this.policyState.priceHistory.get(market) || [];

        // Compute features
        const features = policyEngine.computeFeatures(state, history);

        // Check cadence first
        const lastTradeTs = this.policyState.lastTradeTime.get(market) || null;
        const recentTrades = this.policyState.recentTradeTimes.get(market) || [];

        if (!policyEngine.cadenceOk(lastTradeTs, recentTrades, marketParams.cadence_params, timestamp)) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: `cadence_blocked`,
                decisionId
            };
        }

        // Get entry signal
        const entrySignal: EntrySignal = policyEngine.entrySignal(state, features, marketParams.entry_params);

        if (!entrySignal.should_trade || !entrySignal.side) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: entrySignal.reason,
                decisionId
            };
        }

        // Get size
        const shares = policyEngine.sizeForTrade(state, features, marketParams.size_params, entrySignal.side);

        // Check inventory and rebalance
        const inventory = this.getInventory(market);
        const finalSide = policyEngine.inventoryOkAndRebalance(
            inventory,
            marketParams.inventory_params,
            entrySignal.side
        );

        if (!finalSide) {
            return {
                shouldTrade: false,
                side: null,
                shares: 0,
                reason: 'inventory_limit_exceeded',
                decisionId
            };
        }

        // Log decision
        Logger.info(`[Policy Decision ${decisionId}] ${market}: ${finalSide} ${shares.toFixed(4)} shares @ ${(finalSide === 'UP' ? upPx : downPx).toFixed(4)} (${entrySignal.reason})`);

        return {
            shouldTrade: true,
            side: finalSide,
            shares,
            reason: entrySignal.reason,
            decisionId
        };
    }

    /**
     * Record that a trade was executed
     */
    recordTradeExecution(
        market: string,
        timestamp: number,
        side: 'UP' | 'DOWN',
        shares: number,
        cost: number
    ): void {
        this.updateInventory(market, side, shares, cost);
        this.recordTradeTime(market, timestamp);
    }

    /**
     * Get current inventory state for a market (public accessor)
     */
    getInventoryState(market: string): InventoryState {
        return this.getInventory(market);
    }

    /**
     * Reset inventory (for testing or manual reset)
     */
    resetInventory(market?: string): void {
        if (market) {
            this.policyState.inventory.delete(market);
            this.policyState.lastTradeTime.delete(market);
            this.policyState.recentTradeTimes.delete(market);
        } else {
            this.policyState.inventory.clear();
            this.policyState.lastTradeTime.clear();
            this.policyState.recentTradeTimes.clear();
        }
    }
}

// Singleton instance
export const policyIntegrator = new PolicyIntegrator();

