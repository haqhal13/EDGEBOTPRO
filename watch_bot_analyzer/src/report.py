"""
Reporting and output generation.
"""
import pandas as pd
import numpy as np
import json
import matplotlib.pyplot as plt
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List


def save_parameters(params: Dict[str, Any], output_dir: str = "output") -> str:
    """
    Save parameters to JSON files.
    
    Args:
        params: Inferred parameters dictionary
        output_dir: Output directory
        
    Returns:
        Path to saved file
    """
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)
    
    # Save latest
    latest_file = output_path / "params_latest.json"
    with open(latest_file, 'w') as f:
        json.dump(params, f, indent=2)
    
    # Append to history
    history_file = output_path / "params_history.jsonl"
    timestamp = datetime.now().isoformat()
    history_entry = {
        'timestamp': timestamp,
        'params': params
    }
    with open(history_file, 'a') as f:
        f.write(json.dumps(history_entry) + '\n')
    
    print(f"Parameters saved to {latest_file}")
    return str(latest_file)


def generate_diff_report(tape: pd.DataFrame, trades: pd.DataFrame, output_dir: str = "output") -> str:
    """
    Generate diff report comparing WATCH vs PAPER trades.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        output_dir: Output directory
        
    Returns:
        Path to saved CSV
    """
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)
    
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    paper_trades = trades[trades['bot'] == 'PAPER'].copy()
    
    diff_records = []
    
    for market in watch_trades['market'].unique():
        market_watch = watch_trades[watch_trades['market'] == market].copy()
        market_paper = paper_trades[paper_trades['market'] == market].copy()
        
        if len(market_paper) == 0:
            continue
        
        market_paper = market_paper.sort_values('Timestamp').reset_index(drop=True)
        
        for _, watch_trade in market_watch.iterrows():
            watch_ts = watch_trade['Timestamp']
            
            # Find nearest PAPER trade within ±2s
            time_diffs = abs(market_paper['Timestamp'] - watch_ts) / 1000.0
            within_window = time_diffs <= 2.0
            
            if within_window.any():
                nearest_idx = time_diffs[within_window].idxmin()
                paper_trade = market_paper.loc[nearest_idx]
                
                dt_ms = time_diffs[nearest_idx] * 1000
                same_side = watch_trade['side'] == paper_trade['side']
                size_ratio = paper_trade['shares'] / watch_trade['shares'] if watch_trade['shares'] > 0 else 0
                fill_px_diff = abs(watch_trade.get('fill_px', 0) - paper_trade.get('fill_px', 0))
                
                diff_records.append({
                    'market': market,
                    'watch_timestamp': watch_ts,
                    'paper_timestamp': paper_trade['Timestamp'],
                    'dt_ms': dt_ms,
                    'watch_side': watch_trade['side'],
                    'paper_side': paper_trade['side'],
                    'same_side': same_side,
                    'watch_shares': watch_trade['shares'],
                    'paper_shares': paper_trade['shares'],
                    'size_ratio': size_ratio,
                    'watch_fill_px': watch_trade.get('fill_px', 0),
                    'paper_fill_px': paper_trade.get('fill_px', 0),
                    'fill_px_diff': fill_px_diff
                })
    
    diff_df = pd.DataFrame(diff_records)
    
    if len(diff_df) > 0:
        # Add aggregate summary per market
        summary_records = []
        for market in diff_df['market'].unique():
            market_diff = diff_df[diff_df['market'] == market]
            
            summary_records.append({
                'market': market,
                'matched_pairs': len(market_diff),
                'same_side_pct': market_diff['same_side'].mean() * 100,
                'avg_dt_ms': market_diff['dt_ms'].mean(),
                'median_size_ratio': market_diff['size_ratio'].median(),
                'avg_fill_px_diff': market_diff['fill_px_diff'].mean()
            })
        
        summary_df = pd.DataFrame(summary_records)
        
        # Save both detailed and summary
        diff_file = output_path / "diff_report.csv"
        summary_file = output_path / "diff_summary.csv"
        
        diff_df.to_csv(diff_file, index=False)
        summary_df.to_csv(summary_file, index=False)
        
        print(f"Diff report saved to {diff_file}")
        print(f"Diff summary saved to {summary_file}")
        
        return str(diff_file)
    
    return None


