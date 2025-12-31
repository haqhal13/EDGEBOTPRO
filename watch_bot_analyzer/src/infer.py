"""
Parameter inference for WATCH bot behavior.
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple, Any
from scipy import stats
import json
import copy


def infer_entry_rules(trades: pd.DataFrame, tape: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer entry rules (price bands and momentum/reversion patterns).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        tape: Full price tape dataframe
        
    Returns:
        Dictionary with entry parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    entry_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_tape = tape[tape['market'] == market].copy()
        
        if len(market_trades) < 5:  # Need minimum trades
            continue
        
        # Get UP and DOWN trades separately
        up_trades = market_trades[market_trades['side'] == 'UP']
        down_trades = market_trades[market_trades['side'] == 'DOWN']
        
        # Price bands
        up_price_min = up_trades['Price UP ($)'].min() if len(up_trades) > 0 else None
        up_price_max = up_trades['Price UP ($)'].max() if len(up_trades) > 0 else None
        down_price_min = down_trades['Price DOWN ($)'].min() if len(down_trades) > 0 else None
        down_price_max = down_trades['Price DOWN ($)'].max() if len(down_trades) > 0 else None
        
        # Momentum analysis - check correlation with price changes
        mode = "none"
        momentum_window_s = 5.0
        momentum_threshold = 0.0
        
        if 'delta_5s_side_px' in market_trades.columns:
            # Check if trades correlate with price movement direction
            # Positive correlation = momentum (buy when price going up)
            # Negative correlation = reversion (buy when price going down)
            
            valid_deltas = market_trades['delta_5s_side_px'].dropna()
            if len(valid_deltas) > 10:
                # Simple heuristic: check correlation between trade side and price movement
                # For UP trades: positive delta = price going up (momentum)
                # For DOWN trades: negative delta (price going down) = momentum
                up_trade_deltas = market_trades[market_trades['side'] == 'UP']['delta_5s_side_px'].dropna()
                down_trade_deltas = market_trades[market_trades['side'] == 'DOWN']['delta_5s_side_px'].dropna()
                
                if len(up_trade_deltas) > 5 and len(down_trade_deltas) > 5:
                    # Check if UP trades happen when UP price is rising (momentum)
                    # or falling (reversion)
                    up_median = up_trade_deltas.median()
                    down_median = down_trade_deltas.median()
                    
                    # For momentum: UP trades when UP rising, DOWN trades when DOWN rising (price falling)
                    # For reversion: opposite
                    if up_median > 0.005 and down_median < -0.005:
                        mode = "momentum"
                        momentum_threshold = 0.005
                    elif up_median < -0.005 and down_median > 0.005:
                        mode = "reversion"
                        momentum_threshold = -0.005
                    else:
                        mode = "none"
        
        entry_params[market] = {
            'up_price_min': float(up_price_min) if up_price_min is not None else None,
            'up_price_max': float(up_price_max) if up_price_max is not None else None,
            'down_price_min': float(down_price_min) if down_price_min is not None else None,
            'down_price_max': float(down_price_max) if down_price_max is not None else None,
            'momentum_window_s': momentum_window_s,
            'momentum_threshold': momentum_threshold,
            'mode': mode
        }
    
    return {'per_market': entry_params}


def infer_sizing_function(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer sizing function (shares per price bucket).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with sizing parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    size_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        
        if len(market_trades) < 10:  # Need minimum trades
            continue
        
        # Create price buckets (0-0.05, 0.05-0.10, ..., 0.95-1.00)
        bin_edges = np.arange(0, 1.05, 0.05)
        
        # Compute median shares per bucket
        market_trades['price_bucket'] = pd.cut(
            market_trades['side_px_at_trade'],
            bins=bin_edges,
            include_lowest=True
        )
        
        size_table = market_trades.groupby('price_bucket')['shares'].median().to_dict()
        
        # Convert to string keys for JSON serialization
        size_table_str = {str(k): float(v) for k, v in size_table.items() if pd.notna(v)}
        
        # Also compute mean for reference
        size_table_mean = market_trades.groupby('price_bucket')['shares'].mean().to_dict()
        size_table_mean_str = {str(k): float(v) for k, v in size_table_mean.items() if pd.notna(v)}
        
        # Check if we need conditioning (high variance within buckets)
        # For simplicity, we'll use a single dimension for now
        conditioning_var = None
        
        size_params[market] = {
            'bin_edges': bin_edges.tolist(),
            'size_table': size_table_str,
            'size_table_mean': size_table_mean_str,
            'conditioning_var': conditioning_var
        }
    
    return {'per_market': size_params}


def infer_inventory_behavior(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer inventory/rebalance behavior from trade sequence.
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with inventory parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    inventory_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 10:
            continue
        
        # Simulate inventory forward
        inventory_up = 0.0
        inventory_down = 0.0
        max_inventory_up = 0.0
        max_inventory_down = 0.0
        max_total = 0.0
        
        rebalance_events = []
        
        for idx, trade in market_trades.iterrows():
            shares = trade['shares']
            
            if trade['side'] == 'UP':
                inventory_up += shares
            else:
                inventory_down += shares
            
            # Track maxima
            max_inventory_up = max(max_inventory_up, inventory_up)
            max_inventory_down = max(max_inventory_down, inventory_down)
            max_total = max(max_total, inventory_up + inventory_down)
            
            # Detect rebalance (buying opposite side when inventory is high)
            if inventory_up > 0 and inventory_down > 0:
                ratio = inventory_up / (inventory_up + inventory_down)
                
                # If we buy the smaller side when ratio is extreme, it's a rebalance
                if ratio > 0.7 and trade['side'] == 'DOWN':
                    rebalance_events.append({
                        'ratio': ratio,
                        'timestamp': trade['Timestamp']
                    })
                elif ratio < 0.3 and trade['side'] == 'UP':
                    rebalance_events.append({
                        'ratio': ratio,
                        'timestamp': trade['Timestamp']
                    })
        
        # Infer rebalance ratio (median of rebalance event ratios)
        rebalance_ratio_R = 0.75  # default
        if rebalance_events:
            ratios = [e['ratio'] for e in rebalance_events]
            rebalance_ratio_R = np.median(ratios)
        
        inventory_params[market] = {
            'rebalance_ratio_R': float(rebalance_ratio_R),
            'max_up_shares': float(max_inventory_up),
            'max_down_shares': float(max_inventory_down),
            'max_total_shares': float(max_total)
        }
    
    return {'per_market': inventory_params}


def infer_cadence(trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer cadence/throttle parameters (inter-trade times, max trades per time window).
    
    Args:
        trades: Trade rows dataframe (WATCH trades only)
        
    Returns:
        Dictionary with cadence parameters per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    if len(watch_trades) == 0:
        return {}
    
    cadence_params = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        market_trades = market_trades.sort_values('Timestamp').reset_index(drop=True)
        
        if len(market_trades) < 2:
            continue
        
        # Compute inter-trade times
        inter_trade_times = market_trades['Timestamp'].diff().dropna() / 1000.0  # Convert to seconds
        
        min_inter_trade_ms = inter_trade_times.min() * 1000
        p50_inter_trade_ms = inter_trade_times.median() * 1000
        p95_inter_trade_ms = inter_trade_times.quantile(0.95) * 1000
        
        # Compute max trades per second and per minute
        # Use sliding windows
        max_trades_per_sec = 0
        max_trades_per_min = 0
        
        for start_idx in range(len(market_trades)):
            start_ts = market_trades.iloc[start_idx]['Timestamp']
            end_ts_1s = start_ts + 1000
            end_ts_60s = start_ts + 60000
            
            count_1s = ((market_trades['Timestamp'] >= start_ts) & 
                       (market_trades['Timestamp'] < end_ts_1s)).sum()
            count_60s = ((market_trades['Timestamp'] >= start_ts) & 
                        (market_trades['Timestamp'] < end_ts_60s)).sum()
            
            max_trades_per_sec = max(max_trades_per_sec, count_1s)
            max_trades_per_min = max(max_trades_per_min, count_60s)
        
        cadence_params[market] = {
            'min_inter_trade_ms': float(min_inter_trade_ms),
            'p50_inter_trade_ms': float(p50_inter_trade_ms),
            'p95_inter_trade_ms': float(p95_inter_trade_ms),
            'max_trades_per_sec': int(max_trades_per_sec),
            'max_trades_per_min': int(max_trades_per_min)
        }
    
    return {'per_market': cadence_params}


def compute_confidence_scores(trades: pd.DataFrame, tape: pd.DataFrame, params: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """
    Compute confidence scores per market.
    
    Args:
        trades: Trade rows dataframe
        tape: Full price tape dataframe
        params: Inferred parameters
        
    Returns:
        Dictionary with confidence scores per market
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    confidence = {}
    
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        n_watch_trades = len(market_trades)
        
        if n_watch_trades < 5:
            continue
        
        # Get entry params for this market
        entry_params = params.get('entry_params', {}).get('per_market', {}).get(market, {})
        size_params = params.get('size_params', {}).get('per_market', {}).get(market, {})
        
        # Entry rule precision: of actual trades, how many fall within price bands?
        entry_rule_precision = 0.0
        entry_rule_recall = 0.0
        
        if entry_params.get('up_price_min') is not None and entry_params.get('up_price_max') is not None:
            up_trades = market_trades[market_trades['side'] == 'UP']
            if len(up_trades) > 0:
                # Precision: of UP trades, how many are in the UP price band?
                up_in_band = ((up_trades['Price UP ($)'] >= entry_params['up_price_min']) & 
                             (up_trades['Price UP ($)'] <= entry_params['up_price_max'])).sum()
                entry_rule_precision = up_in_band / len(up_trades) if len(up_trades) > 0 else 0.0
                
                # Recall: of all price ticks in band, how many have trades?
                market_tape = tape[tape['market'] == market].copy()
                if len(market_tape) > 0:
                    up_in_band_tape = ((market_tape['Price UP ($)'] >= entry_params['up_price_min']) & 
                                      (market_tape['Price UP ($)'] <= entry_params['up_price_max'])).sum()
                    # For recall, we check: of price ticks in band, how many have trades?
                    # Simplified: use ratio of trades in band to ticks in band
                    entry_rule_recall = up_in_band / up_in_band_tape if up_in_band_tape > 0 else 0.0
                    # Clamp to [0, 1]
                    entry_rule_recall = min(1.0, entry_rule_recall)
        
        # Also check DOWN side
        if entry_params.get('down_price_min') is not None and entry_params.get('down_price_max') is not None:
            down_trades = market_trades[market_trades['side'] == 'DOWN']
            if len(down_trades) > 0:
                down_in_band = ((down_trades['Price DOWN ($)'] >= entry_params['down_price_min']) & 
                               (down_trades['Price DOWN ($)'] <= entry_params['down_price_max'])).sum()
                down_precision = down_in_band / len(down_trades) if len(down_trades) > 0 else 0.0
                # Average with UP precision
                entry_rule_precision = (entry_rule_precision + down_precision) / 2.0
        
        # Size table bucket variance
        size_table_bucket_variance = 0.0
        if 'size_table' in size_params and size_params['size_table']:
            size_values = list(size_params['size_table'].values())
            if len(size_values) > 1:
                size_table_bucket_variance = float(np.var(size_values))
        
        confidence[market] = {
            'n_watch_trades': int(n_watch_trades),
            'entry_rule_precision': float(entry_rule_precision),
            'entry_rule_recall': float(entry_rule_recall),
            'size_table_bucket_variance': float(size_table_bucket_variance)
        }
    
    return confidence


