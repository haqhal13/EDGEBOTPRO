# WATCH Bot Parameter Inference

This project analyzes CSV price tapes to infer the WATCH bot's trading parameters and generate a parameter file for the PAPER bot to replicate similar behavior.

## Project Structure

```
watch_bot_analyzer/
├── src/
│   ├── __init__.py
│   ├── load.py          # Data loading utilities
│   ├── parse.py         # Trade note parsing
│   ├── features.py      # Feature engineering
│   ├── infer.py         # Parameter inference
│   ├── validate.py      # Model validation
│   └── report.py        # Report generation
├── output/              # Generated outputs
├── requirements.txt     # Python dependencies
├── run.py              # Main pipeline
└── README.md           # This file
```

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Ensure CSV files are in `logs/Live prices/` directory:
   - `BTC - 15 min prices_*.csv`
   - `ETH - 15 min prices_*.csv`
   - `BTC - 1 hour prices_*.csv`
   - `ETH - 1 hour prices_*.csv`

## Usage

Run the complete pipeline:

```bash
python run.py
```

## Output Files

After running, the following files will be generated in the `output/` directory:

### Parameter Files
- **`params_latest.json`**: Latest inferred parameters in JSON format
- **`params_history.jsonl`**: Historical parameter snapshots (JSONL format)

### Reports
- **`diff_report.csv`**: Detailed comparison of WATCH vs PAPER trades
- **`diff_summary.csv`**: Aggregated summary per market

### Visualizations
- **`{market}_trades.png`**: Trade points plotted over price vs time, and size vs price scatter
- **`{market}_inter_trade_hist.png`**: Inter-trade time distribution histogram

## Parameter Structure

The inferred parameters follow this structure:

```json
{
  "entry_params": {
    "per_market": {
      "BTC_15m": {
        "up_price_min": 0.0,
        "up_price_max": 1.0,
        "down_price_min": 0.0,
        "down_price_max": 1.0,
        "momentum_window_s": 5.0,
        "momentum_threshold": 0.005,
        "mode": "momentum" | "reversion" | "none"
      }
    }
  },
  "size_params": {
    "per_market": {
      "BTC_15m": {
        "bin_edges": [0.0, 0.05, ...],
        "size_table": {"(0.0, 0.05]": 12.5, ...},
        "conditioning_var": null
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
        "p50_inter_trade_ms": 2000.0,
        "p95_inter_trade_ms": 5000.0,
        "max_trades_per_sec": 5,
        "max_trades_per_min": 30
      }
    }
  }
}
```

## Validation Metrics

The pipeline outputs validation metrics:
- **Recall**: Percentage of actual WATCH trades explained by the policy
- **Precision**: Percentage of policy trades that match actual WATCH trades
- **Side Accuracy**: Percentage of matched trades with correct side (UP/DOWN)
- **Size MAPE**: Mean Absolute Percentage Error on trade sizes

## Notes

- The inference uses simple, interpretable rules (thresholds, buckets) rather than black-box ML models
- Parameters are inferred per market (BTC_15m, ETH_15m, BTC_1h, ETH_1h)
- The policy simulator replays the tape to validate inferred parameters
- All code includes type hints and docstrings for maintainability

