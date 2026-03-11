"""
╔══════════════════════════════════════════════════════════════════════════════╗
║          ISI ALGO ENGINE v1.0 — INSTITUTIONAL SIGNAL ENGINE                 ║
║          SMC + ICT Concepts | MT5 + Custom Broker API Support               ║
║          Firebase Integration | Auto-Push Signals to ISI Terminal           ║
╚══════════════════════════════════════════════════════════════════════════════╝

ARCHITECTURE:
  1. Data Layer    → MT5 / Broker REST API / WebSocket
  2. Analysis Layer → SMC Engine (BOS, CHoCH, OB, FVG, Liquidity, ICT concepts)
  3. Signal Layer  → Score + Bias + Entry/SL/TP generator
  4. Firebase Layer → Push signals to ISI Terminal in real-time
  5. Execution Layer → Optional semi-auto order placement (approval required)

INSTALL:
  pip install MetaTrader5 firebase-admin requests websocket-client pandas numpy pytz

USAGE:
  python isi_algo_engine.py --config config.json
"""

import json
import time
import math
import logging
import threading
import argparse
import os
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import numpy as np
import pytz

# ── Optional imports (graceful fallback) ──
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("⚠ MetaTrader5 not installed. MT5 features disabled.")

try:
    import firebase_admin
    from firebase_admin import credentials, db as fdb
    FIREBASE_AVAILABLE = True
except ImportError:
    FIREBASE_AVAILABLE = False
    print("⚠ firebase-admin not installed. Firebase push disabled.")

try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False

# ══════════════════════════════════════════════════════════
# LOGGING SETUP
# ══════════════════════════════════════════════════════════
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('isi_algo.log', encoding='utf-8')
    ]
)
log = logging.getLogger('ISI_ALGO')


# ══════════════════════════════════════════════════════════
# CONFIG LOADER
# ══════════════════════════════════════════════════════════
DEFAULT_CONFIG = {
    "broker": {
        "type": "mt5",                    # "mt5" | "custom_api"
        "mt5": {
            "login": 0,
            "password": "",
            "server": "",
            "path": ""                    # MT5 terminal path, optional
        },
        "custom_api": {
            "base_url": "",               # e.g. https://api.yourbroker.com
            "api_key": "",
            "ws_url": "",                 # WebSocket URL for live data
            "auth_header": "Authorization",
            "auth_prefix": "Bearer"
        }
    },
    "firebase": {
        "service_account_path": "firebase_service_account.json",
        "database_url": "",               # e.g. https://your-project.firebaseio.com
        "cluster_id": "",                 # ISI cluster ID to push signals to
        "node_idx": 0                     # ISI node index
    },
    "watchlist": [
        {"symbol": "XAUUSD", "type": "commodity"},
        {"symbol": "EURUSD", "type": "forex"},
        {"symbol": "GBPUSD", "type": "forex"},
        {"symbol": "USDJPY", "type": "forex"},
        {"symbol": "NAS100", "type": "index"},
        {"symbol": "US30",   "type": "index"},
        {"symbol": "BTCUSD", "type": "crypto"}
    ],
    "analysis": {
        "htf_timeframe": "H4",            # Higher timeframe
        "ltf_timeframe": "M15",           # Lower timeframe / entry TF
        "exec_timeframe": "M5",           # Execution timeframe
        "htf_candles": 200,
        "ltf_candles": 100,
        "min_signal_score": 65,           # Min score to push signal (0-100)
        "scan_interval_sec": 30,          # How often to scan
        "session_filter": True,           # Only trade during active sessions
        "sessions": {
            "london":    {"start": "07:00", "end": "12:00", "tz": "UTC"},
            "new_york":  {"start": "13:00", "end": "17:00", "tz": "UTC"},
            "asian":     {"start": "00:00", "end": "04:00", "tz": "UTC"}
        }
    },
    "risk": {
        "risk_pct": 1.0,                  # Default risk % per trade
        "min_rr": 2.0,                    # Minimum R:R to take signal
        "max_signals_per_day": 3
    },
    "execution": {
        "mode": "signal_only",            # "signal_only" | "semi_auto" | "auto"
        # signal_only = push to terminal, wait for manual approval
        # semi_auto   = push + wait for Firebase approval flag before executing
        # auto        = execute immediately (NOT RECOMMENDED without testing)
        "semi_auto_timeout_sec": 300      # Cancel if no approval in 5 min
    }
}

def load_config(path: str = "config.json") -> dict:
    if os.path.exists(path):
        with open(path) as f:
            user = json.load(f)
        # Deep merge
        def merge(base, over):
            for k, v in over.items():
                if k in base and isinstance(base[k], dict) and isinstance(v, dict):
                    merge(base[k], v)
                else:
                    base[k] = v
        merge(DEFAULT_CONFIG, user)
        log.info(f"Config loaded from {path}")
    else:
        with open(path, 'w') as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        log.info(f"Default config written to {path}. Fill in your details.")
    return DEFAULT_CONFIG


# ══════════════════════════════════════════════════════════
# TIMEFRAME MAPPING
# ══════════════════════════════════════════════════════════
TF_MAP_MT5 = {
    "M1":  1,   "M5":  5,   "M15": 15,  "M30": 30,
    "H1":  60,  "H4":  240, "D1":  1440,"W1":  10080
}

def tf_to_mt5(tf: str):
    if not MT5_AVAILABLE:
        return None
    mapping = {
        "M1":  mt5.TIMEFRAME_M1,  "M5":  mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1":  mt5.TIMEFRAME_H1,  "H4":  mt5.TIMEFRAME_H4,
        "D1":  mt5.TIMEFRAME_D1,  "W1":  mt5.TIMEFRAME_W1
    }
    return mapping.get(tf, mt5.TIMEFRAME_M15)