def generate_plots(tape: pd.DataFrame, trades: pd.DataFrame, output_dir: str = "output"):
    """
    Generate validation plots per market.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        output_dir: Output directory
    """
    output_path = Path(output_dir)
    output_path.mkdir(exist_ok=True)
    
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        
        if len(market_trades) < 5:
            continue
        
        # Plot 1: Trade points over side_px vs time
        fig, axes = plt.subplots(2, 1, figsize=(12, 10))
        
        # Top: Side price over time with trade points
        market_trades = market_trades.sort_values('Timestamp')
        axes[0].plot(market_trades['Timestamp'], market_trades['side_px_at_trade'], 
                    'b-', alpha=0.3, label='Price')
        
        up_trades = market_trades[market_trades['side'] == 'UP']
        down_trades = market_trades[market_trades['side'] == 'DOWN']
        
        axes[0].scatter(up_trades['Timestamp'], up_trades['side_px_at_trade'],
                       color='green', marker='^', s=100, label='UP trades', zorder=5)
        axes[0].scatter(down_trades['Timestamp'], down_trades['side_px_at_trade'],
                       color='red', marker='v', s=100, label='DOWN trades', zorder=5)
        
        axes[0].set_xlabel('Timestamp')
        axes[0].set_ylabel('Side Price')
        axes[0].set_title(f'{market} - Trades over Time')
        axes[0].legend()
        axes[0].grid(True, alpha=0.3)
        
        # Bottom: Size vs price bucket
        if 'side_px_at_trade' in market_trades.columns:
            axes[1].scatter(market_trades['side_px_at_trade'], market_trades['shares'],
                          alpha=0.6, s=50)
            axes[1].set_xlabel('Side Price')
            axes[1].set_ylabel('Shares')
            axes[1].set_title(f'{market} - Size vs Price')
            axes[1].grid(True, alpha=0.3)
        
        plt.tight_layout()
        plot_file = output_path / f"{market.replace('/', '_')}_trades.png"
        plt.savefig(plot_file, dpi=150)
        plt.close()
        
        print(f"Plot saved: {plot_file}")
        
        # Plot 2: Inter-trade time histogram
        if len(market_trades) > 1:
            market_trades = market_trades.sort_values('Timestamp')
            inter_times = market_trades['Timestamp'].diff().dropna() / 1000.0  # Convert to seconds
            
            plt.figure(figsize=(10, 6))
            plt.hist(inter_times, bins=50, alpha=0.7, edgecolor='black')
            plt.xlabel('Inter-trade Time (seconds)')
            plt.ylabel('Frequency')
            plt.title(f'{market} - Inter-trade Time Distribution')
            plt.grid(True, alpha=0.3)
            
            hist_file = output_path / f"{market.replace('/', '_')}_inter_trade_hist.png"
            plt.savefig(hist_file, dpi=150)
            plt.close()
            
            print(f"Histogram saved: {hist_file}")


def generate_all_reports(tape: pd.DataFrame, trades: pd.DataFrame, params: Dict[str, Any], 
                        validation_results: Dict[str, Any], output_dir: str = "output"):
    """
    Generate all reports and outputs.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        params: Inferred parameters
        validation_results: Validation results
        output_dir: Output directory
    """
    print("\n=== Generating Reports ===")
    
    # Save parameters
    save_parameters(params, output_dir)
    
    # Generate diff report
    generate_diff_report(tape, trades, output_dir)
    
    # Generate plots
    generate_plots(tape, trades, output_dir)
    
    print("\nAll reports generated successfully")