def apply_fallback_logic(params: Dict[str, Any], trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Apply fallback logic: if n_watch_trades < 50, use same asset other timeframe or global.
    
    Args:
        params: Inferred parameters
        trades: Trade rows dataframe (to compute n_watch_trades)
        
    Returns:
        Parameters with fallbacks applied
    """
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    
    # Count trades per market
    market_counts = watch_trades.groupby('market').size().to_dict()
    
    # Extract asset and timeframe from market key
    # Market keys are like "BTC_15m", "ETH_15m", "BTC_1h", "ETH_1h"
    def get_market_info(market: str) -> Tuple[str, str]:
        """Extract asset (BTC/ETH) and timeframe (15m/1h) from market key."""
        parts = market.split('_')
        if len(parts) >= 2:
            asset = parts[0]  # BTC or ETH
            timeframe = parts[1]  # 15m or 1h
        else:
            # Fallback to substring matching
            if 'BTC' in market:
                asset = 'BTC'
            elif 'ETH' in market:
                asset = 'ETH'
            else:
                asset = None
            
            if '15' in market or '15m' in market:
                timeframe = '15m'
            elif '1h' in market or '1 hour' in market:
                timeframe = '1h'
            else:
                timeframe = None
        
        return asset, timeframe
    
    # Compute global parameters (across all markets)
    global_params = {
        'entry_params': {},
        'size_params': {},
        'inventory_params': {},
        'cadence_params': {}
    }
    
    # For each param type, aggregate across all markets with >= 50 trades
    for param_type in ['entry_params', 'size_params', 'inventory_params', 'cadence_params']:
        per_market = params.get(param_type, {}).get('per_market', {})
        # Only use markets with enough trades for global aggregation
        valid_markets = {m: v for m, v in per_market.items() if market_counts.get(m, 0) >= 50}
        if valid_markets:
            # Use the first valid market's params as global template
            # In a production system, you'd aggregate more intelligently (median, weighted avg, etc.)
            global_params[param_type] = copy.deepcopy(list(valid_markets.values())[0]) if valid_markets else {}
        elif per_market:
            # Fallback: use any available params
            global_params[param_type] = copy.deepcopy(list(per_market.values())[0]) if per_market else {}
    
    # Apply fallbacks
    result_params = {
        'entry_params': {'per_market': {}},
        'size_params': {'per_market': {}},
        'inventory_params': {'per_market': {}},
        'cadence_params': {'per_market': {}},
        'confidence': {}
    }
    
    # First pass: identify markets that need fallback
    markets_needing_fallback = []
    for market, count in market_counts.items():
        if count < 50:
            markets_needing_fallback.append(market)
    
    # For each market needing fallback, find fallback source
    for market in markets_needing_fallback:
        asset, timeframe = get_market_info(market)
        
        # Try same asset, other timeframe
        fallback_market = None
        if asset and timeframe:
            other_timeframe = '1h' if timeframe == '15m' else '15m'
            fallback_market = f"{asset}_{other_timeframe}"
        
        # Apply fallback for each param type
        for param_type in ['entry_params', 'size_params', 'inventory_params', 'cadence_params']:
            per_market = params.get(param_type, {}).get('per_market', {})
            
            if market in per_market:
                # Keep existing (will be overwritten if fallback found)
                result_params[param_type]['per_market'][market] = per_market[market]
            
            # Try fallback (deep copy to avoid reference issues)
            if fallback_market and fallback_market in per_market:
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[fallback_market])
                print(f"  Applied fallback for {market}: using {fallback_market} for {param_type}")
            elif global_params.get(param_type):
                # Use global fallback
                result_params[param_type]['per_market'][market] = copy.deepcopy(global_params[param_type])
                print(f"  Applied global fallback for {market} for {param_type}")
            elif market in per_market:
                # Keep existing (no fallback available)
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    # For markets with enough trades, use their own parameters
    for market, count in market_counts.items():
        if count >= 50:
            for param_type in ['entry_params', 'size_params', 'inventory_params', 'cadence_params']:
                per_market = params.get(param_type, {}).get('per_market', {})
                if market in per_market:
                    result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    # Also copy over markets that weren't in markets_needing_fallback but exist in params
    for param_type in ['entry_params', 'size_params', 'inventory_params', 'cadence_params']:
        per_market = params.get(param_type, {}).get('per_market', {})
        for market in per_market:
            if market not in result_params[param_type]['per_market']:
                result_params[param_type]['per_market'][market] = copy.deepcopy(per_market[market])
    
    return result_params


def infer_all_parameters(tape: pd.DataFrame, trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Infer all WATCH bot parameters with confidence scores and fallback logic.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe with features
        
    Returns:
        Dictionary with all inferred parameters including confidence scores
    """
    print("\n=== Inferring Parameters ===")
    
    # Infer parameters per market
    params = {
        'entry_params': infer_entry_rules(trades, tape),
        'size_params': infer_sizing_function(trades),
        'inventory_params': infer_inventory_behavior(trades),
        'cadence_params': infer_cadence(trades)
    }
    
    # Apply fallback logic (n < 50) - but first compute confidence to know which markets need fallback
    # Compute initial confidence scores
    initial_confidence = {}
    watch_trades = trades[trades['bot'] == 'WATCH'].copy()
    for market in watch_trades['market'].unique():
        market_trades = watch_trades[watch_trades['market'] == market].copy()
        initial_confidence[market] = len(market_trades)
    
    # Apply fallback logic (n < 50)
    print("\n=== Applying Fallback Logic (n < 50) ===")
    params = apply_fallback_logic(params, trades)
    
    # Compute confidence scores
    print("\n=== Computing Confidence Scores ===")
    confidence = compute_confidence_scores(trades, tape, params)
    params['confidence'] = {'per_market': confidence}
    
    # Print summary
    for market, conf in confidence.items():
        print(f"{market}: n_trades={conf['n_watch_trades']}, "
              f"entry_precision={conf['entry_rule_precision']:.2%}, "
              f"entry_recall={conf['entry_rule_recall']:.2%}, "
              f"size_var={conf['size_table_bucket_variance']:.2f}")
    
    return params

