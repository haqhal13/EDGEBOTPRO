/**
 * Parameter loader with hot-reload support for params_latest.json
 */
import * as fs from 'fs';
import * as path from 'path';

export interface EntryParams {
    up_price_min: number | null;
    up_price_max: number | null;
    down_price_min: number | null;
    down_price_max: number | null;
    momentum_window_s: number;
    momentum_threshold: number;
    mode: 'momentum' | 'reversion' | 'none';
}

export interface SizeParams {
    bin_edges: number[];
    size_table: Record<string, number>;
    size_table_mean?: Record<string, number>;
    conditioning_var?: string | null;
}

export interface InventoryParams {
    rebalance_ratio_R: number;
    max_up_shares: number;
    max_down_shares: number;
    max_total_shares: number;
}

export interface CadenceParams {
    min_inter_trade_ms: number;
    p50_inter_trade_ms: number;
    p95_inter_trade_ms: number;
    max_trades_per_sec: number;
    max_trades_per_min: number;
}

export interface MarketParams {
    entry_params?: EntryParams;
    size_params?: SizeParams;
    inventory_params?: InventoryParams;
    cadence_params?: CadenceParams;
}

export interface ParameterFile {
    entry_params?: {
        per_market: Record<string, EntryParams>;
    };
    size_params?: {
        per_market: Record<string, SizeParams>;
    };
    inventory_params?: {
        per_market: Record<string, InventoryParams>;
    };
    cadence_params?: {
        per_market: Record<string, CadenceParams>;
    };
}

class ParameterLoader {
    private params: ParameterFile | null = null;
    private paramsPath: string;
    private lastModified: number = 0;
    private pollInterval: NodeJS.Timeout | null = null;
    private listeners: Array<(params: ParameterFile) => void> = [];

    constructor(paramsPath: string = 'watch_bot_analyzer/output/params_latest.json') {
        this.paramsPath = path.resolve(paramsPath);
    }

    /**
     * Load parameters from file with validation and defaults
     */
    loadParams(): ParameterFile {
        try {
            if (!fs.existsSync(this.paramsPath)) {
                console.warn(`Parameter file not found: ${this.paramsPath}, using defaults`);
                return this.getDefaultParams();
            }

            const fileContent = fs.readFileSync(this.paramsPath, 'utf8');
            const parsed = JSON.parse(fileContent) as ParameterFile;

            // Validate structure
            this.validateParams(parsed);

            // Update timestamp
            const stats = fs.statSync(this.paramsPath);
            this.lastModified = stats.mtimeMs;

            this.params = parsed;
            return parsed;
        } catch (error) {
            console.error(`Error loading parameters from ${this.paramsPath}:`, error);
            return this.getDefaultParams();
        }
    }

    /**
     * Get default parameters if file doesn't exist or is invalid
     */
    private getDefaultParams(): ParameterFile {
        return {
            entry_params: { per_market: {} },
            size_params: { per_market: {} },
            inventory_params: { per_market: {} },
            cadence_params: { per_market: {} }
        };
    }

    /**
     * Validate parameter structure
     */
    private validateParams(params: ParameterFile): void {
        // Basic validation - ensure structure exists
        if (!params.entry_params) params.entry_params = { per_market: {} };
        if (!params.size_params) params.size_params = { per_market: {} };
        if (!params.inventory_params) params.inventory_params = { per_market: {} };
        if (!params.cadence_params) params.cadence_params = { per_market: {} };

        // Validate per-market entries have expected structure
        // (Could add more detailed validation here)
    }

    /**
     * Get current parameters (loads if not already loaded)
     */
    getParams(): ParameterFile {
        if (!this.params) {
            this.params = this.loadParams();
        }
        return this.params;
    }

    /**
     * Get parameters for a specific market
     */
    getMarketParams(marketKey: string): MarketParams {
        const params = this.getParams();
        
        // Convert market key format (e.g., "BTC-UpDown-15" -> "BTC_15m")
        const normalizedKey = this.normalizeMarketKey(marketKey);

        return {
            entry_params: params.entry_params?.per_market[normalizedKey],
            size_params: params.size_params?.per_market[normalizedKey],
            inventory_params: params.inventory_params?.per_market[normalizedKey],
            cadence_params: params.cadence_params?.per_market[normalizedKey]
        };
    }

    /**
     * Normalize market key to match parameter file format
     * "BTC-UpDown-15" -> "BTC_15m"
     * "ETH-UpDown-15" -> "ETH_15m"
     * "BTC-UpDown-1h" -> "BTC_1h"
     * "ETH-UpDown-1h" -> "ETH_1h"
     */
    private normalizeMarketKey(marketKey: string): string {
        // Handle different formats
        if (marketKey.includes('BTC') && marketKey.includes('15')) return 'BTC_15m';
        if (marketKey.includes('ETH') && marketKey.includes('15')) return 'ETH_15m';
        if (marketKey.includes('BTC') && (marketKey.includes('1h') || marketKey.includes('1 hour'))) return 'BTC_1h';
        if (marketKey.includes('ETH') && (marketKey.includes('1h') || marketKey.includes('1 hour'))) return 'ETH_1h';
        
        // Try direct match
        return marketKey;
    }

    /**
     * Start hot-reload polling (safe + atomic)
     */
    startHotReload(pollIntervalMs: number = 3000): void {
        if (this.pollInterval) {
            return; // Already running
        }

        // Initial load
        this.params = this.loadParams();

        this.pollInterval = setInterval(() => {
            try {
                if (!fs.existsSync(this.paramsPath)) {
                    return;
                }

                const stats = fs.statSync(this.paramsPath);
                if (stats.mtimeMs > this.lastModified) {
                    // File changed, reload atomically
                    const newParams = this.loadParams();
                    this.params = newParams;

                    // Notify listeners
                    this.listeners.forEach(listener => {
                        try {
                            listener(newParams);
                        } catch (error) {
                            console.error('Error in parameter reload listener:', error);
                        }
                    });

                    console.log(`Parameters reloaded from ${this.paramsPath}`);
                }
            } catch (error) {
                console.error('Error checking parameter file:', error);
            }
        }, pollIntervalMs);

        console.log(`Hot-reload started for ${this.paramsPath} (polling every ${pollIntervalMs}ms)`);
    }

    /**
     * Stop hot-reload polling
     */
    stopHotReload(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
    }

    /**
     * Add listener for parameter reload events
     */
    onReload(listener: (params: ParameterFile) => void): void {
        this.listeners.push(listener);
    }

    /**
     * Remove listener
     */
    offReload(listener: (params: ParameterFile) => void): void {
        const index = this.listeners.indexOf(listener);
        if (index > -1) {
            this.listeners.splice(index, 1);
        }
    }
}

// Singleton instance
let loaderInstance: ParameterLoader | null = null;

export function getParamLoader(paramsPath?: string): ParameterLoader {
    if (!loaderInstance) {
        loaderInstance = new ParameterLoader(paramsPath);
    }
    return loaderInstance;
}

export function loadParams(paramsPath?: string): ParameterFile {
    return getParamLoader(paramsPath).getParams();
}

