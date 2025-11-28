# Grid Trading Backtest for iOS Scriptable

## Overview
This is a cryptocurrency grid trading backtest program designed to run on iOS Scriptable app. It simulates grid trading strategies using historical price data from CoinGecko API with cross margin support.

## Features
- Customizable grid parameters (count, price range)
- Balance and leverage configuration (cross margin)
- Trailing stop-loss functionality (up/down percentages)
- Configurable backtest period
- Widget display for iOS home screen
- Detailed performance statistics
- Turkish language output

## Project Structure
```
src/                              # Kod dosyaları buradan alınacak
  ├── GridTradingBacktest.js      # Ana Scriptable scripti (iOS için)
  ├── GridTradingBacktest (copy).js  # Yedek kopya
  └── test_backtest.js            # Node.js test versiyonu
replit.md                         # Proje dokümantasyonu
```

## Configuration Parameters
All parameters are in the CONFIG section at the top of GridTradingBacktest.js:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `coinId` | Cryptocurrency ID (CoinGecko format) | "bitcoin", "ethereum", "solana" |
| `vsCurrency` | Quote currency | "usd" |
| `gridCount` | Number of grid levels | 10 |
| `lowerPrice` | Lower price boundary (USD) | 85000 |
| `upperPrice` | Upper price boundary (USD) | 100000 |
| `totalBalance` | Total capital (USD) | 10000 |
| `balanceUsagePercent` | Percentage of balance to use | 80 |
| `leverage` | Leverage multiplier | 5 |
| `trailingUpPercent` | Trailing up for take profit (%) | 1.5 |
| `trailingDownPercent` | Trailing down for stop loss (%) | 1.5 |
| `daysAgo` | Backtest period in days | 30 |
| `tradingFeePercent` | Trading fee per trade (%) | 0.1 |

## How to Use on iOS Scriptable
1. Download Scriptable app from App Store
2. Open Scriptable and create a new script
3. Copy the contents of `GridTradingBacktest.js`
4. Modify the CONFIG section with your parameters
5. Run the script to see results
6. Add as widget to home screen for quick access

## Grid Trading Logic
- **Buy**: When price drops to or below a grid level
- **Sell**: When price reaches the next grid level above entry (targetSellPrice = grid.price + gridStep)
- **Trailing Stop Loss**: Activates when price drops below trailingDownPercent from the highest point
- **Trailing Take Profit**: Activates when price drops trailingUpPercent from peak while still profitable

## Cross Margin Calculations
- Margin per grid = Total Balance / Grid Count
- Notional per grid = Margin per grid * Leverage
- Entry fee = Notional * tradingFeePercent / 100
- Exit fee = Exit Notional * tradingFeePercent / 100
- Net PnL = Gross PnL - Entry Fee - Exit Fee

## API Used
- CoinGecko API (Free tier, no API key required)
- Endpoint: `/coins/{id}/market_chart`
- Rate limit: 30 calls/min, 10,000 calls/month

## User Preferences
- Language: Turkish (TR)
- Use case: Cross margin crypto trading
- Platform: iOS Scriptable

## Recent Changes
- 2025-11-28: Initial implementation with complete grid trading backtest
- Fixed cross margin PnL calculations
- Added trailing up/down functionality
- Implemented proper fee deduction on both entry and exit
