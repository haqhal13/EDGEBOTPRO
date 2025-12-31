"""
Feature engineering for WATCH bot trades.
"""
import pandas as pd
import numpy as np
from typing import Dict, Tuple


def compute_price_changes(tape: pd.DataFrame, trades: pd.DataFrame, windows_ms: List[int]) -> pd.DataFrame:
    """
    Compute price changes over various time windows for each trade.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        windows_ms: List of time windows in milliseconds (e.g., [1000, 5000, 30000])
        
    Returns:
        Trades dataframe with added price change columns
    """
    trades = trades.copy()
    
    # Sort both dataframes
    tape = tape.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    trades = trades.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    for window_ms in windows_ms:
        window_s = window_ms / 1000.0
        
        # Initialize columns
        trades[f'delta_{window_s}s_side_px'] = np.nan
        trades[f'delta_{window_s}s_up_px'] = np.nan
        trades[f'delta_{window_s}s_down_px'] = np.nan
        
        for market in trades['market'].unique():
            market_tape = tape[tape['market'] == market].copy()
            market_trades = trades[trades['market'] == market].copy()
            
            if len(market_tape) == 0:
                continue
            
            # Create index on timestamp for faster lookup
            market_tape = market_tape.set_index('Timestamp')
            
            for idx, trade_row in market_trades.iterrows():
                trade_ts = trade_row['Timestamp']
                
                # Find price at trade time and window_ms before
                before_ts = trade_ts - window_ms
                
                # Get closest prices
                try:
                    current_up = market_tape.loc[trade_ts, 'Price UP ($)']
                    current_down = market_tape.loc[trade_ts, 'Price DOWN ($)']
                    
                    # Find closest timestamp before
                    before_rows = market_tape[market_tape.index <= before_ts]
                    if len(before_rows) > 0:
                        before_ts_actual = before_rows.index[-1]
                        before_up = market_tape.loc[before_ts_actual, 'Price UP ($)']
                        before_down = market_tape.loc[before_ts_actual, 'Price DOWN ($)']
                        
                        # Compute deltas
                        trades.loc[idx, f'delta_{window_s}s_up_px'] = current_up - before_up
                        trades.loc[idx, f'delta_{window_s}s_down_px'] = current_down - before_down
                        
                        # Side-specific delta
                        if trade_row['side'] == 'UP':
                            trades.loc[idx, f'delta_{window_s}s_side_px'] = current_up - before_up
                        else:
                            trades.loc[idx, f'delta_{window_s}s_side_px'] = current_down - before_down
                except (KeyError, IndexError):
                    # Trade timestamp not found in tape, skip
                    continue
    
    return trades


def compute_volatility(tape: pd.DataFrame, trades: pd.DataFrame, windows_ms: List[int]) -> pd.DataFrame:
    """
    Compute rolling volatility proxies for each trade.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        windows_ms: List of time windows in milliseconds
        
    Returns:
        Trades dataframe with added volatility columns
    """
    trades = trades.copy()
    tape = tape.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    for window_ms in windows_ms:
        window_s = window_ms / 1000.0
        
        trades[f'volatility_{window_s}s'] = np.nan
        
        for market in trades['market'].unique():
            market_tape = tape[tape['market'] == market].copy()
            market_trades = trades[trades['market'] == market].copy()
            
            if len(market_tape) == 0:
                continue
            
            market_tape = market_tape.set_index('Timestamp')
            
            for idx, trade_row in market_trades.iterrows():
                trade_ts = trade_row['Timestamp']
                window_start = trade_ts - window_ms
                
                # Get price window
                window_prices = market_tape[
                    (market_tape.index >= window_start) & 
                    (market_tape.index <= trade_ts)
                ]
                
                if len(window_prices) > 1:
                    # Use side-specific price
                    if trade_row['side'] == 'UP':
                        price_col = 'Price UP ($)'
                    else:
                        price_col = 'Price DOWN ($)'
                    
                    prices = window_prices[price_col].values
                    if len(prices) > 1:
                        trades.loc[idx, f'volatility_{window_s}s'] = np.std(prices)
    
    return trades


def compute_distance_features(trades: pd.DataFrame) -> pd.DataFrame:
    """
    Compute distance from 50/50 and other geometric features.
    
    Args:
        trades: Trade rows dataframe
        
    Returns:
        Trades dataframe with added distance columns
    """
    trades = trades.copy()
    
    # Distance from 50/50 for UP price
    trades['distance_from_50'] = abs(trades['Price UP ($)'] - 0.5)
    
    return trades


def compute_trade_burst_metrics(trades: pd.DataFrame, window_s: int = 10) -> pd.DataFrame:
    """
    Compute trade burst metrics (trades per time window).
    
    Args:
        trades: Trade rows dataframe
        window_s: Time window in seconds
        
    Returns:
        Trades dataframe with added burst columns
    """
    trades = trades.copy()
    trades = trades.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    trades['trades_per_10s'] = np.nan
    trades['trades_per_60s'] = np.nan
    
    for market in trades['market'].unique():
        market_trades = trades[trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp')
        
        window_ms_10s = 10 * 1000
        window_ms_60s = 60 * 1000
        
        for idx, trade_row in market_trades.iterrows():
            trade_ts = trade_row['Timestamp']
            
            # Count trades in window
            window_start_10s = trade_ts - window_ms_10s
            window_start_60s = trade_ts - window_ms_60s
            
            count_10s = ((market_trades['Timestamp'] >= window_start_10s) & 
                        (market_trades['Timestamp'] <= trade_ts)).sum()
            count_60s = ((market_trades['Timestamp'] >= window_start_60s) & 
                        (market_trades['Timestamp'] <= trade_ts)).sum()
            
            trades.loc[idx, 'trades_per_10s'] = count_10s
            trades.loc[idx, 'trades_per_60s'] = count_60s
    
    return trades


def engineer_features(tape: pd.DataFrame, trades: pd.DataFrame) -> pd.DataFrame:
    """
    Main feature engineering function that computes all features for WATCH trades.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        
    Returns:
        Trades dataframe with all engineered features
    """
    print("Engineering features...")
    
    # Filter to WATCH trades only for analysis (but work with all trades)
    watch_trades_mask = trades['bot'] == 'WATCH'
    watch_trades = trades[watch_trades_mask].copy()
    
    if len(watch_trades) == 0:
        print("Warning: No WATCH trades found")
        return trades
    
    print(f"Computing features for {len(watch_trades)} WATCH trades...")
    
    # Compute price changes
    watch_trades = compute_price_changes(tape, watch_trades, [1000, 5000, 30000])
    
    # Compute volatility
    watch_trades = compute_volatility(tape, watch_trades, [5000, 30000])
    
    # Compute distance features
    watch_trades = compute_distance_features(watch_trades)
    
    # Compute burst metrics
    watch_trades = compute_trade_burst_metrics(watch_trades)
    
    # Merge features back into full trades dataframe
    # Use merge on Timestamp and market to preserve all trades
    feature_cols = [col for col in watch_trades.columns 
                   if col not in trades.columns and col not in ['bot', 'side', 'shares', 'fill_px']]
    
    if feature_cols:
        merge_cols = ['Timestamp', 'market'] + feature_cols
        trades = trades.merge(
            watch_trades[merge_cols],
            on=['Timestamp', 'market'],
            how='left',
            suffixes=('', '_new')
        )
    
    print("Feature engineering complete")
    return trades

