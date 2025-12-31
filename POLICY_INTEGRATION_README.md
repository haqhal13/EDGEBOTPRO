# Policy Integration - How PAPER Uses params_latest.json

## Overview

The PAPER bot now uses inferred parameters from `watch_bot_analyzer/output/params_latest.json` to make trading decisions instead of hardcoded logic. This allows the PAPER bot to replicate WATCH bot behavior using a parameterized policy.

## Architecture

### Components

1. **`src/services/paramLoader.ts`** - Parameter loading with hot-reload
   - Loads `params_latest.json` on startup
   - Hot-reloads every 3 seconds if file changes
   - Provides market-specific parameters (entry, size, inventory, cadence)

2. **`src/services/policyEngine.ts`** - Policy execution engine
   - `computeFeatures()` - Computes price deltas, volatility, distance metrics
   - `entrySignal()` - Determines if/when to trade based on entry params
   - `sizeForTrade()` - Calculates trade size from bucketed size tables
   - `inventoryOkAndRebalance()` - Checks inventory limits and applies rebalance logic
   - `cadenceOk()` - Enforces minimum inter-trade times and max trades per window

3. **`src/services/policyIntegrator.ts`** - Integration layer
   - Maintains price history per market
   - Tracks inventory state (UP/DOWN shares)
   - Records trade timestamps for cadence tracking
   - Main `shouldTrade()` function that orchestrates policy decisions

### Integration Point

The policy engine is integrated into `src/services/paperTradeMonitor.ts` in the `buildPositionIncrementally()` function:

1. Price history is updated on each market tick
2. Policy engine is consulted to determine if a trade should be made
3. If policy says to trade, the side and shares are determined
4. Trade is executed and logged to CSV using the same format as before
5. Inventory and cadence state is updated

## Parameter File Structure

The `params_latest.json` file contains:

```json
{
  "entry_params": {
    "per_market": {
      "BTC_15m": {
        "up_price_min": 0.35,
        "up_price_max": 0.65,
        "down_price_min": 0.35,
        "down_price_max": 0.65,
        "momentum_window_s": 5.0,
        "momentum_threshold": 0.005,
        "mode": "momentum" | "reversion" | "none"
      }
    }
  },
  "size_params": {
    "per_market": {
      "BTC_15m": {
        "bin_edges": [0.0, 0.05, 0.10, ...],
        "size_table": {"(0.0, 0.05]": 12.5, ...}
      }
    }
  },
  "inventory_params": {
    "per_market": {
      "BTC_15m": {
        "rebalance_ratio_R": 0.75,
        "max_up_shares": 1000.0,
        "max_down_shares": 1000.0,
        "max_total_shares": 2000.0
      }
    }
  },
  "cadence_params": {
    "per_market": {
      "BTC_15m": {
        "min_inter_trade_ms": 100.0,
        "max_trades_per_sec": 5,
        "max_trades_per_min": 30
      }
    }
  }
}
```

## Decision Flow

For each market tick:

1. **Update Price History** - Add current prices to history buffer
2. **Check Cadence** - Verify enough time since last trade and within rate limits
3. **Entry Signal** - Check if current prices fall within entry bands and momentum/reversion conditions
4. **Size Calculation** - Look up trade size from price bucket table
5. **Inventory Check** - Verify inventory limits and apply rebalance logic if needed
6. **Execute Trade** - If all checks pass, execute trade and log to CSV
7. **Update State** - Record trade timestamp and update inventory

## Hot Reload

The parameter loader polls `params_latest.json` every 3 seconds. If the file changes:
- Parameters are reloaded atomically
- New parameters take effect on the next policy check
- No bot restart required

## CSV Logging Format

Trades are logged in the same format as before:

```
Paper Mode Entry = "YES"
Notes = "PAPER: UP 12.5000 shares @ $0.0450"
```

The fill price uses the mid-market price (same convention as before).

## Parity Diagnostics

Run parity diagnostics to compare PAPER vs WATCH trades:

```bash
ts-node scripts/diagnose-parity.ts --log-dir "logs/Live prices"
```

This will:
- Match PAPER trades to WATCH trades within ±2 seconds
- Report match percentage, same-side rate, size ratios, and fill price differences
- Show top 10 worst mismatches with timestamps and notes

## Generating Parameters

To generate `params_latest.json`:

1. Run the parameter inference pipeline:
   ```bash
   cd watch_bot_analyzer
   python run.py
   ```

2. The parameters will be written to `watch_bot_analyzer/output/params_latest.json`

3. The PAPER bot will automatically pick up the parameters (hot-reload enabled)

## Notes

- The policy engine uses deterministic logic (no randomness in policy decisions)
- All parameters are per-market (BTC_15m, ETH_15m, BTC_1h, ETH_1h)
- If parameters are missing for a market, the bot falls back to default behavior
- Policy decisions are logged with a unique decision ID for traceability

