// Grid Trading Backtest for Scriptable (iOS)
// Cross Margin Kripto Para Grid Trading Backtest Sistemi

// ==================== KULLANICI AYARLARI ====================
// >>>>>> SADECE BU 4 DEGERI DEGISTIR <<<<<<
const CONFIG = {
  // -------- DEGISTIRILECEK PARAMETRELER --------
  coinId: "bitcoin",       // DEGISTIR: "bitcoin", "ethereum", "solana", "zcash", "ripple", "dogecoin"
  daysAgo: 30,             // DEGISTIR: Kac gun oncesinden baslasin (1, 7, 14, 30, 90)
  lowerPrice: null,        // BURAYA YAZ: Alt fiyat ($) - ornek: 85000
  upperPrice: null,        // BURAYA YAZ: Ust fiyat ($) - ornek: 100000

  // -------- SABIT PARAMETRELER (DOKUNMA) --------
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
        trailingTakeProfit: null,
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
    } = this.config;

    for (let i = 0; i < priceData.length; i++) {
      const currentPrice = priceData[i].price;
      const timestamp = priceData[i].timestamp;

      // Her grid seviyesini kontrol et
      for (let j = 0; j < this.gridLevels.length; j++) {
        const grid = this.gridLevels[j];

        // ALIS MANTIGI: Fiyat grid seviyesine veya altina dustuyse ve buy order aktifse
        if (
          grid.hasBuyOrder &&
          currentPrice <= grid.price &&
          currentPrice >= this.config.lowerPrice
        ) {
          // Pozisyon buyuklugu (coin miktari)
          const quantity = this.notionalPerGrid / currentPrice;

          // Giris ucreti (notional deger uzerinden)
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
          grid.trailingLowPrice =
            currentPrice * (1 - trailingDownPercent / 100);
          grid.trailingTakeProfit = null;

          // Cross margin: Fee marjinden dusulur
          this.balance -= entryFee;
          this.totalFees += entryFee;
          this.currentPosition += quantity;

          this.trades.push({
            type: "BUY",
            price: currentPrice,
            quantity: quantity,
            notional: this.notionalPerGrid,
            fee: entryFee,
            timestamp: timestamp,
            gridLevel: j,
          });
        }

        // SATIS MANTIGI: Pozisyon aciksa ve fiyat hedef satis fiyatina ulastiysa
        if (grid.hasSellOrder && grid.entryPrice !== null) {
          let shouldSell = false;
          let sellType = "SELL";

          // Normal grid satisi: Fiyat hedef satis fiyatina (bir ust grid) ulasti
          if (currentPrice >= grid.targetSellPrice) {
            shouldSell = true;
            sellType = "SELL";
          }

          // Trailing stop kontrolu
          const trailingCheck = this.checkTrailingStop(grid, currentPrice);
          if (trailingCheck.triggered) {
            shouldSell = true;
            sellType =
              trailingCheck.type === "take_profit"
                ? "TAKE_PROFIT"
                : "STOP_LOSS";
          }

          if (shouldSell) {
            const sellPrice = currentPrice;
            const quantity = grid.quantity;

            // Gercek PnL hesabi
            const priceDiff = sellPrice - grid.entryPrice;
            const grossPnL = priceDiff * quantity;

            // Cikis ucreti
            const exitNotional = sellPrice * quantity;
            const exitFee = (exitNotional * tradingFeePercent) / 100;

            // Net PnL = Brut PnL - Giris Ucreti - Cikis Ucreti
            const netPnL = grossPnL - grid.entryFee - exitFee;

            // Cross margin: PnL bakiyeye eklenir
            this.balance += grossPnL - exitFee;
            this.totalPnL += netPnL;
            this.totalFees += exitFee;
            this.currentPosition -= quantity;

            if (netPnL > 0) {
              this.winCount++;
            } else {
              this.lossCount++;
            }

            // Drawdown hesaplama
            if (this.balance > this.peakBalance) {
              this.peakBalance = this.balance;
            }
            const drawdown =
              ((this.peakBalance - this.balance) / this.peakBalance) * 100;
            if (drawdown > this.maxDrawdown) {
              this.maxDrawdown = drawdown;
            }

            // Grid'i sifirla - tekrar alis icin hazir
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
              gridLevel: j,
            });
          }
        }
      }
    }

    // Acik pozisyonlari son fiyatla degerlendir
    const lastPrice = priceData[priceData.length - 1].price;
    let unrealizedPnL = 0;
    let openPositionCount = 0;

    for (const grid of this.gridLevels) {
      if (grid.hasSellOrder && grid.entryPrice !== null) {
        const priceDiff = lastPrice - grid.entryPrice;
        const grossUnrealized = priceDiff * grid.quantity;
        // Acik pozisyonlar icin tahmini cikis ucreti (giris ucreti zaten bakiyeden dusuldu)
        const estimatedExitFee =
          (lastPrice * grid.quantity * this.config.tradingFeePercent) / 100;
        unrealizedPnL += grossUnrealized - estimatedExitFee;
        openPositionCount++;
      }
    }

    return this.generateResults(priceData, unrealizedPnL, openPositionCount);
  }

  // Sonuclari olustur
  generateResults(priceData, unrealizedPnL, openPositionCount) {
    const totalTrades = this.trades.length;
    const buyTrades = this.trades.filter((t) => t.type === "BUY").length;
    const sellTrades = this.trades.filter((t) => t.type !== "BUY").length;
    const winRate =
      sellTrades > 0 ? ((this.winCount / sellTrades) * 100).toFixed(2) : 0;
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
        buyTrades: buyTrades,
        sellTrades: sellTrades,
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
    const results = backtest.runBacktest(priceData);

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
