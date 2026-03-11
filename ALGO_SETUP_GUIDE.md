# ISI Algo Engine v1.0 — Setup Guide

## Files
- `isi_algo_engine.py` — Main Python engine (run on your PC/VPS)
- `config.json`        — Broker + Firebase + Analysis config
- `requirements.txt`  — Python dependencies
- `algo.html`         — ISI Terminal Algo Signal page

## Installation

### Step 1 — Python Install
```bash
pip install -r requirements.txt
```

### Step 2 — MT5 Setup (Windows only)
1. Open MetaTrader 5 terminal
2. Tools → Options → Expert Advisors → Enable "Allow algorithmic trading"
3. Login to your broker account in MT5

### Step 3 — Firebase Setup
1. Firebase Console → Project Settings → Service Accounts
2. "Generate New Private Key" → Download JSON
3. Rename to `firebase_service_account.json` → same folder as engine

### Step 4 — config.json Fill
```json
{
  "broker": {
    "type": "mt5",
    "mt5": {
      "login": YOUR_ACCOUNT_NUMBER,
      "password": "YOUR_PASSWORD",
      "server": "BrokerName-Server"
    }
  },
  "firebase": {
    "database_url": "https://YOUR-PROJECT.firebaseio.com",
    "cluster_id": "YOUR_CLUSTER_ID_FROM_FIREBASE",
    "node_idx": 0
  }
}
```
Cluster ID: Firebase Console → Realtime Database → isi_v6/clusters → key copy karo

### Step 5 — Run Engine
```bash
python isi_algo_engine.py
```

### Step 6 — ISI Terminal
- Open `algo.html` in browser
- Signals real-time dikhenge
- `signal_only` mode: Approve karo manually
- `semi_auto` mode: Approve button press → MT5 auto execute
- `auto` mode: ⚠ Use only after thorough backtesting

## Supported Brokers (MT5)
Any broker that supports MT5: ICMarkets, Pepperstone, FXTM, Exness, XM, etc.

## Custom API Brokers
LMAX, Interactive Brokers, Dukascopy, Alpaca, OANDA v20, Binance
Configure base_url + api_key in config.json

## Signal Scoring (0-100)
- HTF BOS/CHoCH: 20 pts
- LTF Confirmation: 15 pts
- Liquidity Sweep: 15 pts
- Order Block: 15 pts
- FVG: 10 pts
- Premium/Discount + OTE: 10 pts
- Kill Zone: 5 pts
- Wyckoff: 5 pts
- Inducement: 5 pts

Default threshold: 65/100 (configurable)
