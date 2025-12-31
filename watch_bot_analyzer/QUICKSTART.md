# Quick Start Guide

## Setup

1. **Install dependencies:**
```bash
cd watch_bot_analyzer
pip install -r requirements.txt
```

2. **Ensure CSV files exist:**
   - CSV files should be in `../logs/Live prices/` (relative to watch_bot_analyzer)
   - Or adjust path in `run.py` if files are elsewhere

## Run Analysis

```bash
python run.py
```

## What It Does

1. **Loads** all 4 CSV files (BTC/ETH 15m + 1h)
2. **Parses** trade notes to extract bot, side, shares, fill price
3. **Engineers features** for WATCH trades:
   - Price changes (1s, 5s, 30s)
   - Volatility metrics
   - Distance from 50/50
   - Inter-trade times
   - Trade burst rates

4. **Infers parameters**:
   - Entry rules (price bands, momentum/reversion)
   - Sizing function (shares per price bucket)
   - Inventory behavior (rebalance ratios, max positions)
   - Cadence (inter-trade times, max trades per window)

5. **Validates** model by simulating policy and comparing to actual trades

6. **Generates** outputs:
   - `output/params_latest.json` - Parameters for PAPER bot
   - `output/diff_report.csv` - WATCH vs PAPER comparison
   - `output/*.png` - Visualizations

## Expected Output

The pipeline will print:
- Number of rows loaded per CSV
- Number of trades parsed (WATCH vs PAPER)
- Inferred parameters summary
- Validation metrics (recall, precision, side accuracy, size MAPE)
- File paths for generated outputs

## Using Parameters

The PAPER bot can load `output/params_latest.json` to replicate WATCH bot behavior using the inferred parameterized policy (not 1:1 trade copying).

