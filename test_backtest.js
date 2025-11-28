// Test version for Node.js environment
// This is a testing script to validate the backtest logic

const https = require('https');

// ==================== KULLANICI AYARLARI ====================
const CONFIG = {
  coinId: "zec",
  vsCurrency: "usdt",
  gridCount: 150,
  lowerPrice: 470,
  upperPrice: 590,
  totalBalance: 500,
  balanceUsagePercent: 10,
  leverage: 5,
  trailingUpPercent: 1.5,
  trailingDownPercent: 1.5,
  daysAgo: 1,
  tradingFeePercent: 0.1,
};

// ==================== ANA FONKSIYONLAR ====================

class GridTradingBacktest {
  constructor(config) {
    this.config = config;
    this.gridLevels = [];
    this.positions = [];
    this.trades = [];
    this.balance = config.totalBalance * (config.balanceUsagePercent / 100);
    this.initialBalance = this.balance;
    this.currentPosition = 0;
    this.totalPnL = 0;
    this.totalFees = 0;
    this.winCount = 0;
    this.lossCount = 0;
    this.maxDrawdown = 0;
    this.peakBalance = this.balance;
  }

  calculateGridLevels() {
    const { gridCount, lowerPrice, upperPrice, leverage } = this.config;
    const gridStep = (upperPrice - lowerPrice) / gridCount;
    
    this.gridLevels = [];
    this.gridStep = gridStep;
    
    for (let i = 0; i <= gridCount; i++) {
      const price = lowerPrice + (gridStep * i);
      this.gridLevels.push({
        price: price,
        hasBuyOrder: true,
        hasSellOrder: false,
        entryPrice: null,
        entryFee: 0,
        quantity: 0,
        marginUsed: 0,
        targetSellPrice: price + gridStep,
        trailingActivated: false,
        trailingHighPrice: null,
        trailingLowPrice: null,
        trailingTakeProfit: null
      });
    }
    
    this.marginPerGrid = this.balance / gridCount;
    this.notionalPerGrid = this.marginPerGrid * leverage;
    
    return this.gridLevels;
  }

