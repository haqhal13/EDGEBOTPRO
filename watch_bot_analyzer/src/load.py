"""
Data loading utilities for CSV price tapes.
"""
import pandas as pd
import numpy as np
from pathlib import Path
from typing import List, Tuple, Dict
import re


def load_all_csvs(data_dir: str = "logs/Live prices") -> pd.DataFrame:
    """
    Load all CSV files from the data directory and combine into one dataframe.
    
    Args:
        data_dir: Path to directory containing CSV files
        
    Returns:
        Combined dataframe with all rows, including 'market' column
    """
    data_path = Path(data_dir)
    if not data_path.exists():
        raise FileNotFoundError(f"Data directory not found: {data_dir}")
    
    all_data = []
    
    for csv_file in data_path.glob("*.csv"):
        # Infer market from filename: BTC_15m, ETH_15m, BTC_1h, ETH_1h
        filename = csv_file.stem
        market_match = re.match(r"(\w+)\s*-\s*(\d+)\s*(?:min|hour)", filename)
        
        if market_match:
            asset = market_match.group(1)  # BTC or ETH
            timeframe = market_match.group(2)  # 15 or 1
            
            # Normalize timeframe
            if timeframe == "15":
                tf = "15m"
            elif timeframe == "1":
                tf = "1h"
            else:
                tf = f"{timeframe}m"
            
            market = f"{asset}_{tf}"
            
            try:
                df = pd.read_csv(csv_file)
                df['market'] = market
                df['source_file'] = csv_file.name
                all_data.append(df)
                print(f"Loaded {len(df)} rows from {csv_file.name} -> {market}")
            except Exception as e:
                print(f"Error loading {csv_file.name}: {e}")
                continue
        else:
            print(f"Warning: Could not parse market from filename: {csv_file.name}")
    
    if not all_data:
        raise ValueError("No valid CSV files found")
    
    combined = pd.concat(all_data, ignore_index=True)
    print(f"\nTotal rows loaded: {len(combined)}")
    print(f"Markets found: {combined['market'].unique().tolist()}")
    
    return combined


def sanity_checks(df: pd.DataFrame) -> Dict[str, any]:
    """
    Run sanity checks on the loaded data.
    
    Args:
        df: Combined dataframe
        
    Returns:
        Dictionary with check results
    """
    results = {
        'total_rows': len(df),
        'price_sum_issues': [],
        'unparsed_notes': []
    }
    
    # Check price sums (should be close to 1.0)
    price_sums = df['Price UP ($)'] + df['Price DOWN ($)']
    outliers = df[abs(price_sums - 1.0) > 0.05].copy()
    
    if len(outliers) > 0:
        results['price_sum_issues'] = {
            'count': len(outliers),
            'max_deviation': abs(price_sums - 1.0).max(),
            'sample_rows': outliers[['Timestamp', 'Price UP ($)', 'Price DOWN ($)', 'market']].head(10).to_dict('records')
        }
        print(f"Warning: {len(outliers)} rows have UP + DOWN price sums deviating >0.05 from 1.0")
    
    # Check for unparsed Notes (non-empty Notes that don't match expected pattern)
    notes_with_data = df[df['Notes'].notna() & (df['Notes'] != '')]
    if len(notes_with_data) > 0:
        # This will be checked in parse.py, but log here
        results['notes_with_data'] = len(notes_with_data)
    
    return results


def get_trade_rows(df: pd.DataFrame) -> pd.DataFrame:
    """
    Extract only rows that contain trades (Watch Mode Entry or Paper Mode Entry is YES).
    
    Args:
        df: Combined dataframe
        
    Returns:
        Dataframe with only trade rows
    """
    trade_mask = (
        (df['Watch Mode Entry'] == 'YES') | 
        (df['Paper Mode Entry'] == 'YES')
    )
    trades = df[trade_mask].copy()
    print(f"Extracted {len(trades)} trade rows from {len(df)} total rows")
    return trades

