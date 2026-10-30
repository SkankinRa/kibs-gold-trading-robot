# Kibs Gold Trading Robot

Responsive XAU/USD reference dashboard. It uses the XAUS reference feed, HTML/CSS/JavaScript, and Lightweight Charts. It does not use Deriv APIs and does not place trades.

## Indicators
- Weighted close (HLCC/4): `(High + Low + Close + Close) / 4`
- LWMA 300 applied to weighted close
- LWMA 100 applied to the LWMA 300 line
- Stochastic K=1, D=1, slowing=1; levels 20 and 80

## Signals
- BUY WATCH: LWMA100-of-LWMA300 > LWMA300 and Stochastic <= 20
- SELL WATCH: LWMA100-of-LWMA300 < LWMA300 and Stochastic >= 80
- WAIT: conditions are not aligned, data is stale, or there are too few candles

The LWMA 300 plus the LWMA 100 applied to it requires at least 399 candles. With insufficient history, the app deliberately shows WAIT. The Stochastic 1,1,1 setting is very sensitive and should be backtested before use.

## Data limitation
The free XAUS intraday endpoint returns sampled price observations. The app aggregates only returned observations into approximate candles; it does not fabricate missing prices and does not receive exchange-grade OHLC candles. The feed may be delayed or unavailable. Always confirm broker quotes and trades manually.