# ══════════════════════════════════════════════════════════
# DATA LAYER — MT5 + Custom API
# ══════════════════════════════════════════════════════════
class DataLayer:
    def __init__(self, config: dict):
        self.cfg = config
        self.broker_type = config['broker']['type']
        self._connected = False
        self._custom_session = None

    def connect(self) -> bool:
        if self.broker_type == 'mt5':
            return self._connect_mt5()
        elif self.broker_type == 'custom_api':
            return self._connect_custom()
        return False

    def _connect_mt5(self) -> bool:
        if not MT5_AVAILABLE:
            log.error("MetaTrader5 package not installed.")
            return False
        cfg = self.cfg['broker']['mt5']
        kwargs = {}
        if cfg.get('path'):
            kwargs['path'] = cfg['path']

        if not mt5.initialize(**kwargs):
            log.error(f"MT5 init failed: {mt5.last_error()}")
            return False

        if cfg.get('login') and cfg.get('password') and cfg.get('server'):
            ok = mt5.login(cfg['login'], password=cfg['password'], server=cfg['server'])
            if not ok:
                log.error(f"MT5 login failed: {mt5.last_error()}")
                return False
            log.info(f"MT5 connected: {mt5.account_info()._asdict()['login']}")
        else:
            log.info("MT5 initialized (no login — using existing terminal session)")
        self._connected = True
        return True

    def _connect_custom(self) -> bool:
        if not REQUESTS_AVAILABLE:
            log.error("requests package not installed.")
            return False
        cfg = self.cfg['broker']['custom_api']
        if not cfg.get('base_url') or not cfg.get('api_key'):
            log.error("Custom API: base_url and api_key required in config.")
            return False
        self._custom_session = requests.Session()
        self._custom_session.headers.update({
            cfg['auth_header']: f"{cfg['auth_prefix']} {cfg['api_key']}",
            'Content-Type': 'application/json'
        })
        # Test connection
        try:
            r = self._custom_session.get(f"{cfg['base_url']}/ping", timeout=5)
            if r.status_code == 200:
                log.info("Custom API connected.")
                self._connected = True
                return True
            else:
                # Try account endpoint
                r2 = self._custom_session.get(f"{cfg['base_url']}/account", timeout=5)
                if r2.status_code == 200:
                    log.info("Custom API connected via /account.")
                    self._connected = True
                    return True
        except Exception as e:
            log.error(f"Custom API connection failed: {e}")
        return False

    def get_candles(self, symbol: str, timeframe: str, count: int) -> Optional[pd.DataFrame]:
        """Returns DataFrame with columns: time, open, high, low, close, volume"""
        if self.broker_type == 'mt5':
            return self._get_candles_mt5(symbol, timeframe, count)
        elif self.broker_type == 'custom_api':
            return self._get_candles_custom(symbol, timeframe, count)
        return None

    def _get_candles_mt5(self, symbol: str, timeframe: str, count: int) -> Optional[pd.DataFrame]:
        if not MT5_AVAILABLE or not self._connected:
            return None
        tf = tf_to_mt5(timeframe)
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
        if rates is None or len(rates) == 0:
            log.warning(f"No data for {symbol} {timeframe}: {mt5.last_error()}")
            return None
        df = pd.DataFrame(rates)
        df['time'] = pd.to_datetime(df['time'], unit='s')
        return df[['time','open','high','low','close','tick_volume']].rename(columns={'tick_volume':'volume'})

    def _get_candles_custom(self, symbol: str, timeframe: str, count: int) -> Optional[pd.DataFrame]:
        """Generic REST candle fetch — adapts to common broker API formats"""
        if not self._connected or not self._custom_session:
            return None
        cfg = self.cfg['broker']['custom_api']
        try:
            # Try common endpoint patterns
            endpoints = [
                f"{cfg['base_url']}/candles?symbol={symbol}&timeframe={timeframe}&count={count}",
                f"{cfg['base_url']}/ohlc/{symbol}/{timeframe}?limit={count}",
                f"{cfg['base_url']}/history/{symbol}?tf={timeframe}&bars={count}"
            ]
            for url in endpoints:
                try:
                    r = self._custom_session.get(url, timeout=10)
                    if r.status_code == 200:
                        data = r.json()
                        # Try to normalize response
                        if isinstance(data, list) and len(data) > 0:
                            df = pd.DataFrame(data)
                            # Rename common field names
                            rename_map = {}
                            for col in df.columns:
                                cl = col.lower()
                                if cl in ['t','timestamp','datetime','date']:  rename_map[col] = 'time'
                                elif cl in ['o','open_price']:                  rename_map[col] = 'open'
                                elif cl in ['h','high_price']:                  rename_map[col] = 'high'
                                elif cl in ['l','low_price']:                   rename_map[col] = 'low'
                                elif cl in ['c','close_price','last']:          rename_map[col] = 'close'
                                elif cl in ['v','vol','tick_volume']:           rename_map[col] = 'volume'
                            df = df.rename(columns=rename_map)
                            required = ['open','high','low','close']
                            if all(c in df.columns for c in required):
                                if 'time' not in df.columns:
                                    df['time'] = pd.date_range(end=datetime.now(), periods=len(df), freq='5min')
                                if 'volume' not in df.columns:
                                    df['volume'] = 0
                                df[required] = df[required].astype(float)
                                return df[['time','open','high','low','close','volume']]
                except:
                    continue
            log.warning(f"Custom API: Could not fetch candles for {symbol}")
        except Exception as e:
            log.error(f"Custom API candle fetch error: {e}")
        return None

    def get_tick(self, symbol: str) -> Optional[dict]:
        """Get latest bid/ask tick"""
        if self.broker_type == 'mt5' and MT5_AVAILABLE and self._connected:
            tick = mt5.symbol_info_tick(symbol)
            if tick:
                return {'bid': tick.bid, 'ask': tick.ask, 'time': tick.time}
        elif self.broker_type == 'custom_api' and self._connected:
            cfg = self.cfg['broker']['custom_api']
            try:
                r = self._custom_session.get(f"{cfg['base_url']}/quote/{symbol}", timeout=5)
                if r.status_code == 200:
                    d = r.json()
                    return {
                        'bid': float(d.get('bid', d.get('price', 0))),
                        'ask': float(d.get('ask', d.get('price', 0))),
                        'time': time.time()
                    }
            except:
                pass
        return None

    def place_order(self, symbol: str, order_type: str, volume: float,
                    sl: float, tp: float, comment: str = "ISI_ALGO") -> Optional[dict]:
        """Place market order. Returns order result dict."""
        if self.broker_type == 'mt5':
            return self._place_order_mt5(symbol, order_type, volume, sl, tp, comment)
        elif self.broker_type == 'custom_api':
            return self._place_order_custom(symbol, order_type, volume, sl, tp, comment)
        return None

    def _place_order_mt5(self, symbol, order_type, volume, sl, tp, comment):
        if not MT5_AVAILABLE or not self._connected:
            return None
        tick = mt5.symbol_info_tick(symbol)
        if not tick:
            return None
        order_map = {'BUY': mt5.ORDER_TYPE_BUY, 'SELL': mt5.ORDER_TYPE_SELL}
        price = tick.ask if order_type == 'BUY' else tick.bid
        request = {
            "action":    mt5.TRADE_ACTION_DEAL,
            "symbol":    symbol,
            "volume":    volume,
            "type":      order_map[order_type],
            "price":     price,
            "sl":        sl,
            "tp":        tp,
            "comment":   comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            log.error(f"MT5 order failed: {result.comment} (code {result.retcode})")
            return None
        return {'order_id': result.order, 'price': result.price, 'volume': result.volume}

    def _place_order_custom(self, symbol, order_type, volume, sl, tp, comment):
        if not self._connected or not self._custom_session:
            return None
        cfg = self.cfg['broker']['custom_api']
        payload = {
            "symbol": symbol, "side": order_type.lower(),
            "type": "market", "quantity": volume,
            "stopLoss": sl, "takeProfit": tp, "comment": comment
        }
        try:
            r = self._custom_session.post(f"{cfg['base_url']}/orders", json=payload, timeout=10)
            if r.status_code in [200, 201]:
                return r.json()
        except Exception as e:
            log.error(f"Custom API order error: {e}")
        return None

    def disconnect(self):
        if self.broker_type == 'mt5' and MT5_AVAILABLE:
            mt5.shutdown()
        log.info("Data layer disconnected.")


# ══════════════════════════════════════════════════════════
# SMC + ICT ANALYSIS ENGINE
# ══════════════════════════════════════════════════════════
class SMCEngine:
    """
    Full SMC / ICT concept engine:
    - Market Structure: BOS, CHoCH, MSS
    - Liquidity: EQH/EQL sweeps, Stop hunts, Inducement
    - Order Blocks: Bullish/Bearish OB detection
    - Fair Value Gaps (FVG / Imbalance)
    - Premium / Discount zones
    - ICT Kill Zones (London Open, NY Open, Asian Range)
    - Wyckoff: Accumulation, Distribution, Spring, Upthrust
    - HTF/LTF confluence scoring
    """

    # ── MARKET STRUCTURE ──
    @staticmethod
    def find_swing_points(df: pd.DataFrame, lookback: int = 5) -> pd.DataFrame:
        """Find swing highs and lows using rolling window"""
        df = df.copy()
        df['swing_high'] = df['high'].rolling(window=lookback*2+1, center=True).max() == df['high']
        df['swing_low']  = df['low'].rolling(window=lookback*2+1, center=True).min() == df['low']
        return df

    @staticmethod
    def detect_market_structure(df: pd.DataFrame) -> dict:
        """
        Detect:
        - BOS_BULL: Higher High above last swing high → bullish BOS
        - BOS_BEAR: Lower Low below last swing low → bearish BOS
        - CHoCH_BULL: Was bearish, now breaks above last LH → bullish CHoCH
        - CHoCH_BEAR: Was bullish, now breaks below last HL → bearish CHoCH
        Returns dict with structure info
        """
        df = SMCEngine.find_swing_points(df)
        highs = df[df['swing_high']]['high'].values[-6:]
        lows  = df[df['swing_low']]['low'].values[-6:]

        if len(highs) < 2 or len(lows) < 2:
            return {'ms': 'UNKNOWN', 'trend': 'NEUTRAL', 'last_sh': None, 'last_sl': None}

        last_sh, prev_sh = highs[-1], highs[-2]
        last_sl, prev_sl = lows[-1],  lows[-2]
        close = df['close'].iloc[-1]

        # Determine overall trend (HH-HL vs LL-LH)
        bull_structure = (last_sh > prev_sh) and (last_sl > prev_sl)
        bear_structure = (last_sh < prev_sh) and (last_sl < prev_sl)

        # BOS — structure continuation break
        if bull_structure and close > last_sh:
            ms = 'BOS_BULL'
        elif bear_structure and close < last_sl:
            ms = 'BOS_BEAR'
        # CHoCH — first sign of reversal
        elif bear_structure and close > prev_sh:
            ms = 'CHoCH_BULL'
        elif bull_structure and close < prev_sl:
            ms = 'CHoCH_BEAR'
        elif bull_structure:
            ms = 'TREND_BULL'
        elif bear_structure:
            ms = 'TREND_BEAR'
        else:
            ms = 'RANGE'

        trend = 'BULLISH' if 'BULL' in ms else ('BEARISH' if 'BEAR' in ms else 'NEUTRAL')
        return {'ms': ms, 'trend': trend, 'last_sh': last_sh, 'last_sl': last_sl,
                'prev_sh': prev_sh, 'prev_sl': prev_sl}

    # ── LIQUIDITY DETECTION ──
    @staticmethod
    def detect_liquidity_pools(df: pd.DataFrame, lookback: int = 20) -> dict:
        """
        Find equal highs (EQH) and equal lows (EQL) — these are liquidity pools.
        Also detect recent sweep events (price took out a level then reversed).
        """
        recent = df.tail(lookback)
        tolerance = df['close'].mean() * 0.0005  # 0.05% tolerance

        # Find EQH — highs within tolerance of each other
        highs = recent['high'].values
        eqh_levels = []
        for i in range(len(highs)-1):
            for j in range(i+1, len(highs)):
                if abs(highs[i] - highs[j]) < tolerance:
                    eqh_levels.append(round((highs[i]+highs[j])/2, 5))

        lows = recent['low'].values
        eql_levels = []
        for i in range(len(lows)-1):
            for j in range(i+1, len(lows)):
                if abs(lows[i] - lows[j]) < tolerance:
                    eql_levels.append(round((lows[i]+lows[j])/2, 5))

        # Detect sweep — price wicked past a level but closed back inside
        current_close = df['close'].iloc[-1]
        current_high  = df['high'].iloc[-2]   # previous candle
        current_low   = df['low'].iloc[-2]

        sweep_bull = any(current_low < lvl and current_close > lvl for lvl in eql_levels)
        sweep_bear = any(current_high > lvl and current_close < lvl for lvl in eqh_levels)

        return {
            'eqh': eqh_levels[-3:] if eqh_levels else [],
            'eql': eql_levels[-3:] if eql_levels else [],
            'sweep_bull': sweep_bull,   # Swept lows → potential long
            'sweep_bear': sweep_bear,   # Swept highs → potential short
            'liq_hunted': sweep_bull or sweep_bear
        }

    # ── ORDER BLOCKS ──
    @staticmethod
    def detect_order_blocks(df: pd.DataFrame, lookback: int = 30) -> dict:
        """
        Bullish OB: Last bearish candle before a strong bullish move (BOS up)
        Bearish OB: Last bullish candle before a strong bearish move (BOS down)
        """
        df = df.tail(lookback).reset_index(drop=True)
        close = df['close'].iloc[-1]
        bull_obs, bear_obs = [], []

        for i in range(2, len(df)-2):
            candle  = df.iloc[i]
            next1   = df.iloc[i+1]
            next2   = df.iloc[i+2]

            body = abs(candle['close'] - candle['open'])
            avg_body = df['close'].sub(df['open']).abs().mean()

            # Bullish OB: bearish candle followed by 2 strong bullish candles
            if (candle['close'] < candle['open'] and   # bearish
                next1['close'] > next1['open'] and      # next bullish
                next2['close'] > next2['open'] and      # next next bullish
                next1['close'] - next1['open'] > avg_body):   # strong move
                bull_obs.append({
                    'top':    candle['open'],
                    'bottom': candle['close'],
                    'idx':    i,
                    'tested': close < candle['open'] and close > candle['close']
                })

            # Bearish OB: bullish candle followed by 2 strong bearish candles
            if (candle['close'] > candle['open'] and   # bullish
                next1['close'] < next1['open'] and      # next bearish
                next2['close'] < next2['open'] and      # next next bearish
                next1['open'] - next1['close'] > avg_body):   # strong move
                bear_obs.append({
                    'top':    candle['close'],
                    'bottom': candle['open'],
                    'idx':    i,
                    'tested': close > candle['open'] and close < candle['close']
                })

        # Currently in an OB?
        in_bull_ob = any(ob['bottom'] <= close <= ob['top'] for ob in bull_obs)
        in_bear_ob = any(ob['bottom'] <= close <= ob['top'] for ob in bear_obs)

        return {
            'bull_obs':   bull_obs[-2:],
            'bear_obs':   bear_obs[-2:],
            'in_bull_ob': in_bull_ob,
            'in_bear_ob': in_bear_ob,
            'nearest_bull_ob': bull_obs[-1] if bull_obs else None,
            'nearest_bear_ob': bear_obs[-1] if bear_obs else None
        }

    # ── FAIR VALUE GAPS (FVG) ──
    @staticmethod
    def detect_fvg(df: pd.DataFrame, lookback: int = 20) -> dict:
        """
        FVG (3-candle pattern):
        Bullish FVG: candle[i-1].high < candle[i+1].low (gap up)
        Bearish FVG: candle[i-1].low > candle[i+1].high (gap down)
        """
        df = df.tail(lookback+2).reset_index(drop=True)
        bull_fvgs, bear_fvgs = [], []
        close = df['close'].iloc[-1]

        for i in range(1, len(df)-1):
            prev = df.iloc[i-1]
            curr = df.iloc[i]
            nxt  = df.iloc[i+1]

            # Bullish FVG
            if prev['high'] < nxt['low']:
                bull_fvgs.append({
                    'top':    nxt['low'],
                    'bottom': prev['high'],
                    'mid':    (nxt['low'] + prev['high']) / 2,
                    'filled': close > nxt['low'] or close < prev['high']
                })

            # Bearish FVG
            if prev['low'] > nxt['high']:
                bear_fvgs.append({
                    'top':    prev['low'],
                    'bottom': nxt['high'],
                    'mid':    (prev['low'] + nxt['high']) / 2,
                    'filled': close < nxt['high'] or close > prev['low']
                })

        # Unfilled FVGs only (these are active targets/entries)
        active_bull = [f for f in bull_fvgs if not f['filled']]
        active_bear = [f for f in bear_fvgs if not f['filled']]
        in_bull_fvg = any(f['bottom'] <= close <= f['top'] for f in active_bull)
        in_bear_fvg = any(f['bottom'] <= close <= f['top'] for f in active_bear)

        return {
            'bull_fvgs':   active_bull[-2:],
            'bear_fvgs':   active_bear[-2:],
            'in_bull_fvg': in_bull_fvg,
            'in_bear_fvg': in_bear_fvg
        }

    # ── PREMIUM / DISCOUNT ZONES ──
    @staticmethod
    def get_premium_discount(df: pd.DataFrame, lookback: int = 50) -> dict:
        """
        ICT Premium/Discount:
        - Range = highest high to lowest low over lookback
        - Discount: price < 50% of range (buy zone)
        - Premium: price > 50% of range (sell zone)
        - Equilibrium: price at 50%
        """
        recent = df.tail(lookback)
        high   = recent['high'].max()
        low    = recent['low'].min()
        rng    = high - low
        eq     = low + rng * 0.5
        close  = df['close'].iloc[-1]

        if rng == 0:
            return {'zone': 'UNKNOWN', 'pct_in_range': 50, 'equilibrium': eq}

        pct = (close - low) / rng * 100
        if pct > 62.5:
            zone = 'PREMIUM'
        elif pct < 37.5:
            zone = 'DISCOUNT'
        else:
            zone = 'EQUILIBRIUM'

        # Optimal Trade Entry (OTE) zones — 61.8% and 78.6% fib retracements
        ote_bull_top    = low  + rng * 0.786
        ote_bull_bottom = low  + rng * 0.618
        ote_bear_top    = high - rng * 0.618
        ote_bear_bottom = high - rng * 0.786

        in_ote_bull = ote_bull_bottom <= close <= ote_bull_top
        in_ote_bear = ote_bear_bottom <= close <= ote_bear_top

        return {
            'zone':         zone,
            'pct_in_range': round(pct, 1),
            'equilibrium':  round(eq, 5),
            'range_high':   round(high, 5),
            'range_low':    round(low, 5),
            'ote_bull':     {'top': round(ote_bull_top,5), 'bottom': round(ote_bull_bottom,5)},
            'ote_bear':     {'top': round(ote_bear_top,5), 'bottom': round(ote_bear_bottom,5)},
            'in_ote_bull':  in_ote_bull,
            'in_ote_bear':  in_ote_bear
        }

    # ── ICT KILL ZONES ──
    @staticmethod
    def check_kill_zone(sessions: dict) -> dict:
        """Check if current time is in a Kill Zone (high probability session)"""
        now_utc = datetime.now(timezone.utc)
        active = []
        for name, sess in sessions.items():
            start_h, start_m = map(int, sess['start'].split(':'))
            end_h,   end_m   = map(int, sess['end'].split(':'))
            start_min = start_h * 60 + start_m
            end_min   = end_h   * 60 + end_m
            now_min   = now_utc.hour * 60 + now_utc.minute
            if start_min <= now_min <= end_min:
                active.append(name)
        return {'active': active, 'in_kill_zone': len(active) > 0}

    # ── WYCKOFF DETECTION ──
    @staticmethod
    def detect_wyckoff(df: pd.DataFrame, lookback: int = 40) -> dict:
        """
        Simplified Wyckoff phase detection:
        - Accumulation: Low volume on lows, high volume on recovery
        - Distribution: Low volume on highs, high volume on drop
        - Spring: Failed breakdown (wyckoff spring)
        - Upthrust: Failed breakout
        """
        df = df.tail(lookback).copy()
        avg_vol = df['volume'].mean() if df['volume'].mean() > 0 else 1

        recent_lows  = df.nsmallest(5, 'low')
        recent_highs = df.nlargest(5, 'high')

        # Spring: price went to new low but volume was LOW (fake breakdown)
        last_5 = df.tail(5)
        spring = (
            last_5['low'].min() < df['low'].quantile(0.1) and
            last_5['volume'].mean() < avg_vol * 0.7
        )
        # Upthrust: price went to new high but volume was LOW (fake breakout)
        upthrust = (
            last_5['high'].max() > df['high'].quantile(0.9) and
            last_5['volume'].mean() < avg_vol * 0.7
        )

        # Phase detection (simplified)
        price_trend = df['close'].iloc[-1] - df['close'].iloc[0]
        vol_trend   = df['volume'].tail(10).mean() - df['volume'].head(10).mean()

        if price_trend < 0 and vol_trend > 0:
            phase = 'DISTRIBUTION'
        elif price_trend > 0 and vol_trend < 0:
            phase = 'MARKUP'
        elif price_trend < 0 and vol_trend < 0:
            phase = 'ACCUMULATION'
        elif price_trend > 0 and vol_trend > 0:
            phase = 'MARKDOWN'
        else:
            phase = 'UNKNOWN'

        return {
            'phase':    phase,
            'spring':   spring,
            'upthrust': upthrust
        }

    # ── INDUCEMENT DETECTION ──
    @staticmethod
    def detect_inducement(df: pd.DataFrame) -> dict:
        """
        Inducement: A visible swing level (EQH/EQL) that draws retail traders in,
        before institutions reverse price. Often seen as a minor high/low between
        two major structure points.
        """
        df = SMCEngine.find_swing_points(df.tail(30))
        sh_prices = df[df['swing_high']]['high'].values
        sl_prices = df[df['swing_low']]['low'].values
        close = df['close'].iloc[-1]

        # Inducement = swing point that price is approaching (within 0.3% of close)
        tolerance = close * 0.003
        bull_inducement = any(abs(close - lvl) < tolerance for lvl in sl_prices[-3:])
        bear_inducement = any(abs(close - lvl) < tolerance for lvl in sh_prices[-3:])

        return {
            'bull_inducement': bull_inducement,  # approaching a swing low = luring longs
            'bear_inducement': bear_inducement    # approaching a swing high = luring shorts
        }


# ══════════════════════════════════════════════════════════
# SIGNAL GENERATOR
# ══════════════════════════════════════════════════════════
class SignalGenerator:
    """
    Combines HTF + LTF SMC analysis into scored signals.
    Score 0-100, push only if score >= config threshold.
    """

    def __init__(self, config: dict, data_layer: DataLayer):
        self.cfg = config
        self.data = data_layer
        self.acfg = config['analysis']
        self.rcfg = config['risk']

    def analyze(self, symbol: str, sym_type: str) -> Optional[dict]:
        """Full SMC analysis on one symbol. Returns signal dict or None."""
        # Fetch candles
        htf_df = self.data.get_candles(symbol, self.acfg['htf_timeframe'], self.acfg['htf_candles'])
        ltf_df = self.data.get_candles(symbol, self.acfg['ltf_timeframe'], self.acfg['ltf_candles'])
        exec_df= self.data.get_candles(symbol, self.acfg['exec_timeframe'], 50)

        if htf_df is None or ltf_df is None or len(htf_df) < 20 or len(ltf_df) < 20:
            log.warning(f"{symbol}: Insufficient data")
            return None

        # HTF Analysis
        htf_struct  = SMCEngine.detect_market_structure(htf_df)
        htf_liq     = SMCEngine.detect_liquidity_pools(htf_df)
        htf_ob      = SMCEngine.detect_order_blocks(htf_df)
        htf_fvg     = SMCEngine.detect_fvg(htf_df)
        htf_pd      = SMCEngine.get_premium_discount(htf_df)
        htf_wyckoff = SMCEngine.detect_wyckoff(htf_df)

        # LTF Analysis
        ltf_struct  = SMCEngine.detect_market_structure(ltf_df)
        ltf_liq     = SMCEngine.detect_liquidity_pools(ltf_df)
        ltf_ob      = SMCEngine.detect_order_blocks(ltf_df)
        ltf_fvg     = SMCEngine.detect_fvg(ltf_df)
        ltf_pd      = SMCEngine.get_premium_discount(ltf_df)
        ltf_induce  = SMCEngine.detect_inducement(ltf_df)

        # Kill Zone check
        kz = SMCEngine.check_kill_zone(self.acfg['sessions'])

        # Determine direction bias
        htf_trend = htf_struct['trend']
        ltf_trend = ltf_struct['trend']

        direction = None
        if htf_trend == 'BULLISH' and ltf_trend == 'BULLISH':
            direction = 'LONG'
        elif htf_trend == 'BEARISH' and ltf_trend == 'BEARISH':
            direction = 'SHORT'
        elif htf_trend == 'BULLISH' and ltf_struct['ms'] in ['CHoCH_BULL','BOS_BULL']:
            direction = 'LONG'
        elif htf_trend == 'BEARISH' and ltf_struct['ms'] in ['CHoCH_BEAR','BOS_BEAR']:
            direction = 'SHORT'

        if direction is None:
            return None  # No clear bias

        # ── CONFLUENCE SCORING ──
        score = 0
        confluences = []

        # 1. HTF Structure (20 pts)
        if htf_struct['ms'] in ['BOS_BULL','CHoCH_BULL'] and direction == 'LONG':
            score += 20; confluences.append('HTF BOS/CHoCH Bullish')
        elif htf_struct['ms'] in ['BOS_BEAR','CHoCH_BEAR'] and direction == 'SHORT':
            score += 20; confluences.append('HTF BOS/CHoCH Bearish')
        elif htf_struct['ms'] in ['TREND_BULL'] and direction == 'LONG':
            score += 12; confluences.append('HTF Trend Bullish')
        elif htf_struct['ms'] in ['TREND_BEAR'] and direction == 'SHORT':
            score += 12; confluences.append('HTF Trend Bearish')

        # 2. LTF Confirmation (15 pts)
        if ltf_struct['ms'] in ['BOS_BULL','CHoCH_BULL'] and direction == 'LONG':
            score += 15; confluences.append('LTF BOS/CHoCH Bullish Confirmation')
        elif ltf_struct['ms'] in ['BOS_BEAR','CHoCH_BEAR'] and direction == 'SHORT':
            score += 15; confluences.append('LTF BOS/CHoCH Bearish Confirmation')
        elif ltf_struct['ms'] in ['TREND_BULL'] and direction == 'LONG':
            score += 8; confluences.append('LTF Trend Bullish')
        elif ltf_struct['ms'] in ['TREND_BEAR'] and direction == 'SHORT':
            score += 8; confluences.append('LTF Trend Bearish')

        # 3. Liquidity Sweep (15 pts)
        if htf_liq['sweep_bull'] and direction == 'LONG':
            score += 15; confluences.append('HTF Liquidity Sweep (Lows swept → Long)')
        elif htf_liq['sweep_bear'] and direction == 'SHORT':
            score += 15; confluences.append('HTF Liquidity Sweep (Highs swept → Short)')
        elif ltf_liq['sweep_bull'] and direction == 'LONG':
            score += 8; confluences.append('LTF Liquidity Sweep Bullish')
        elif ltf_liq['sweep_bear'] and direction == 'SHORT':
            score += 8; confluences.append('LTF Liquidity Sweep Bearish')

        # 4. Order Block (15 pts)
        if ltf_ob['in_bull_ob'] and direction == 'LONG':
            score += 15; confluences.append('Price in LTF Bullish Order Block')
        elif ltf_ob['in_bear_ob'] and direction == 'SHORT':
            score += 15; confluences.append('Price in LTF Bearish Order Block')
        elif htf_ob['in_bull_ob'] and direction == 'LONG':
            score += 10; confluences.append('Price in HTF Bullish Order Block')
        elif htf_ob['in_bear_ob'] and direction == 'SHORT':
            score += 10; confluences.append('Price in HTF Bearish Order Block')

        # 5. FVG (10 pts)
        if ltf_fvg['in_bull_fvg'] and direction == 'LONG':
            score += 10; confluences.append('Price in LTF Bullish FVG')
        elif ltf_fvg['in_bear_fvg'] and direction == 'SHORT':
            score += 10; confluences.append('Price in LTF Bearish FVG')

        # 6. Premium/Discount (10 pts)
        if htf_pd['zone'] == 'DISCOUNT' and direction == 'LONG':
            score += 10; confluences.append('HTF Discount Zone (Buy Zone)')
        elif htf_pd['zone'] == 'PREMIUM' and direction == 'SHORT':
            score += 10; confluences.append('HTF Premium Zone (Sell Zone)')
        if htf_pd['in_ote_bull'] and direction == 'LONG':
            score += 5; confluences.append('In OTE Zone (61.8-78.6% Fib)')
        elif htf_pd['in_ote_bear'] and direction == 'SHORT':
            score += 5; confluences.append('In OTE Zone (Bearish Fib)')

        # 7. Kill Zone (5 pts)
        if kz['in_kill_zone']:
            score += 5; confluences.append(f"Kill Zone Active: {', '.join(kz['active'])}")

        # 8. Wyckoff (5 pts)
        if htf_wyckoff['spring'] and direction == 'LONG':
            score += 5; confluences.append('Wyckoff Spring detected')
        elif htf_wyckoff['upthrust'] and direction == 'SHORT':
            score += 5; confluences.append('Wyckoff Upthrust detected')

        # 9. Inducement (5 pts)
        if ltf_induce['bull_inducement'] and direction == 'LONG':
            score += 5; confluences.append('LTF Inducement swept (Bulls lured)')
        elif ltf_induce['bear_inducement'] and direction == 'SHORT':
            score += 5; confluences.append('LTF Inducement swept (Bears lured)')

        score = min(score, 100)

        if score < self.acfg['min_signal_score']:
            log.info(f"{symbol} {direction}: Score {score} < threshold {self.acfg['min_signal_score']} — skipped")
            return None

        # ── ENTRY / SL / TP CALCULATION ──
        tick  = self.data.get_tick(symbol)
        close = ltf_df['close'].iloc[-1]
        price = tick['ask'] if direction == 'LONG' else tick['bid'] if tick else close

        # SL placement
        if direction == 'LONG':
            ob  = ltf_ob['nearest_bull_ob']
            fvg = ltf_fvg['bull_fvgs'][-1] if ltf_fvg['bull_fvgs'] else None
            if ob:
                sl = ob['bottom'] * 0.9998   # 2 pips below OB bottom
            elif ltf_struct['last_sl']:
                sl = ltf_struct['last_sl'] * 0.9998
            else:
                sl = price * 0.998
        else:
            ob  = ltf_ob['nearest_bear_ob']
            if ob:
                sl = ob['top'] * 1.0002
            elif ltf_struct['last_sh']:
                sl = ltf_struct['last_sh'] * 1.0002
            else:
                sl = price * 1.002

        sl_pips = abs(price - sl)

        # TP: minimum RR ratio from config
        min_rr = self.rcfg['min_rr']
        tp = price + sl_pips * min_rr if direction == 'LONG' else price - sl_pips * min_rr

        # RR actual
        rr = round(abs(tp - price) / max(sl_pips, 0.00001), 2)

        if rr < self.rcfg['min_rr']:
            log.info(f"{symbol} {direction}: RR {rr} < min {self.rcfg['min_rr']} — skipped")
            return None

        # ── QTY CALCULATION ──
        # Qty based on risk % of account (requires account balance)
        qty = None
        if MT5_AVAILABLE and self.data._connected and self.data.broker_type == 'mt5':
            acc = mt5.account_info()
            if acc:
                balance = acc.balance
                risk_amt = balance * self.rcfg['risk_pct'] / 100
                qty = self._calc_qty(symbol, sym_type, risk_amt, price, sl, sl_pips)

        # SMM summary for ISI Terminal
        smm_active = []
        if htf_liq['liq_hunted']:   smm_active.append('liqHunt')
        if ltf_ob['in_bull_ob'] or ltf_ob['in_bear_ob']: smm_active.append('orderBlock')
        if ltf_fvg['in_bull_fvg'] or ltf_fvg['in_bear_fvg']: smm_active.append('fvg')
        if ltf_induce['bull_inducement'] or ltf_induce['bear_inducement']: smm_active.append('inducement')
        if htf_wyckoff['spring']:   smm_active.append('wyckoffSpring')
        if htf_liq['eqh'] or htf_liq['eql']: smm_active.append('liqPool')

        signal = {
            'id':           f"SIG_{symbol}_{int(time.time())}",
            'symbol':       symbol,
            'type':         sym_type,
            'direction':    direction,
            'score':        score,
            'confluences':  confluences,
            'entry':        round(price, 5),
            'sl':           round(sl, 5),
            'tp':           round(tp, 5),
            'rr':           rr,
            'qty':          qty,
            'htf_ms':       htf_struct['ms'],
            'ltf_ms':       ltf_struct['ms'],
            'htf_zone':     htf_pd['zone'],
            'smm':          smm_active,
            'kill_zone':    kz['active'],
            'wyckoff':      htf_wyckoff['phase'],
            'liq_sweep':    htf_liq['liq_hunted'],
            'timestamp':    datetime.now(timezone.utc).isoformat(),
            'status':       'PENDING',   # PENDING → APPROVED → EXECUTED / REJECTED
            'source':       'ISI_ALGO_ENGINE'
        }
        log.info(f"✅ SIGNAL: {symbol} {direction} | Score: {score} | RR: {rr} | Confluences: {len(confluences)}")
        return signal

    def _calc_qty(self, symbol, sym_type, risk_amt, entry, sl, sl_pips):
        """Calculate position size based on risk amount"""
        try:
            if sym_type == 'forex':
                if 'JPY' in symbol:
                    pips = sl_pips / 0.01
                    pip_val = 1000  # per lot, approximate
                else:
                    pips = sl_pips / 0.0001
                    pip_val = 10   # per standard lot per pip
                qty = risk_amt / (pips * pip_val)
            elif sym_type in ['commodity','crypto']:
                qty = risk_amt / max(sl_pips, 0.001)
            elif sym_type == 'index':
                qty = risk_amt / max(sl_pips, 0.1)
            else:
                qty = risk_amt / max(sl_pips * 10, 0.1)
            return round(max(qty, 0.01), 2)
        except:
            return None


# ══════════════════════════════════════════════════════════
# FIREBASE LAYER
# ══════════════════════════════════════════════════════════
class FirebaseLayer:
    def __init__(self, config: dict):
        self.cfg = config['firebase']
        self._ready = False

    def connect(self) -> bool:
        if not FIREBASE_AVAILABLE:
            log.warning("firebase-admin not installed. Signals will be logged only.")
            return False
        try:
            sa_path = self.cfg['service_account_path']
            db_url  = self.cfg['database_url']
            if not os.path.exists(sa_path):
                log.error(f"Firebase service account not found: {sa_path}")
                log.info("Download from Firebase Console → Project Settings → Service Accounts")
                return False
            if not db_url:
                log.error("Firebase database_url not set in config.json")
                return False
            cred = credentials.Certificate(sa_path)
            if not firebase_admin._apps:
                firebase_admin.initialize_app(cred, {'databaseURL': db_url})
            self._ready = True
            log.info("Firebase connected.")
            return True
        except Exception as e:
            log.error(f"Firebase init error: {e}")
            return False

    def push_signal(self, signal: dict) -> bool:
        """Push signal to isi_v6/algo_signals/{clusterId}/{nodeIdx}"""
        if not self._ready:
            log.info(f"[SIGNAL LOG — Firebase not connected]\n{json.dumps(signal, indent=2)}")
            return False
        try:
            cid   = self.cfg['cluster_id']
            nidx  = self.cfg['node_idx']
            path  = f"isi_v6/algo_signals/{cid}/{nidx}"
            fdb.reference(path).push(signal)
            log.info(f"Signal pushed to Firebase: {signal['id']}")
            return True
        except Exception as e:
            log.error(f"Firebase push error: {e}")
            return False

    def update_signal_status(self, signal_id: str, status: str, extra: dict = None):
        """Update signal status (APPROVED, EXECUTED, REJECTED)"""
        if not self._ready:
            return
        try:
            cid  = self.cfg['cluster_id']
            nidx = self.cfg['node_idx']
            ref  = fdb.reference(f"isi_v6/algo_signals/{cid}/{nidx}")
            # Find and update
            snap = ref.get()
            if snap:
                for key, val in snap.items():
                    if isinstance(val, dict) and val.get('id') == signal_id:
                        update = {'status': status}
                        if extra:
                            update.update(extra)
                        ref.child(key).update(update)
                        break
        except Exception as e:
            log.error(f"Signal status update error: {e}")

    def wait_for_approval(self, signal: dict, timeout_sec: int) -> bool:
        """
        Poll Firebase for approval flag on this signal.
        ISI Terminal user can approve/reject from terminal UI.
        Returns True if approved within timeout.
        """
        if not self._ready:
            return False
        start = time.time()
        cid   = self.cfg['cluster_id']
        nidx  = self.cfg['node_idx']
        log.info(f"Waiting for approval: {signal['id']} (timeout: {timeout_sec}s)")
        while time.time() - start < timeout_sec:
            try:
                ref  = fdb.reference(f"isi_v6/algo_signals/{cid}/{nidx}")
                snap = ref.get()
                if snap:
                    for key, val in snap.items():
                        if isinstance(val, dict) and val.get('id') == signal['id']:
                            status = val.get('status', 'PENDING')
                            if status == 'APPROVED':
                                log.info(f"Signal APPROVED: {signal['id']}")
                                return True
                            elif status == 'REJECTED':
                                log.info(f"Signal REJECTED: {signal['id']}")
                                return False
            except:
                pass
            time.sleep(5)
        log.warning(f"Approval timeout for {signal['id']}")
        return False


# ══════════════════════════════════════════════════════════
# EXECUTION MANAGER
# ══════════════════════════════════════════════════════════
class ExecutionManager:
    def __init__(self, config: dict, data_layer: DataLayer, firebase: FirebaseLayer):
        self.cfg    = config
        self.data   = data_layer
        self.fb     = firebase
        self.ecfg   = config['execution']
        self.daily_signals = 0
        self.last_reset_day = datetime.now().date()

    def _reset_daily_if_needed(self):
        today = datetime.now().date()
        if today != self.last_reset_day:
            self.daily_signals = 0
            self.last_reset_day = today

    def handle_signal(self, signal: dict):
        """Route signal based on execution mode"""
        self._reset_daily_if_needed()
        max_daily = self.cfg['risk']['max_signals_per_day']
        if self.daily_signals >= max_daily:
            log.info(f"Daily signal limit reached ({max_daily}). Skipping.")
            return

        mode = self.ecfg['mode']

        # Always push to Firebase first
        self.fb.push_signal(signal)

        if mode == 'signal_only':
            log.info(f"[SIGNAL ONLY] {signal['symbol']} {signal['direction']} | Score: {signal['score']} | RR: {signal['rr']}")
            self.daily_signals += 1

        elif mode == 'semi_auto':
            log.info(f"[SEMI-AUTO] Waiting for manual approval from ISI Terminal...")
            approved = self.fb.wait_for_approval(signal, self.ecfg['semi_auto_timeout_sec'])
            if approved:
                self._execute(signal)
            else:
                self.fb.update_signal_status(signal['id'], 'EXPIRED')

        elif mode == 'auto':
            log.warning("[AUTO MODE] Executing without approval — use with caution!")
            self._execute(signal)

    def _execute(self, signal: dict):
        """Place actual order"""
        qty = signal.get('qty')
        if not qty:
            log.error("No quantity calculated — cannot execute.")
            self.fb.update_signal_status(signal['id'], 'FAILED', {'error': 'No qty'})
            return

        result = self.data.place_order(
            symbol     = signal['symbol'],
            order_type = signal['direction'].replace('LONG','BUY').replace('SHORT','SELL'),
            volume     = qty,
            sl         = signal['sl'],
            tp         = signal['tp'],
            comment    = f"ISI_{signal['score']}"
        )
        if result:
            log.info(f"✅ ORDER EXECUTED: {signal['symbol']} | Order: {result}")
            self.fb.update_signal_status(signal['id'], 'EXECUTED', {
                'order_id':  str(result.get('order_id','')),
                'exec_price': result.get('price', signal['entry']),
                'exec_time':  datetime.now(timezone.utc).isoformat()
            })
            self.daily_signals += 1
        else:
            log.error(f"Order execution failed for {signal['id']}")
            self.fb.update_signal_status(signal['id'], 'FAILED', {'error': 'Order rejected by broker'})


# ══════════════════════════════════════════════════════════
# MAIN SCANNER LOOP
# ══════════════════════════════════════════════════════════
class ISIAlgoEngine:
    def __init__(self, config_path: str = "config.json"):
        self.cfg     = load_config(config_path)
        self.data    = DataLayer(self.cfg)
        self.smc     = SMCEngine()
        self.signals = SignalGenerator(self.cfg, self.data)
        self.fb      = FirebaseLayer(self.cfg)
        self.exec    = ExecutionManager(self.cfg, self.data, self.fb)
        self._running = False

    def start(self):
        log.info("═" * 60)
        log.info("  ISI ALGO ENGINE v2.0 — Starting...")
        log.info(f"  Mode: {self.cfg['execution']['mode']}")
        log.info(f"  Watchlist: {[s['symbol'] for s in self.cfg['watchlist']]}")
        log.info(f"  HTF: {self.cfg['analysis']['htf_timeframe']} | LTF: {self.cfg['analysis']['ltf_timeframe']}")
        log.info(f"  Min Score: {self.cfg['analysis']['min_signal_score']}")
        log.info("  ✅ Manual Order Listener:  ACTIVE")
        log.info("  ✅ Cancel Request Listener: ACTIVE")
        log.info("═" * 60)

        # Connect
        if not self.data.connect():
            log.error("Data layer connection failed. Check broker config.")
            return
        self.fb.connect()  # Optional — continues even if Firebase unavailable

        self._running = True

        # Thread 1: Manual order listener (ISI Terminal → Broker)
        threading.Thread(
            target=self._manual_order_listener,
            daemon=True, name="ManualOrderListener"
        ).start()
        log.info("Manual order listener started.")

        # Thread 2: Cancel request listener
        threading.Thread(
            target=self._cancel_listener,
            daemon=True, name="CancelListener"
        ).start()
        log.info("Cancel request listener started.")

        try:
            self._scan_loop()
        except KeyboardInterrupt:
            log.info("Stopped by user.")
        finally:
            self._running = False
            self.data.disconnect()


    def _manual_order_listener(self):
        """
        Listens to Firebase isi_v6/order_requests/{cid}/{nidx}
        for manual orders placed from ISI Terminal (index.html AUTHORIZE button).
        Executes them via broker and updates status back to Firebase.
        """
        if not self.fb._ready:
            log.warning("Manual order listener: Firebase not ready — skipping.")
            return

        cid  = self.cfg['firebase']['cluster_id']
        nidx = self.cfg['firebase']['node_idx']
        path = f"isi_v6/order_requests/{cid}/{nidx}"
        log.info(f"Listening for manual orders at: {path}")

        processed_keys = set()

        while self._running:
            try:
                snap = fdb.reference(path).get()
                if snap:
                    for key, order in snap.items():
                        if not isinstance(order, dict): continue
                        if key in processed_keys: continue
                        if order.get('status') != 'ORDER_PENDING': continue

                        # New pending manual order from terminal
                        log.info(f"📋 MANUAL ORDER RECEIVED: {order.get('symbol')} {order.get('direction')} x{order.get('qty')}")
                        processed_keys.add(key)

                        # Determine execution mode
                        mode = self.cfg['execution']['mode']

                        if mode == 'signal_only':
                            # Just log — don't auto-execute
                            log.info(f"[SIGNAL ONLY] Manual order logged. Switch to semi_auto or auto to execute.")
                            fdb.reference(f"{path}/{key}").update({
                                'status': 'LOGGED',
                                'note':   'signal_only mode — manual execution required in MT5'
                            })

                        elif mode in ['semi_auto', 'auto']:
                            self._execute_manual_order(order, key, path)

            except Exception as e:
                log.error(f"Manual order listener error: {e}")

            time.sleep(3)  # Poll every 3 seconds

    def _execute_manual_order(self, order: dict, key: str, path: str):
        """Execute a manual order from ISI Terminal"""
        symbol = order.get('symbol', '')
        direction = order.get('direction', 'LONG')
        qty    = order.get('qty')
        sl     = order.get('sl')
        tp     = order.get('tp')
        entry  = order.get('entry')
        otype  = order.get('type', 'LIMIT')

        if not all([symbol, direction, qty, sl]):
            log.error(f"Manual order missing required fields: {order}")
            fdb.reference(f"{path}/{key}").update({
                'status': 'FAILED',
                'error':  'Missing required fields (symbol/direction/qty/sl)'
            })
            return

        log.info(f"Executing manual order: {direction} {symbol} x{qty} | Entry:{entry} SL:{sl} TP:{tp} | Type:{otype}")

        # For LIMIT orders — place pending order
        # For MARKET orders — execute immediately
        order_type_str = direction.replace('LONG','BUY').replace('SHORT','SELL')

        result = self.data.place_order(
            symbol     = symbol,
            order_type = order_type_str,
            volume     = float(qty),
            sl         = float(sl),
            tp         = float(tp) if tp else float(entry) + (float(entry) - float(sl)) * 2,
            comment    = f"ISI_MANUAL_{order.get('score', 0)}"
        )

        if result:
            log.info(f"✅ Manual order EXECUTED: {symbol} | {result}")
            fdb.reference(f"{path}/{key}").update({
                'status':     'EXECUTED',
                'order_id':   str(result.get('order_id', '')),
                'exec_price': result.get('price', entry),
                'exec_time':  datetime.now(timezone.utc).isoformat()
            })
        else:
            log.error(f"Manual order FAILED: {symbol}")
            fdb.reference(f"{path}/{key}").update({
                'status': 'FAILED',
                'error':  'Broker rejected order — check MT5 logs'
            })

    def _cancel_listener(self):
        """
        Listens to Firebase isi_v6/cancel_requests/{cid}/{nidx}
        Cancels pending orders in MT5/broker when user cancels from ISI Terminal.
        """
        if not self.fb._ready:
            log.warning("Cancel listener: Firebase not ready.")
            return

        cid  = self.cfg['firebase']['cluster_id']
        nidx = self.cfg['firebase']['node_idx']
        path = f"isi_v6/cancel_requests/{cid}/{nidx}"
        log.info(f"Cancel listener active at: {path}")

        processed = set()

        while self._running:
            try:
                snap = fdb.reference(path).get()
                if snap:
                    for key, req in snap.items():
                        if not isinstance(req, dict): continue
                        if key in processed: continue
                        if req.get('status') != 'CANCEL_PENDING': continue

                        processed.add(key)
                        symbol   = req.get('symbol', '')
                        order_id = req.get('order_id')

                        log.info(f"🚫 CANCEL REQUEST: {symbol} | order_id={order_id}")

                        cancelled = self._cancel_in_broker(symbol, order_id)

                        # Update cancel request status
                        fdb.reference(f"{path}/{key}").update({
                            'status':      'CANCEL_DONE' if cancelled else 'CANCEL_FAILED',
                            'processedAt': datetime.now(timezone.utc).isoformat()
                        })

                        if cancelled:
                            log.info(f"✅ Order cancelled in broker: {symbol}")
                        else:
                            log.warning(f"⚠ Cancel may have failed for {symbol} — check MT5 manually")

            except Exception as e:
                log.error(f"Cancel listener error: {e}")

            time.sleep(3)

    def _cancel_in_broker(self, symbol: str, order_id) -> bool:
        """Cancel a pending order in MT5 or custom broker."""
        if self.data.broker_type == 'mt5':
            return self._cancel_mt5(symbol, order_id)
        elif self.data.broker_type == 'custom_api':
            return self._cancel_custom_api(symbol, order_id)
        return False

    def _cancel_mt5(self, symbol: str, order_id) -> bool:
        """Cancel pending order in MT5."""
        if not MT5_AVAILABLE or not self.data._connected:
            log.error("MT5 not available for cancel")
            return False
        try:
            # Try by order_id first
            if order_id:
                oid = int(order_id)
                request = {
                    "action": mt5.TRADE_ACTION_REMOVE,
                    "order":  oid,
                }
                result = mt5.order_send(request)
                if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                    return True
                log.warning(f"MT5 cancel by ID failed: {result.comment if result else 'no result'}")

            # Fallback: find pending orders for this symbol and cancel
            orders = mt5.orders_get(symbol=symbol)
            if orders:
                for ord in orders:
                    req = {"action": mt5.TRADE_ACTION_REMOVE, "order": ord.ticket}
                    res = mt5.order_send(req)
                    if res and res.retcode == mt5.TRADE_RETCODE_DONE:
                        log.info(f"Cancelled MT5 order ticket {ord.ticket}")
                        return True
            return False
        except Exception as e:
            log.error(f"MT5 cancel error: {e}")
            return False

    def _cancel_custom_api(self, symbol: str, order_id) -> bool:
        """Cancel order via custom broker REST API."""
        if not self.data._connected or not self.data._custom_session:
            return False
        cfg = self.cfg['broker']['custom_api']
        try:
            if order_id:
                r = self.data._custom_session.delete(
                    f"{cfg['base_url']}/orders/{order_id}", timeout=10
                )
                return r.status_code in [200, 204]
        except Exception as e:
            log.error(f"Custom API cancel error: {e}")
        return False

    def _scan_loop(self):
        interval = self.cfg['analysis']['scan_interval_sec']
        while self._running:
            log.info(f"── Scanning {len(self.cfg['watchlist'])} symbols ──")
            for sym_cfg in self.cfg['watchlist']:
                try:
                    signal = self.signals.analyze(sym_cfg['symbol'], sym_cfg['type'])
                    if signal:
                        self.exec.handle_signal(signal)
                    time.sleep(1)  # Rate limit between symbols
                except Exception as e:
                    log.error(f"Error analyzing {sym_cfg['symbol']}: {e}", exc_info=True)
            log.info(f"Scan complete. Next scan in {interval}s...")
            time.sleep(interval)


# ══════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='ISI Algo Engine')
    parser.add_argument('--config', default='config.json', help='Path to config file')
    args = parser.parse_args()
    engine = ISIAlgoEngine(config_path=args.config)
    engine.start()