  async fetchHistoricalPrices() {
    const { coinId, vsCurrency, daysAgo } = this.config;
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=${vsCurrency}&days=${daysAgo}`;
    
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.prices && response.prices.length > 0) {
              const prices = response.prices.map(item => ({
                timestamp: item[0],
                price: item[1],
                date: new Date(item[0])
              }));
              resolve(prices);
            } else {
              reject(new Error("Fiyat verisi alinamadi"));
            }
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  checkTrailingStop(grid, currentPrice) {
    const { trailingUpPercent, trailingDownPercent } = this.config;
    
    if (!grid.trailingActivated || grid.entryPrice === null) {
      return { triggered: false, type: null };
    }

    if (currentPrice > grid.trailingHighPrice) {
      grid.trailingHighPrice = currentPrice;
      grid.trailingLowPrice = currentPrice * (1 - trailingDownPercent / 100);
      grid.trailingTakeProfit = currentPrice * (1 - trailingUpPercent / 100);
    }
    
    if (currentPrice <= grid.trailingLowPrice) {
      return { triggered: true, type: 'stop_loss' };
    }
    
    if (grid.trailingTakeProfit !== null && 
        currentPrice <= grid.trailingTakeProfit && 
        currentPrice > grid.entryPrice * 1.005) {
      return { triggered: true, type: 'take_profit' };
    }
    
    return { triggered: false, type: null };
  }

  runBacktest(priceData) {
    this.calculateGridLevels();
    
    const { tradingFeePercent, leverage, trailingUpPercent, trailingDownPercent } = this.config;
    
    for (let i = 0; i < priceData.length; i++) {
      const currentPrice = priceData[i].price;
      const timestamp = priceData[i].timestamp;
      
      for (let j = 0; j < this.gridLevels.length; j++) {
        const grid = this.gridLevels[j];
        
        if (grid.hasBuyOrder && currentPrice <= grid.price && currentPrice >= this.config.lowerPrice) {
          const quantity = this.notionalPerGrid / currentPrice;
          const entryFee = (this.notionalPerGrid * tradingFeePercent) / 100;
          
          grid.entryPrice = currentPrice;
          grid.entryFee = entryFee;
          grid.quantity = quantity;
          grid.marginUsed = this.marginPerGrid;
          grid.hasBuyOrder = false;
          grid.hasSellOrder = true;
          grid.targetSellPrice = grid.price + this.gridStep;
          grid.trailingActivated = true;
          grid.trailingHighPrice = currentPrice;
          grid.trailingLowPrice = currentPrice * (1 - trailingDownPercent / 100);
          grid.trailingTakeProfit = null;
          
          this.balance -= entryFee;
          this.totalFees += entryFee;
          this.currentPosition += quantity;
          
          this.trades.push({
            type: 'BUY',
            price: currentPrice,
            quantity: quantity,
            notional: this.notionalPerGrid,
            fee: entryFee,
            timestamp: timestamp,
            gridLevel: j
          });
        }
        
        if (grid.hasSellOrder && grid.entryPrice !== null) {
          let shouldSell = false;
          let sellType = 'SELL';
          
          if (currentPrice >= grid.targetSellPrice) {
            shouldSell = true;
            sellType = 'SELL';
          }
          
          const trailingCheck = this.checkTrailingStop(grid, currentPrice);
          if (trailingCheck.triggered) {
            shouldSell = true;
            sellType = trailingCheck.type === 'take_profit' ? 'TAKE_PROFIT' : 'STOP_LOSS';
          }
          
          if (shouldSell) {
            const sellPrice = currentPrice;
            const quantity = grid.quantity;
            
            const priceDiff = sellPrice - grid.entryPrice;
            const grossPnL = priceDiff * quantity;
            
            const exitNotional = sellPrice * quantity;
            const exitFee = (exitNotional * tradingFeePercent) / 100;
            
            const netPnL = grossPnL - grid.entryFee - exitFee;
            
            this.balance += grossPnL - exitFee;
            this.totalPnL += netPnL;
            this.totalFees += exitFee;
            this.currentPosition -= quantity;
            
            if (netPnL > 0) {
              this.winCount++;
            } else {
              this.lossCount++;
            }
            
            if (this.balance > this.peakBalance) {
              this.peakBalance = this.balance;
            }
            const drawdown = (this.peakBalance - this.balance) / this.peakBalance * 100;
            if (drawdown > this.maxDrawdown) {
              this.maxDrawdown = drawdown;
            }
            
            grid.hasBuyOrder = true;
            grid.hasSellOrder = false;
            grid.entryPrice = null;
            grid.entryFee = 0;
            grid.quantity = 0;
            grid.marginUsed = 0;
            grid.trailingActivated = false;
            grid.trailingHighPrice = null;
            grid.trailingLowPrice = null;
            grid.trailingTakeProfit = null;
            
            this.trades.push({
              type: sellType,
              price: sellPrice,
              quantity: quantity,
              notional: exitNotional,
              fee: exitFee,
              pnl: netPnL,
              timestamp: timestamp,
              gridLevel: j
            });
          }
        }
      }
    }
    
    const lastPrice = priceData[priceData.length - 1].price;
    let unrealizedPnL = 0;
    let openPositionCount = 0;
    
    for (const grid of this.gridLevels) {
      if (grid.hasSellOrder && grid.entryPrice !== null) {
        const priceDiff = lastPrice - grid.entryPrice;
        const grossUnrealized = priceDiff * grid.quantity;
        const estimatedExitFee = (lastPrice * grid.quantity * this.config.tradingFeePercent) / 100;
        unrealizedPnL += grossUnrealized - estimatedExitFee;
        openPositionCount++;
      }
    }
    
    return this.generateResults(priceData, unrealizedPnL, openPositionCount);
  }

  generateResults(priceData, unrealizedPnL, openPositionCount) {
    const totalTrades = this.trades.length;
    const buyTrades = this.trades.filter(t => t.type === 'BUY').length;
    const sellTrades = this.trades.filter(t => t.type !== 'BUY').length;
    const winRate = sellTrades > 0 ? (this.winCount / sellTrades * 100).toFixed(2) : 0;
    const startPrice = priceData[0].price;
    const endPrice = priceData[priceData.length - 1].price;
    const priceChange = ((endPrice - startPrice) / startPrice * 100).toFixed(2);
    const finalBalance = this.balance + unrealizedPnL;
    const totalReturn = ((finalBalance - this.initialBalance) / this.initialBalance * 100).toFixed(2);
    
    return {
      config: this.config,
      summary: {
        initialBalance: this.initialBalance.toFixed(2),
        finalBalance: finalBalance.toFixed(2),
        realizedPnL: this.totalPnL.toFixed(2),
        unrealizedPnL: unrealizedPnL.toFixed(2),
        totalFees: this.totalFees.toFixed(2),
        totalReturn: totalReturn,
        maxDrawdown: this.maxDrawdown.toFixed(2),
        totalTrades: totalTrades,
        buyTrades: buyTrades,
        sellTrades: sellTrades,
        openPositions: openPositionCount,
        winCount: this.winCount,
        lossCount: this.lossCount,
        winRate: winRate,
        startPrice: startPrice.toFixed(2),
        endPrice: endPrice.toFixed(2),
        priceChange: priceChange,
        startDate: priceData[0].date.toLocaleDateString('tr-TR'),
        endDate: priceData[priceData.length - 1].date.toLocaleDateString('tr-TR')
      },
      trades: this.trades
    };
  }
}

function formatDetailedResults(results) {
  const s = results.summary;
  const c = results.config;
  
  let output = `
========================================
     GRID TRADING BACKTEST SONUCLARI    
========================================

DONEM: ${s.startDate} - ${s.endDate}
COIN: ${c.coinId.toUpperCase()}/${c.vsCurrency.toUpperCase()}

--------- AYARLAR ---------
Grid Sayisi: ${c.gridCount}
Alt Fiyat: $${c.lowerPrice}
Ust Fiyat: $${c.upperPrice}
Toplam Bakiye: $${c.totalBalance}
Kullanilan: %${c.balanceUsagePercent}
Kaldirac: ${c.leverage}x
Trailing Up: %${c.trailingUpPercent}
Trailing Down: %${c.trailingDownPercent}

--------- FIYAT HAREKETI ---------
Baslangic: $${s.startPrice}
Bitis: $${s.endPrice}
Degisim: ${s.priceChange >= 0 ? '+' : ''}${s.priceChange}%

--------- PERFORMANS ---------
Baslangic Bakiye: $${s.initialBalance}
Son Bakiye: $${s.finalBalance}
Gerceklesen K/Z: $${s.realizedPnL}
Acik Pozisyon K/Z: $${s.unrealizedPnL}
Toplam Ucret: $${s.totalFees}
Toplam Getiri: ${s.totalReturn >= 0 ? '+' : ''}${s.totalReturn}%
Max Drawdown: %${s.maxDrawdown}

--------- ISLEM ISTATISTIKLERI ---------
Toplam Islem: ${s.totalTrades}
Alis Islemleri: ${s.buyTrades}
Satis Islemleri: ${s.sellTrades}
Acik Pozisyon: ${s.openPositions}
Kazanan: ${s.winCount}
Kaybeden: ${s.lossCount}
Kazanma Orani: %${s.winRate}

========================================
`;

  return output;
}

async function runBacktest() {
  const backtest = new GridTradingBacktest(CONFIG);
  
  try {
    console.log("Fiyat verileri aliniyor...");
    const priceData = await backtest.fetchHistoricalPrices();
    console.log(`${priceData.length} adet fiyat verisi alindi`);
    
    console.log("Backtest calistiriliyor...");
    const results = backtest.runBacktest(priceData);
    
    const detailedOutput = formatDetailedResults(results);
    console.log(detailedOutput);
    
    console.log("\nSon 10 Islem:");
    const lastTrades = results.trades.slice(-10);
    lastTrades.forEach((trade, i) => {
      const date = new Date(trade.timestamp).toLocaleString('tr-TR');
      if (trade.type === 'BUY') {
        console.log(`  ${i+1}. ALIS @ $${trade.price.toFixed(2)} - ${date}`);
      } else {
        const pnlStr = trade.pnl >= 0 ? `+$${trade.pnl.toFixed(2)}` : `-$${Math.abs(trade.pnl).toFixed(2)}`;
        console.log(`  ${i+1}. ${trade.type} @ $${trade.price.toFixed(2)} (${pnlStr}) - ${date}`);
      }
    });
    
    return results;
    
  } catch (error) {
    console.error("Hata:", error.message);
  }
}

runBacktest();
