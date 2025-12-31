"""
Parse trade notes from CSV files into structured data.
"""
import pandas as pd
import numpy as np
import re
from typing import Dict, List, Tuple


def parse_notes(df: pd.DataFrame) -> pd.DataFrame:
    """
    Parse Notes column to extract trade information.
    
    Expected format: "WATCH: UP 12.5000 shares @ $0.2300" or "PAPER: DOWN 5.0866 shares @ $0.9122"
    
    Args:
        df: Dataframe with Notes column
        
    Returns:
        Dataframe with added columns: bot, side, shares, fill_px
    """
    df = df.copy()
    
    # Initialize new columns
    df['bot'] = np.nan
    df['side'] = np.nan
    df['shares'] = np.nan
    df['fill_px'] = np.nan
    df['notes_parsed'] = False
    
    # Regex pattern to match trade notes
    # Matches: "WATCH: UP 12.5000 shares @ $0.2300" or "PAPER: DOWN 5.0866 shares @ $0.9122"
    pattern = r'(WATCH|PAPER):\s*(UP|DOWN)\s+([\d.]+)\s+shares\s+@\s+\$([\d.]+)'
    
    unparsed = []
    
    for idx, row in df.iterrows():
        notes = row.get('Notes', '')
        
        if pd.isna(notes) or notes == '':
            continue
        
        # Remove quotes if present
        notes = str(notes).strip().strip('"').strip("'")
        
        match = re.search(pattern, notes, re.IGNORECASE)
        
        if match:
            df.at[idx, 'bot'] = match.group(1).upper()
            df.at[idx, 'side'] = match.group(2).upper()
            df.at[idx, 'shares'] = float(match.group(3))
            df.at[idx, 'fill_px'] = float(match.group(4))
            df.at[idx, 'notes_parsed'] = True
        else:
            unparsed.append({
                'index': idx,
                'market': row.get('market', 'unknown'),
                'notes': notes
            })
    
    # Convert numeric columns
    df['shares'] = pd.to_numeric(df['shares'], errors='coerce')
    df['fill_px'] = pd.to_numeric(df['fill_px'], errors='coerce')
    
    parsed_count = df['notes_parsed'].sum()
    total_notes = df['Notes'].notna().sum()
    
    print(f"Parsed {parsed_count} out of {total_notes} notes with trade data")
    
    if unparsed:
        print(f"Warning: {len(unparsed)} notes could not be parsed:")
        for item in unparsed[:10]:  # Show first 10
            print(f"  Market: {item['market']}, Notes: {item['notes']}")
        if len(unparsed) > 10:
            print(f"  ... and {len(unparsed) - 10} more")
    
    return df, unparsed


def add_trade_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Add derived features for trade rows.
    
    Args:
        df: Dataframe with parsed trade data
        
    Returns:
        Dataframe with additional columns
    """
    df = df.copy()
    
    # Convert timestamp to datetime if not already
    if 'Timestamp' in df.columns:
        df['datetime'] = pd.to_datetime(df['Timestamp'], unit='ms', utc=True)
    elif 'Date' in df.columns:
        df['datetime'] = pd.to_datetime(df['Date'], utc=True)
    else:
        raise ValueError("No timestamp column found")
    
    # Sort by timestamp for proper feature computation
    df = df.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    # Add side price at trade time (UP trades use Price UP, DOWN trades use Price DOWN)
    df['side_px_at_trade'] = np.where(
        df['side'] == 'UP',
        df['Price UP ($)'],
        df['Price DOWN ($)']
    )
    
    # For trade rows, compute time since last trade (per market)
    df['time_since_last_trade_ms'] = np.nan
    
    for market in df['market'].unique():
        market_mask = df['market'] == market
        market_df = df[market_mask].copy()
        market_df = market_df.sort_values('Timestamp')
        
        time_diffs = market_df['Timestamp'].diff()
        df.loc[market_mask, 'time_since_last_trade_ms'] = time_diffs.values
    
    return df


def prepare_tape(df: pd.DataFrame) -> pd.DataFrame:
    """
    Prepare the full price tape dataframe with proper sorting and indexing.
    
    Args:
        df: Combined dataframe from load.py
        
    Returns:
        Prepared dataframe sorted by market and timestamp
    """
    df = df.copy()
    
    # Convert timestamp to datetime
    if 'Timestamp' in df.columns:
        df['datetime'] = pd.to_datetime(df['Timestamp'], unit='ms', utc=True)
    elif 'Date' in df.columns:
        df['datetime'] = pd.to_datetime(df['Date'], utc=True)
    
    # Sort by market and timestamp
    df = df.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    # Ensure price columns are numeric
    df['Price UP ($)'] = pd.to_numeric(df['Price UP ($)'], errors='coerce')
    df['Price DOWN ($)'] = pd.to_numeric(df['Price DOWN ($)'], errors='coerce')
    
    return df

