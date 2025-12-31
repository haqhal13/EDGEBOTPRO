/**
 * Unit tests for policy engine (sizing, cadence, rebalance logic)
 */
import { PolicyEngine } from '../policyEngine';
import { EntryParams, SizeParams, InventoryParams, CadenceParams } from '../paramLoader';

describe('PolicyEngine', () => {
    let engine: PolicyEngine;

    beforeEach(() => {
        engine = new PolicyEngine();
    });

    describe('sizeForTrade - bucket lookup sizing', () => {
        it('should return correct size from bucket table', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                size_table: {
                    '(0, 0.2]': 5.0,
                    '(0.2, 0.4]': 10.0,
                    '(0.4, 0.6]': 15.0,
                    '(0.6, 0.8]': 20.0,
                    '(0.8, 1]': 25.0
                }
            };

            const state = {
                timestamp: 1000,
                up_px: 0.35,
                down_px: 0.65,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.15 };

            // UP side at 0.35 should map to bucket (0.2, 0.4] = 10.0
            const sizeUp = engine.sizeForTrade(state, features, sizeParams, 'UP');
            expect(sizeUp).toBe(10.0);

            // DOWN side at 0.65 should map to bucket (0.6, 0.8] = 20.0
            const sizeDown = engine.sizeForTrade(state, features, sizeParams, 'DOWN');
            expect(sizeDown).toBe(20.0);
        });

        it('should handle edge cases at bucket boundaries', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.5, 1.0],
                size_table: {
                    '(0, 0.5]': 12.0,
                    '(0.5, 1]': 22.0
                }
            };

            const state = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            // Exactly at boundary should map to first bucket
            const size = engine.sizeForTrade(state, features, sizeParams, 'UP');
            expect(size).toBe(12.0);
        });

        it('should handle prices outside bucket range', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.2, 0.4, 0.6, 0.8],
                size_table: {
                    '(0.2, 0.4]': 10.0,
                    '(0.4, 0.6]': 15.0,
                    '(0.6, 0.8]': 20.0
                }
            };

            const stateLow = {
                timestamp: 1000,
                up_px: 0.1, // Below range
                down_px: 0.9,
                market: 'BTC_15m'
            };

            const stateHigh = {
                timestamp: 1000,
                up_px: 0.9, // Above range
                down_px: 0.1,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.4 };

            // Should use nearest bucket
            const sizeLow = engine.sizeForTrade(stateLow, features, sizeParams, 'UP');
            expect(sizeLow).toBe(10.0); // First bucket

            const sizeHigh = engine.sizeForTrade(stateHigh, features, sizeParams, 'UP');
            expect(sizeHigh).toBe(20.0); // Last bucket
        });

        it('should use median fallback when bucket key not found', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 0.5, 1.0],
                size_table: {
                    '(0, 0.5]': 10.0,
                    '(0.5, 1]': 20.0
                }
            };

            const state = {
                timestamp: 1000,
                up_px: 0.25,
                down_px: 0.75,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.25 };

            // Mock size_table to be missing the key (simulate edge case)
            const sizeParamsMissingKey = {
                ...sizeParams,
                size_table: {} // Empty table
            };

            const size = engine.sizeForTrade(state, features, sizeParamsMissingKey, 'UP');
            expect(size).toBe(1.0); // Default fallback
        });

        it('should return default size when sizeParams is undefined', () => {
            const state = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            const size = engine.sizeForTrade(state, features, undefined, 'UP');
            expect(size).toBe(1.0);
        });

        it('should round to 4 decimal places', () => {
            const sizeParams: SizeParams = {
                bin_edges: [0.0, 1.0],
                size_table: {
                    '(0, 1]': 12.123456789
                }
            };

            const state = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            const size = engine.sizeForTrade(state, features, sizeParams, 'UP');
            expect(size).toBe(12.1235); // Rounded to 4 decimals
        });
    });

    describe('cadenceOk - cadence throttling', () => {
        it('should allow trade when no cadence params', () => {
            const result = engine.cadenceOk(null, [], undefined, 1000);
            expect(result).toBe(true);
        });

        it('should block trade if min inter-trade time not met', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 2000,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 10,
                max_trades_per_min: 100
            };

            const lastTradeTs = 500; // 500ms ago
            const currentTs = 1000; // Now
            const timeSince = currentTs - lastTradeTs; // 500ms < 2000ms

            const result = engine.cadenceOk(lastTradeTs, [], cadenceParams, currentTs);
            expect(result).toBe(false);
        });

        it('should allow trade if min inter-trade time is met', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 2000,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 10,
                max_trades_per_min: 100
            };

            const lastTradeTs = 0; // 2000ms ago
            const currentTs = 2000; // Now

            const result = engine.cadenceOk(lastTradeTs, [], cadenceParams, currentTs);
            expect(result).toBe(true);
        });

        it('should block trade if max trades per second exceeded', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 0,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 2,
                max_trades_per_min: 100
            };

            const currentTs = 1000;
            const recentTrades = [
                995, // 5ms ago
                998  // 2ms ago
            ]; // 2 trades in last second

            const result = engine.cadenceOk(null, recentTrades, cadenceParams, currentTs);
            expect(result).toBe(false); // Already at limit
        });

        it('should allow trade if max trades per second not exceeded', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 0,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 3,
                max_trades_per_min: 100
            };

            const currentTs = 1000;
            const recentTrades = [
                995, // 5ms ago
                998  // 2ms ago
            ]; // 2 trades in last second, limit is 3

            const result = engine.cadenceOk(null, recentTrades, cadenceParams, currentTs);
            expect(result).toBe(true);
        });

        it('should block trade if max trades per minute exceeded', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 0,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 100,
                max_trades_per_min: 5
            };

            const currentTs = 60000;
            const recentTrades = [
                1000,   // 59s ago
                2000,   // 58s ago
                3000,   // 57s ago
                4000,   // 56s ago
                5000    // 55s ago
            ]; // 5 trades in last minute

            const result = engine.cadenceOk(null, recentTrades, cadenceParams, currentTs);
            expect(result).toBe(false);
        });

        it('should filter out trades outside time windows', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 0,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 2,
                max_trades_per_min: 100
            };

            const currentTs = 1000;
            const recentTrades = [
                0,      // 1000ms ago - outside 1s window
                995,    // 5ms ago - inside window
                998     // 2ms ago - inside window
            ];

            const result = engine.cadenceOk(null, recentTrades, cadenceParams, currentTs);
            expect(result).toBe(false); // 2 trades in window, at limit
        });

        it('should allow trade when no previous trades', () => {
            const cadenceParams: CadenceParams = {
                min_inter_trade_ms: 1000,
                p50_inter_trade_ms: 2500,
                p95_inter_trade_ms: 5000,
                max_trades_per_sec: 1,
                max_trades_per_min: 1
            };

            const result = engine.cadenceOk(null, [], cadenceParams, 1000);
            expect(result).toBe(true);
        });
    });

    describe('inventoryOkAndRebalance - rebalance switching logic', () => {
        it('should return proposed side when no inventory params', () => {
            const inventory = {
                inv_up_shares: 10,
                inv_down_shares: 5
            };

            const result = engine.inventoryOkAndRebalance(inventory, undefined, 'UP');
            expect(result).toBe('UP');

            const resultDown = engine.inventoryOkAndRebalance(inventory, undefined, 'DOWN');
            expect(resultDown).toBe('DOWN');
        });

        it('should block trade when max total shares exceeded', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 50
            };

            const inventory = {
                inv_up_shares: 30,
                inv_down_shares: 25 // Total = 55 > 50
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBeNull();
        });

        it('should block trade when max UP shares exceeded', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 50,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 50, // At limit
                inv_down_shares: 10
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBeNull();
        });

        it('should block trade when max DOWN shares exceeded', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 50,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 10,
                inv_down_shares: 50 // At limit
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'DOWN');
            expect(result).toBeNull();
        });

        it('should switch to DOWN when UP ratio exceeds rebalance threshold', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6, // If UP ratio > 0.6, prefer DOWN
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 70,  // 70/100 = 0.7 > 0.6
                inv_down_shares: 30
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBe('DOWN'); // Should switch to DOWN
        });

        it('should switch to UP when DOWN ratio exceeds rebalance threshold', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6, // If UP ratio < 0.4 (DOWN ratio > 0.6), prefer UP
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 20,  // 20/100 = 0.2 < 0.4 (DOWN ratio = 0.8 > 0.6)
                inv_down_shares: 80
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'DOWN');
            expect(result).toBe('UP'); // Should switch to UP
        });

        it('should not switch if other side is at max', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 30, // DOWN at max
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 70,  // 70/100 = 0.7 > 0.6 (should switch to DOWN)
                inv_down_shares: 30 // But DOWN is at max
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBeNull(); // Can't rebalance, block trade
        });

        it('should not rebalance when ratio is within acceptable range', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 50,  // 50/100 = 0.5 (within range)
                inv_down_shares: 50
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBe('UP'); // No rebalance needed
        });

        it('should not rebalance when one side is zero', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 70,  // 70/70 = 1.0 > 0.6, but DOWN is 0
                inv_down_shares: 0
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBe('UP'); // Can't compute ratio when one side is 0, allow trade
        });

        it('should handle edge case with very small inventory', () => {
            const inventoryParams: InventoryParams = {
                rebalance_ratio_R: 0.6,
                max_up_shares: 100,
                max_down_shares: 100,
                max_total_shares: 200
            };

            const inventory = {
                inv_up_shares: 0.0001,
                inv_down_shares: 0.0001
            };

            const result = engine.inventoryOkAndRebalance(inventory, inventoryParams, 'UP');
            expect(result).toBe('UP'); // Should work with small values
        });
    });

    describe('entrySignal', () => {
        it('should return no trade when entry params undefined', () => {
            const state = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            const result = engine.entrySignal(state, features, undefined);
            expect(result.should_trade).toBe(false);
            expect(result.side).toBeNull();
            expect(result.reason).toBe('no_entry_params');
        });

        it('should signal UP trade when UP price in band', () => {
            const entryParams: EntryParams = {
                up_price_min: 0.4,
                up_price_max: 0.6,
                down_price_min: null,
                down_price_max: null,
                mode: 'none',
                momentum_window_s: 5,
                momentum_threshold: 0.01
            };

            const state = {
                timestamp: 1000,
                up_px: 0.5, // In band
                down_px: 0.5,
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            const result = engine.entrySignal(state, features, entryParams);
            expect(result.should_trade).toBe(true);
            expect(result.side).toBe('UP');
            expect(result.reason).toBe('up_price_band');
        });

        it('should signal DOWN trade when DOWN price in band', () => {
            const entryParams: EntryParams = {
                up_price_min: null,
                up_price_max: null,
                down_price_min: 0.4,
                down_price_max: 0.6,
                mode: 'none',
                momentum_window_s: 5,
                momentum_threshold: 0.01
            };

            const state = {
                timestamp: 1000,
                up_px: 0.5,
                down_px: 0.5, // In band
                market: 'BTC_15m'
            };

            const features = { distance_from_50: 0.0 };

            const result = engine.entrySignal(state, features, entryParams);
            expect(result.should_trade).toBe(true);
            expect(result.side).toBe('DOWN');
            expect(result.reason).toBe('down_price_band');
        });
    });
});

