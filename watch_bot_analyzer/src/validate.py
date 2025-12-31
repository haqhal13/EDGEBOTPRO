"""
Model validation - compare inferred policy against actual WATCH trades.
"""
import pandas as pd
import numpy as np
from typing import Dict, List, Tuple, Any
import json


class PolicySimulator:
    """Simple policy simulator based on inferred parameters."""
    
    def __init__(self, params: Dict[str, Any]):
        self.params = params
        self.entry_params = params.get('entry_params', {}).get('per_market', {})
        self.size_params = params.get('size_params', {}).get('per_market', {})
        self.inventory_params = params.get('inventory_params', {}).get('per_market', {})
        self.cadence_params = params.get('cadence_params', {}).get('per_market', {})
        
        # State
        self.inventory_up = {}
        self.inventory_down = {}
        self.last_trade_time = {}
    
    def should_trade(self, market: str, timestamp: float, up_px: float, down_px: float, 
                    delta_5s: float = None) -> Tuple[bool, str]:
        """
        Decide if we should trade and which side.
        
        Returns:
            (should_trade, side) where side is 'UP', 'DOWN', or None
        """
        if market not in self.entry_params:
            return False, None
        
        entry = self.entry_params[market]
        
        # Check cadence (minimum inter-trade time)
        if market in self.cadence_params:
            cadence = self.cadence_params[market]
            if market in self.last_trade_time:
                time_since_last = (timestamp - self.last_trade_time[market]) / 1000.0
                if time_since_last < cadence.get('min_inter_trade_ms', 0) / 1000.0:
                    return False, None
        
        # Check entry rules
        # UP trades
        if entry.get('up_price_min') is not None and entry.get('up_price_max') is not None:
            if entry['up_price_min'] <= up_px <= entry['up_price_max']:
                # Check momentum/reversion if available
                if entry['mode'] != 'none' and delta_5s is not None:
                    if entry['mode'] == 'momentum' and delta_5s < entry['momentum_threshold']:
                        return False, None
                    if entry['mode'] == 'reversion' and delta_5s > -entry['momentum_threshold']:
                        return False, None
                
                # Check inventory limits
                if self._check_inventory(market, 'UP'):
                    return True, 'UP'
        
        # DOWN trades
        if entry.get('down_price_min') is not None and entry.get('down_price_max') is not None:
            if entry['down_price_min'] <= down_px <= entry['down_price_max']:
                # Check momentum/reversion if available
                if entry['mode'] != 'none' and delta_5s is not None:
                    # For DOWN, we'd check DOWN price delta
                    if entry['mode'] == 'momentum' and delta_5s < entry['momentum_threshold']:
                        return False, None
                    if entry['mode'] == 'reversion' and delta_5s > -entry['momentum_threshold']:
                        return False, None
                
                # Check inventory limits
                if self._check_inventory(market, 'DOWN'):
                    return True, 'DOWN'
        
        return False, None
    
    def _check_inventory(self, market: str, side: str) -> bool:
        """Check if inventory limits allow trading."""
        if market not in self.inventory_params:
            return True
        
        inv_params = self.inventory_params[market]
        
        if market not in self.inventory_up:
            self.inventory_up[market] = 0.0
            self.inventory_down[market] = 0.0
        
        current_up = self.inventory_up[market]
        current_down = self.inventory_down[market]
        total = current_up + current_down
        
        # Check max total
        if total >= inv_params.get('max_total_shares', float('inf')):
            return False
        
        # Check side-specific limits
        if side == 'UP' and current_up >= inv_params.get('max_up_shares', float('inf')):
            return False
        if side == 'DOWN' and current_down >= inv_params.get('max_down_shares', float('inf')):
            return False
        
        return True
    
    def get_size(self, market: str, side: str, side_px: float) -> float:
        """Get trade size based on price bucket."""
        if market not in self.size_params:
            return 1.0  # default
        
        size_params = self.size_params[market]
        size_table = size_params.get('size_table', {})
        
        # Find appropriate bucket
        bin_edges = size_params.get('bin_edges', np.arange(0, 1.05, 0.05))
        
        # Simple lookup - find bucket containing side_px
        bucket_idx = np.digitize(side_px, bin_edges) - 1
        bucket_idx = max(0, min(bucket_idx, len(bin_edges) - 2))
        
        bucket = pd.Interval(bin_edges[bucket_idx], bin_edges[bucket_idx + 1])
        
        # Look up size
        bucket_str = str(bucket)
        if bucket_str in size_table:
            return size_table[bucket_str]
        
        # Fallback: use median of all sizes
        if size_table:
            return np.median(list(size_table.values()))
        
        return 1.0
    
    def execute_trade(self, market: str, timestamp: float, side: str, shares: float):
        """Update inventory after trade."""
        if market not in self.inventory_up:
            self.inventory_up[market] = 0.0
            self.inventory_down[market] = 0.0
        
        if side == 'UP':
            self.inventory_up[market] += shares
        else:
            self.inventory_down[market] += shares
        
        self.last_trade_time[market] = timestamp


