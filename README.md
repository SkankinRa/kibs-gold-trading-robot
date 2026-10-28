# Kibs Gold Trading Robot

A responsive, signals-only gold (XAU/USD) dashboard built with HTML, CSS and JavaScript. It does not use Deriv APIs and does not place trades.

## What is included

- Real gold spot reference price from XAUS
- Intraday sampled price series from XAUS
- Candles aggregated from returned observations for 5m, 15m and 1h views
- EMA 20 and EMA 50
- BUY BIAS / SELL BIAS / WAIT trend filter
- Explicit freshness/error states; the app does not generate fake prices
- Mobile-friendly layout

## Important candle limitation

The free XAUS intraday endpoint returns sampled price points, not exchange-grade OHLC bars. This website aggregates the real returned observations into candles. Therefore, a candle's high and low only reflect observations that were sampled; movements between samples may be missed. This is useful for a free prototype, but it is not suitable as an execution-grade or guaranteed-trading feed.

The signal is a simple trend filter, not financial advice and not a promise of profit. A BUY BIAS or SELL BIAS is not an instruction to trade. Check your chosen broker's own executable quote and confirm any trade manually.

## Files

- `index.html` — page layout
- `styles.css` — responsive styling
- `app.js` — API calls, candle aggregation, EMA calculations and signal rules

## Publish free with GitHub Pages

You can do this from your Android phone in Chrome.

1. Sign in or create an account at https://github.com/.
2. Create a new **public** repository named `kibs-gold-trading-robot`.
3. Upload `index.html`, `styles.css`, `app.js`, and `README.md` to the repository's root folder. Do not upload the ZIP file as the only item; the three website files must be at the root.
4. Open the repository's **Settings**.
5. Choose **Pages** from the left menu.
6. Under the build/deployment section, choose **Deploy from a branch**.
7. Select branch `main` and folder `/(root)`, then Save.
8. Wait for GitHub Pages to publish. The website address will be shown on the Pages settings screen.

GitHub may take a few minutes to publish the first time. You do not need to buy a domain to test it.

## Troubleshooting

- If the chart library does not load, check your internet connection and reload.
- If the data provider returns an error, the dashboard will show a data error rather than fabricate a price.
- The market can be quiet or closed at weekends; reference feeds may repeat the last quote.
- A free provider can change or become unavailable. If its API contract changes, update `app.js`.
- The browser must be online to load data and the chart library.

## Data source and attribution

Gold reference data: [XAUS Gold Data API](https://xaus.com/api/). Please review its documentation and terms before public/commercial deployment. Gold spot prices are indicative reference prices and may differ from a broker's bid/ask quote.
