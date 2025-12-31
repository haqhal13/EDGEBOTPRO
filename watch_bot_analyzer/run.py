#!/usr/bin/env python3
"""
Main pipeline for WATCH bot parameter inference.
"""
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

from src.load import load_all_csvs, sanity_checks, get_trade_rows
from src.parse import parse_notes, add_trade_features, prepare_tape
from src.features import engineer_features
from src.infer import infer_all_parameters
from src.validate import validate_model
from src.report import generate_all_reports


def main():
    """Main execution pipeline."""
    print("=" * 80)
    print("WATCH Bot Parameter Inference Pipeline")
    print("=" * 80)
    
    # Step 1: Load data
    print("\n[1/6] Loading CSV files...")
    # Try relative path from project root first
    data_dir = "logs/Live prices"
    try:
        tape = load_all_csvs(data_dir)
    except FileNotFoundError:
        # Try from watch_bot_analyzer directory
        data_dir = "../logs/Live prices"
        tape = load_all_csvs(data_dir)
    
    # Sanity checks
    print("\n[1.5/6] Running sanity checks...")
    check_results = sanity_checks(tape)
    print(f"Sanity check results: {check_results}")
    
    # Step 2: Parse trade notes
    print("\n[2/6] Parsing trade notes...")
    tape = prepare_tape(tape)
    trades = get_trade_rows(tape)
    trades, unparsed = parse_notes(trades)
    trades = add_trade_features(trades)
    
    print(f"Total trades: {len(trades)}")
    print(f"WATCH trades: {len(trades[trades['bot'] == 'WATCH'])}")
    print(f"PAPER trades: {len(trades[trades['bot'] == 'PAPER'])}")
    
    # Step 3: Feature engineering
    print("\n[3/6] Engineering features...")
    trades = engineer_features(tape, trades)
    
    # Step 4: Parameter inference
    print("\n[4/6] Inferring parameters...")
    params = infer_all_parameters(tape, trades)
    
    # Print summary
    print("\n=== Inferred Parameters Summary ===")
    for param_type, param_data in params.items():
        if 'per_market' in param_data:
            print(f"\n{param_type}:")
            for market, market_params in param_data['per_market'].items():
                print(f"  {market}:")
                for key, value in market_params.items():
                    if isinstance(value, dict):
                        print(f"    {key}: {len(value)} entries")
                    else:
                        print(f"    {key}: {value}")
    
    # Step 5: Model validation
    print("\n[5/6] Validating model...")
    validation_results = validate_model(tape, trades, params)
    
    # Step 6: Generate reports
    print("\n[6/6] Generating reports...")
    generate_all_reports(tape, trades, params, validation_results, "output")
    
    print("\n" + "=" * 80)
    print("Pipeline Complete!")
    print("=" * 80)
    print("\nOutput files:")
    print("  - output/params_latest.json")
    print("  - output/params_history.jsonl")
    print("  - output/diff_report.csv")
    print("  - output/diff_summary.csv")
    print("  - output/*_trades.png")
    print("  - output/*_inter_trade_hist.png")


if __name__ == "__main__":
    main()