def simulate_policy(tape: pd.DataFrame, trades: pd.DataFrame, params: Dict[str, Any]) -> pd.DataFrame:
    """
    Simulate trading policy on the tape and generate simulated trades.
    
    Args:
        tape: Full price tape dataframe
        trades: Actual trade rows dataframe (for reference)
        params: Inferred parameters
        
    Returns:
        Dataframe with simulated trades
    """
    simulator = PolicySimulator(params)
    simulated_trades = []
    
    tape = tape.sort_values(['market', 'Timestamp']).reset_index(drop=True)
    
    for market in tape['market'].unique():
        market_tape = tape[tape['market'] == market].copy()
        market_tape = market_tape.sort_values('Timestamp').reset_index(drop=True)
        
        # Get actual trades for this market for delta computation
        market_actual_trades = trades[trades['market'] == market].copy()
        
        # Compute deltas if available (simplified - would need proper computation)
        for idx, row in market_tape.iterrows():
            timestamp = row['Timestamp']
            up_px = row['Price UP ($)']
            down_px = row['Price DOWN ($)']
            
            # Get delta_5s if available (simplified)
            delta_5s = None
            if 'delta_5s_side_px' in row:
                delta_5s = row['delta_5s_side_px']
            
            should_trade, side = simulator.should_trade(market, timestamp, up_px, down_px, delta_5s)
            
            if should_trade:
                side_px = up_px if side == 'UP' else down_px
                shares = simulator.get_size(market, side, side_px)
                
                simulated_trades.append({
                    'Timestamp': timestamp,
                    'market': market,
                    'side': side,
                    'shares': shares,
                    'Price UP ($)': up_px,
                    'Price DOWN ($)': down_px,
                    'side_px_at_trade': side_px
                })
                
                simulator.execute_trade(market, timestamp, side, shares)
    
    return pd.DataFrame(simulated_trades)


def compute_validation_metrics(actual_trades: pd.DataFrame, simulated_trades: pd.DataFrame) -> Dict[str, Any]:
    """
    Compute validation metrics comparing actual vs simulated trades.
    
    Args:
        actual_trades: Actual WATCH trades
        simulated_trades: Simulated trades from policy
        
    Returns:
        Dictionary with validation metrics
    """
    actual_watch = actual_trades[actual_trades['bot'] == 'WATCH'].copy()
    
    if len(actual_watch) == 0 or len(simulated_trades) == 0:
        return {'error': 'No trades to compare'}
    
    metrics = {}
    
    # Match trades: for each actual trade, find nearest simulated trade within ±2s
    matched = []
    
    for market in actual_watch['market'].unique():
        market_actual = actual_watch[actual_watch['market'] == market].copy()
        market_sim = simulated_trades[simulated_trades['market'] == market].copy()
        
        if len(market_sim) == 0:
            continue
        
        market_sim = market_sim.sort_values('Timestamp').reset_index(drop=True)
        
        for _, actual_trade in market_actual.iterrows():
            actual_ts = actual_trade['Timestamp']
            
            # Find nearest simulated trade within ±2s
            time_diffs = abs(market_sim['Timestamp'] - actual_ts) / 1000.0
            within_window = time_diffs <= 2.0
            
            if within_window.any():
                nearest_idx = time_diffs[within_window].idxmin()
                sim_trade = market_sim.loc[nearest_idx]
                
                matched.append({
                    'market': market,
                    'dt_ms': time_diffs[nearest_idx] * 1000,
                    'same_side': actual_trade['side'] == sim_trade['side'],
                    'size_ratio': sim_trade['shares'] / actual_trade['shares'] if actual_trade['shares'] > 0 else 0,
                    'fill_px_diff': abs(actual_trade.get('fill_px', 0) - sim_trade.get('side_px_at_trade', 0))
                })
    
    matched_df = pd.DataFrame(matched)
    
    if len(matched_df) > 0:
        # Recall: how many actual trades were matched
        recall = len(matched_df) / len(actual_watch)
        
        # Precision: how many simulated trades matched actual
        precision = len(matched_df) / len(simulated_trades) if len(simulated_trades) > 0 else 0
        
        # Side accuracy
        side_accuracy = matched_df['same_side'].mean() if len(matched_df) > 0 else 0
        
        # Size error (MAPE)
        size_mape = (abs(matched_df['size_ratio'] - 1.0).mean() * 100) if len(matched_df) > 0 else 0
        
        metrics = {
            'recall': float(recall),
            'precision': float(precision),
            'side_accuracy': float(side_accuracy),
            'size_mape': float(size_mape),
            'matched_count': len(matched_df),
            'actual_count': len(actual_watch),
            'simulated_count': len(simulated_trades)
        }
    else:
        metrics = {
            'recall': 0.0,
            'precision': 0.0,
            'side_accuracy': 0.0,
            'size_mape': 0.0,
            'matched_count': 0,
            'actual_count': len(actual_watch),
            'simulated_count': len(simulated_trades)
        }
    
    return metrics


def validate_model(tape: pd.DataFrame, trades: pd.DataFrame, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Main validation function.
    
    Args:
        tape: Full price tape dataframe
        trades: Trade rows dataframe
        params: Inferred parameters
        
    Returns:
        Dictionary with validation results
    """
    print("\n=== Validating Model ===")
    
    # Simulate policy
    print("Simulating policy...")
    simulated_trades = simulate_policy(tape, trades, params)
    print(f"Generated {len(simulated_trades)} simulated trades")
    
    # Compute metrics
    metrics = compute_validation_metrics(trades, simulated_trades)
    
    print(f"Validation Metrics:")
    print(f"  Recall: {metrics.get('recall', 0):.2%}")
    print(f"  Precision: {metrics.get('precision', 0):.2%}")
    print(f"  Side Accuracy: {metrics.get('side_accuracy', 0):.2%}")
    print(f"  Size MAPE: {metrics.get('size_mape', 0):.2f}%")
    
    return {
        'metrics': metrics,
        'simulated_trades': simulated_trades
    }

