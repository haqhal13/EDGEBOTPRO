# WATCH Bot Parameter Inference - Project Summary

## Overview

This Python project analyzes CSV price tapes to infer WATCH bot trading parameters and generate a parameter file for the PAPER bot.

## Key Components

### 1. Data Loading (`src/load.py`)
- Loads all CSV files from `logs/Live prices/`
- Infers market type from filename (BTC_15m, ETH_15m, BTC_1h, ETH_1h)
- Performs sanity checks (price sums ≈ 1.0)
- Extracts trade rows (Watch Mode Entry = YES or Paper Mode Entry = YES)

### 2. Parsing (`src/parse.py`)
- Parses Notes column with regex to extract:
  - Bot type (WATCH/PAPER)
  - Side (UP/DOWN)
  - Shares (float)
  - Fill price (float)
- Adds basic trade features (timestamp, side price at trade time)

### 3. Feature Engineering (`src/features.py`)
For each WATCH trade, computes:
- Price changes: Δ1s, Δ5s, Δ30s for side price and UP/DOWN separately
- Volatility proxies: rolling std over 5s/30s
- Distance from 50/50: abs(up_px - 0.5)
- Time since last trade
- Trade burst metrics: trades per 10s/60s

### 4. Parameter Inference (`src/infer.py`)

#### A) Entry Rules
- Infers price bands (min/max) for UP and DOWN trades
- Detects momentum vs mean reversion patterns
- Returns interpretable thresholds

#### B) Sizing Function
- Buckets side price into bins (0.00-0.05, 0.05-0.10, ...)
- Computes median shares per bucket
- Creates size lookup table

#### C) Inventory/Reorder Behavior
- Simulates inventory forward from trades
- Detects rebalance events (buying opposite side)
- Infers rebalance ratio and max inventory caps

#### D) Cadence
- Computes inter-trade time statistics (min, p50, p95)
- Estimates max trades per second and per minute

### 5. Validation (`src/validate.py`)
- Policy simulator that replays tape using inferred parameters
- Compares simulated vs actual trades:
  - Recall (coverage)
  - Precision (accuracy)
  - Side accuracy
  - Size MAPE

### 6. Reporting (`src/report.py`)
- Saves parameters to JSON (latest + history)
- Generates diff report comparing WATCH vs PAPER
- Creates visualizations:
  - Trade points over price vs time
  - Size vs price scatter
  - Inter-trade time histograms

## Output Files

All outputs go to `output/` directory:

1. **params_latest.json**: Latest inferred parameters
2. **params_history.jsonl**: Historical parameter snapshots
3. **diff_report.csv**: Detailed WATCH vs PAPER comparison
4. **diff_summary.csv**: Aggregated summary per market
5. **{market}_trades.png**: Trade visualization plots
6. **{market}_inter_trade_hist.png**: Inter-trade time distributions

## Usage

```bash
cd watch_bot_analyzer
pip install -r requirements.txt
python run.py
```

The pipeline will:
1. Load all CSV files
2. Parse trade notes
3. Engineer features
4. Infer parameters
5. Validate model
6. Generate reports

## Parameter Format

Parameters are organized per market with interpretable rules (no black-box ML). The PAPER bot can load `params_latest.json` and use these parameters to replicate WATCH bot behavior without copying trades 1:1.

