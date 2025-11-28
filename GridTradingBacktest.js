// Grid Trading Backtest for Scriptable (iOS)
// Cross Margin Kripto Para Grid Trading Backtest Sistemi

// ==================== KULLANICI AYARLARI ====================
// >>>>>> DEGISTIRILECEK PARAMETRELER <<<<<<
const CONFIG = {
  // -------- TEMEL PARAMETRELER --------
  coinId: "bitcoin",       // DEGISTIR: "bitcoin", "ethereum", "solana", "zcash", "ripple", "dogecoin"
  daysAgo: 30,             // DEGISTIR: Kac gun oncesinden baslasin (1, 7, 14, 30, 90)
  lowerPrice: null,        // BURAYA YAZ: Alt fiyat ($) - ornek: 85000
  upperPrice: null,        // BURAYA YAZ: Ust fiyat ($) - ornek: 100000

  // -------- MARGIN VE MOD AYARLARI --------
  marginType: "cross",     // Her zaman Cross Margin
  gridMode: "neutral",     // "neutral" = Long+Short (cift yonlu), "long" = Sadece Long, "short" = Sadece Short

  // -------- DIGER PARAMETRELER --------
  vsCurrency: "usd",
  gridCount: 75,
  totalBalance: 1000,
  balanceUsagePercent: 10,
  leverage: 10,
  trailingUpPercent: 5,
  trailingDownPercent: 5,
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

  // Grid seviyelerini hesapla
  calculateGridLevels() {
    const { gridCount, lowerPrice, upperPrice, leverage } = this.config;
    const gridStep = (upperPrice - lowerPrice) / gridCount;

    this.gridLevels = [];
    this.gridStep = gridStep;

    for (let i = 0; i <= gridCount; i++) {
      const price = lowerPrice + gridStep * i;
      this.gridLevels.push({
        price: price,
        // Long pozisyon icin
        hasLongBuyOrder: true,
        hasLongSellOrder: false,
        longEntryPrice: null,
        longEntryFee: 0,
        longQuantity: 0,
        longTargetPrice: price + gridStep,
        longTrailingHigh: null,
        longTrailingLow: null,
        // Short pozisyon icin
        hasShortSellOrder: true,
        hasShortBuyOrder: false,
        shortEntryPrice: null,
        shortEntryFee: 0,
        shortQuantity: 0,
        shortTargetPrice: price - gridStep,
        shortTrailingLow: null,
        shortTrailingHigh: null,
      });
    }

    // Cross margin: Her grid icin kullanilacak marjin miktari
    this.marginPerGrid = this.balance / gridCount;
    this.notionalPerGrid = this.marginPerGrid * leverage;

    return this.gridLevels;
  }

  // CoinGecko'dan gecmis fiyat verilerini al
  async fetchHistoricalPrices() {
    const { coinId, vsCurrency, daysAgo } = this.config;
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=${vsCurrency}&days=${daysAgo}`;

    try {
      const request = new Request(url);
      request.headers = {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
      };
      const response = await request.loadJSON();

      if (response.prices && response.prices.length > 0) {
        return response.prices.map((item) => ({
          timestamp: item[0],
          price: item[1],
          date: new Date(item[0]),
        }));
      } else if (response.error) {
        throw new Error(response.error);
      } else if (response.status && response.status.error_message) {
        throw new Error(response.status.error_message);
      } else {
        throw new Error("Fiyat verisi alinamadi - bos yanit");
      }
    } catch (error) {
      console.error("API Hatasi:", error.message || error);
      throw new Error("API Hatasi: " + (error.message || JSON.stringify(error)));
    }
  }

  // Trailing stop kontrolu - hem kar alma hem zarar durdurma icin
  checkTrailingStop(grid, currentPrice) {
    const { trailingUpPercent, trailingDownPercent } = this.config;

    if (!grid.trailingActivated || grid.entryPrice === null) {
      return { triggered: false, type: null };
    }

    // Fiyat yeni zirve yaptiysa
    if (currentPrice > grid.trailingHighPrice) {
      grid.trailingHighPrice = currentPrice;
      // Trailing down: Stop loss seviyesini guncelle
      grid.trailingLowPrice = currentPrice * (1 - trailingDownPercent / 100);
      // Trailing up: Yeni zirvenin trailingUpPercent altina take profit koy
      grid.trailingTakeProfit = currentPrice * (1 - trailingUpPercent / 100);
    }

    // Stop loss kontrolu: Fiyat trailing low'un altina dustuyse
    if (currentPrice <= grid.trailingLowPrice) {
      return { triggered: true, type: "stop_loss" };
    }

    // Take profit kontrolu: Fiyat zirvenin trailingUp% altina dustuyse ve karli durumdaysa
    if (
      grid.trailingTakeProfit !== null &&
      currentPrice <= grid.trailingTakeProfit &&
      currentPrice > grid.entryPrice * 1.005
    ) {
      return { triggered: true, type: "take_profit" };
    }

    return { triggered: false, type: null };
  }

  // Grid trading simulasyonu
  runBacktest(priceData) {
    this.calculateGridLevels();

    const {
      tradingFeePercent,
      leverage,
      trailingUpPercent,
      trailingDownPercent,
      gridMode,
    } = this.config;

    const canLong = gridMode === "neutral" || gridMode === "long";
    const canShort = gridMode === "neutral" || gridMode === "short";

    for (let i = 0; i < priceData.length; i++) {
      const currentPrice = priceData[i].price;
      const timestamp = priceData[i].timestamp;

      // Her grid seviyesini kontrol et
      for (let j = 0; j < this.gridLevels.length; j++) {
        const grid = this.gridLevels[j];

        // =============== LONG POZISYON MANTIGI ===============
        // LONG ALIS: Fiyat grid seviyesine veya altina dustuyse
        if (
          canLong &&
          grid.hasLongBuyOrder &&
          currentPrice <= grid.price &&
          currentPrice >= this.config.lowerPrice
        ) {
          const quantity = this.notionalPerGrid / currentPrice;
          const entryFee = (this.notionalPerGrid * tradingFeePercent) / 100;

          grid.longEntryPrice = currentPrice;
          grid.longEntryFee = entryFee;
          grid.longQuantity = quantity;
          grid.hasLongBuyOrder = false;
          grid.hasLongSellOrder = true;
          grid.longTargetPrice = grid.price + this.gridStep;
          grid.longTrailingHigh = currentPrice;
          grid.longTrailingLow = currentPrice * (1 - trailingDownPercent / 100);

          this.balance -= entryFee;
          this.totalFees += entryFee;
          this.currentPosition += quantity;

          this.trades.push({
            type: "LONG_BUY",
            direction: "LONG",
            price: currentPrice,
            quantity: quantity,
            notional: this.notionalPerGrid,
            fee: entryFee,
            timestamp: timestamp,
            gridLevel: j,
          });
        }

        // LONG SATIS: Fiyat hedef fiyata ulasti veya trailing tetiklendi
        if (canLong && grid.hasLongSellOrder && grid.longEntryPrice !== null) {
          let shouldClose = false;
          let closeType = "LONG_SELL";

          if (currentPrice >= grid.longTargetPrice) {
            shouldClose = true;
          }

          // Trailing kontrolu (Long icin)
          if (currentPrice > grid.longTrailingHigh) {
            grid.longTrailingHigh = currentPrice;
            grid.longTrailingLow = currentPrice * (1 - trailingDownPercent / 100);
          }
          if (currentPrice <= grid.longTrailingLow) {
            shouldClose = true;
            closeType = currentPrice > grid.longEntryPrice ? "LONG_TP" : "LONG_SL";
          }

          if (shouldClose) {
            const priceDiff = currentPrice - grid.longEntryPrice;
            const grossPnL = priceDiff * grid.longQuantity;
            const exitNotional = currentPrice * grid.longQuantity;
            const exitFee = (exitNotional * tradingFeePercent) / 100;
            const netPnL = grossPnL - grid.longEntryFee - exitFee;

            this.balance += grossPnL - exitFee;
            this.totalPnL += netPnL;
            this.totalFees += exitFee;
            this.currentPosition -= grid.longQuantity;

            if (netPnL > 0) this.winCount++;
            else this.lossCount++;

            this.updateDrawdown();

            this.trades.push({
              type: closeType,
              direction: "LONG",
              price: currentPrice,
              quantity: grid.longQuantity,
              notional: exitNotional,
              fee: exitFee,
              pnl: netPnL,
              timestamp: timestamp,
              gridLevel: j,
            });

            // Long pozisyonu sifirla
            grid.hasLongBuyOrder = true;
            grid.hasLongSellOrder = false;
            grid.longEntryPrice = null;
            grid.longQuantity = 0;
          }
        }

        // =============== SHORT POZISYON MANTIGI ===============
        // SHORT GIRIS: Fiyat grid seviyesine veya ustune ciktiysa
        if (
          canShort &&
          grid.hasShortSellOrder &&
          currentPrice >= grid.price &&
          currentPrice <= this.config.upperPrice
        ) {
          const quantity = this.notionalPerGrid / currentPrice;
          const entryFee = (this.notionalPerGrid * tradingFeePercent) / 100;

          grid.shortEntryPrice = currentPrice;
          grid.shortEntryFee = entryFee;
          grid.shortQuantity = quantity;
          grid.hasShortSellOrder = false;
          grid.hasShortBuyOrder = true;
          grid.shortTargetPrice = grid.price - this.gridStep;
          grid.shortTrailingLow = currentPrice;
          grid.shortTrailingHigh = currentPrice * (1 + trailingDownPercent / 100);

          this.balance -= entryFee;
          this.totalFees += entryFee;
          this.currentPosition -= quantity;

          this.trades.push({
            type: "SHORT_SELL",
            direction: "SHORT",
            price: currentPrice,
            quantity: quantity,
            notional: this.notionalPerGrid,
            fee: entryFee,
            timestamp: timestamp,
            gridLevel: j,
          });
        }

        // SHORT KAPAMA: Fiyat hedef fiyata dustu veya trailing tetiklendi
        if (canShort && grid.hasShortBuyOrder && grid.shortEntryPrice !== null) {
          let shouldClose = false;
          let closeType = "SHORT_BUY";

          if (currentPrice <= grid.shortTargetPrice) {
            shouldClose = true;
          }

          // Trailing kontrolu (Short icin - ters mantik)
          if (currentPrice < grid.shortTrailingLow) {
            grid.shortTrailingLow = currentPrice;
            grid.shortTrailingHigh = currentPrice * (1 + trailingDownPercent / 100);
          }
          if (currentPrice >= grid.shortTrailingHigh) {
            shouldClose = true;
            closeType = currentPrice < grid.shortEntryPrice ? "SHORT_TP" : "SHORT_SL";
          }

          if (shouldClose) {
            // Short PnL: Giris fiyati - Cikis fiyati (ters)
            const priceDiff = grid.shortEntryPrice - currentPrice;
            const grossPnL = priceDiff * grid.shortQuantity;
            const exitNotional = currentPrice * grid.shortQuantity;
            const exitFee = (exitNotional * tradingFeePercent) / 100;
            const netPnL = grossPnL - grid.shortEntryFee - exitFee;

            this.balance += grossPnL - exitFee;
            this.totalPnL += netPnL;
            this.totalFees += exitFee;
            this.currentPosition += grid.shortQuantity;

            if (netPnL > 0) this.winCount++;
            else this.lossCount++;

            this.updateDrawdown();

            this.trades.push({
              type: closeType,
              direction: "SHORT",
              price: currentPrice,
              quantity: grid.shortQuantity,
              notional: exitNotional,
              fee: exitFee,
              pnl: netPnL,
              timestamp: timestamp,
              gridLevel: j,
            });

            // Short pozisyonu sifirla
            grid.hasShortSellOrder = true;
            grid.hasShortBuyOrder = false;
            grid.shortEntryPrice = null;
            grid.shortQuantity = 0;
          }
        }
      }
    }
  }

  // Drawdown guncelleme
  updateDrawdown() {
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }
    const drawdown = ((this.peakBalance - this.balance) / this.peakBalance) * 100;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }
  }

  // Acik pozisyonlari hesapla ve sonuclari dondur
  finalizeBacktest(priceData) {
    const lastPrice = priceData[priceData.length - 1].price;
    let unrealizedPnL = 0;
    let openPositionCount = 0;

    for (const grid of this.gridLevels) {
      // Long acik pozisyonlar
      if (grid.hasLongSellOrder && grid.longEntryPrice !== null) {
        const priceDiff = lastPrice - grid.longEntryPrice;
        const grossUnrealized = priceDiff * grid.longQuantity;
        const estimatedExitFee = (lastPrice * grid.longQuantity * this.config.tradingFeePercent) / 100;
        unrealizedPnL += grossUnrealized - estimatedExitFee;
        openPositionCount++;
      }
      // Short acik pozisyonlar
      if (grid.hasShortBuyOrder && grid.shortEntryPrice !== null) {
        const priceDiff = grid.shortEntryPrice - lastPrice;
        const grossUnrealized = priceDiff * grid.shortQuantity;
        const estimatedExitFee = (lastPrice * grid.shortQuantity * this.config.tradingFeePercent) / 100;
        unrealizedPnL += grossUnrealized - estimatedExitFee;
        openPositionCount++;
      }
    }

    return this.generateResults(priceData, unrealizedPnL, openPositionCount);
  }

  // Sonuclari olustur
  generateResults(priceData, unrealizedPnL, openPositionCount) {
    const totalTrades = this.trades.length;
    const longTrades = this.trades.filter((t) => t.direction === "LONG").length;
    const shortTrades = this.trades.filter((t) => t.direction === "SHORT").length;
    const closedTrades = this.trades.filter((t) => t.pnl !== undefined).length;
    const winRate =
      closedTrades > 0 ? ((this.winCount / closedTrades) * 100).toFixed(2) : 0;
    const startPrice = priceData[0].price;
    const endPrice = priceData[priceData.length - 1].price;
    const priceChange = (((endPrice - startPrice) / startPrice) * 100).toFixed(
      2,
    );
    const finalBalance = this.balance + unrealizedPnL;
    const totalReturn = (
      ((finalBalance - this.initialBalance) / this.initialBalance) *
      100
    ).toFixed(2);

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
        longTrades: longTrades,
        shortTrades: shortTrades,
        openPositions: openPositionCount,
        winCount: this.winCount,
        lossCount: this.lossCount,
        winRate: winRate,
        startPrice: startPrice.toFixed(2),
        endPrice: endPrice.toFixed(2),
        priceChange: priceChange,
        startDate: priceData[0].date.toLocaleDateString("tr-TR"),
        endDate:
          priceData[priceData.length - 1].date.toLocaleDateString("tr-TR"),
      },
      trades: this.trades,
    };
  }
}

// ==================== SCRIPTABLE WIDGET CIKTISI ====================

function createWidget(results) {
  const widget = new ListWidget();
  widget.backgroundColor = new Color("#1a1a2e");

  // Baslik
  const title = widget.addText("Grid Trading Backtest");
  title.font = Font.boldSystemFont(16);
  title.textColor = Color.white();
  widget.addSpacer(8);

  // Coin bilgisi
  const coinText = widget.addText(
    `${results.config.coinId.toUpperCase()} | ${results.config.daysAgo} Gun`,
  );
  coinText.font = Font.mediumSystemFont(12);
  coinText.textColor = new Color("#888888");
  widget.addSpacer(4);

  // Kar/Zarar
  const pnlValue = parseFloat(results.summary.totalReturn);
  const pnlColor = pnlValue >= 0 ? new Color("#00ff88") : new Color("#ff4444");
  const pnlText = widget.addText(
    `${pnlValue >= 0 ? "+" : ""}${results.summary.totalReturn}%`,
  );
  pnlText.font = Font.boldSystemFont(28);
  pnlText.textColor = pnlColor;
  widget.addSpacer(4);

  // Bakiye bilgisi
  const balanceText = widget.addText(
    `$${results.summary.initialBalance} -> $${results.summary.finalBalance}`,
  );
  balanceText.font = Font.systemFont(12);
  balanceText.textColor = Color.white();
  widget.addSpacer(8);

  // Istatistikler
  const statsText = widget.addText(
    `Islem: ${results.summary.totalTrades} | Kazanma: %${results.summary.winRate}`,
  );
  statsText.font = Font.systemFont(11);
  statsText.textColor = new Color("#aaaaaa");

  const drawdownText = widget.addText(
    `Max Drawdown: %${results.summary.maxDrawdown}`,
  );
  drawdownText.font = Font.systemFont(11);
  drawdownText.textColor = new Color("#aaaaaa");

  return widget;
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
Margin Turu: ${c.marginType.toUpperCase()}
Grid Modu: ${c.gridMode.toUpperCase()}
Toplam Bakiye: $${c.totalBalance}
Kullanilan: %${c.balanceUsagePercent}
Kaldirac: ${c.leverage}x
Trailing Up: %${c.trailingUpPercent}
Trailing Down: %${c.trailingDownPercent}

--------- FIYAT HAREKETI ---------
Baslangic: $${s.startPrice}
Bitis: $${s.endPrice}
Degisim: ${s.priceChange >= 0 ? "+" : ""}${s.priceChange}%

--------- PERFORMANS ---------
Baslangic Bakiye: $${s.initialBalance}
Son Bakiye: $${s.finalBalance}
Gerceklesen K/Z: $${s.realizedPnL}
Acik Pozisyon K/Z: $${s.unrealizedPnL}
Toplam Ucret: $${s.totalFees}
Toplam Getiri: ${s.totalReturn >= 0 ? "+" : ""}${s.totalReturn}%
Max Drawdown: %${s.maxDrawdown}

--------- ISLEM ISTATISTIKLERI ---------
Toplam Islem: ${s.totalTrades}
Long Islemleri: ${s.longTrades}
Short Islemleri: ${s.shortTrades}
Acik Pozisyon: ${s.openPositions}
Kazanan: ${s.winCount}
Kaybeden: ${s.lossCount}
Kazanma Orani: %${s.winRate}

========================================
`;

  return output;
}

// ==================== ANA CALISTIRMA FONKSIYONU ====================

async function runBacktest() {
  // Fiyat kontrolu
  if (CONFIG.lowerPrice === null || CONFIG.upperPrice === null) {
    const alert = new Alert();
    alert.title = "Eksik Bilgi";
    alert.message = "Lutfen lowerPrice ve upperPrice degerlerini girin!\n\nOrnek:\nlowerPrice: 85000\nupperPrice: 100000";
    alert.addAction("Tamam");
    await alert.present();
    Script.complete();
    return;
  }

  if (CONFIG.lowerPrice >= CONFIG.upperPrice) {
    const alert = new Alert();
    alert.title = "Hatali Deger";
    alert.message = "lowerPrice, upperPrice'dan kucuk olmali!";
    alert.addAction("Tamam");
    await alert.present();
    Script.complete();
    return;
  }

  const backtest = new GridTradingBacktest(CONFIG);

  try {
    console.log("Fiyat verileri aliniyor...");
    const priceData = await backtest.fetchHistoricalPrices();
    console.log(`${priceData.length} adet fiyat verisi alindi`);

    console.log("Backtest calistiriliyor...");
    backtest.runBacktest(priceData);
    const results = backtest.finalizeBacktest(priceData);

    // Detayli sonuclari konsola yazdir
    const detailedOutput = formatDetailedResults(results);
    console.log(detailedOutput);

    // Widget olustur
    if (config.runsInWidget) {
      const widget = createWidget(results);
      Script.setWidget(widget);
    } else {
      // Uygulama icinde gosterim
      const alert = new Alert();
      alert.title = "Grid Trading Backtest";
      alert.message = detailedOutput;
      alert.addAction("Tamam");
      await alert.present();

      // Widget onizleme
      const widget = createWidget(results);
      await widget.presentMedium();
    }

    Script.complete();
    return results;
  } catch (error) {
    console.error("Hata:", error.message);

    const alert = new Alert();
    alert.title = "Hata";
    alert.message = `Backtest calistirilirken bir hata olustu:\n${error.message}`;
    alert.addAction("Tamam");
    await alert.present();

    Script.complete();
  }
}

// Scripti calistir
await runBacktest();
