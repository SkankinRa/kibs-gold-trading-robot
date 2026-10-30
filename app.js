/* Kibs Gold Trading Robot
 * Free reference feed: XAUS. No Deriv APIs, no order execution.
 * Candles are aggregated from returned sampled observations, not invented.
 *
 * Strategy:
 * - Weighted close (HLCC/4) = (High + Low + Close + Close) / 4
 * - LWMA 300 on weighted close
 * - LWMA 100 applied to the LWMA 300 line
 * - Stochastic K=1, D=1, slowing=1; levels 20/80
 */
(() => {
  "use strict";

  const API = "https://xaus.com/api/v1";
  const REFRESH_MS = 60_000;
  const MAX_PRICE_AGE_SECONDS = 10 * 60;
  const HISTORY_HOURS = 240;
  const STOCH_K = 1;
  const STOCH_D = 1;
  const STOCH_SLOWING = 1;
  const OVERSOLD = 20;
  const OVERBOUGHT = 80;

  let selectedMinutes = 15;
  let rawPoints = [];
  let candles = [];
  let chart, candleSeries, lwma300Series, lwma100Series;
  let loading = false;
  let priceFresh = false;
  let refreshTimer = null;

  const $ = (id) => document.getElementById(id);
  $("year").textContent = new Date().getFullYear();

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function setStatus(text, detail, kind = "wait") {
    $("dataStatus").textContent = text;
    $("dataUpdated").textContent = detail;
    $("dataStatus").style.color =
      kind === "good" ? "var(--green)" :
      kind === "bad" ? "var(--red)" : "var(--gold)";
  }

  function initChart() {
    if (!window.LightweightCharts) {
      setStatus("CHART LIBRARY ERROR", "Check your internet connection", "bad");
      $("chart").innerHTML = '<div class="chart-error">Chart library could not load. Check your connection and reload.</div>';
      return;
    }

    chart = LightweightCharts.createChart($("chart"), {
      width: $("chart").clientWidth,
      height: $("chart").clientHeight,
      layout: { background: { color: "#101927" }, textColor: "#9aabc1", fontFamily: "DM Sans, Arial" },
      grid: { vertLines: { color: "#1c2a3d" }, horzLines: { color: "#1c2a3d" } },
      rightPriceScale: { borderColor: "#29394f" },
      timeScale: { borderColor: "#29394f", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { priceFormatter: (price) => price.toFixed(2) }
    });

    candleSeries = chart.addCandlestickSeries({
      upColor: "#25d7a0", downColor: "#ff687b",
      borderUpColor: "#25d7a0", borderDownColor: "#ff687b",
      wickUpColor: "#25d7a0", wickDownColor: "#ff687b"
    });
    lwma300Series = chart.addLineSeries({
      color: "#111111", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      title: "LWMA 300"
    });
    lwma100Series = chart.addLineSeries({
      color: "#e8bd58", lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
      title: "LWMA 100 of LWMA 300"
    });

    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        if (chart) chart.applyOptions({ width: $("chart").clientWidth, height: $("chart").clientHeight });
      }).observe($("chart"));
    } else {
      window.addEventListener("resize", () => {
        if (chart) chart.applyOptions({ width: $("chart").clientWidth, height: $("chart").clientHeight });
      });
    }
  }

  function parseTime(value) {
    if (typeof value === "number") return Math.floor(value > 1e12 ? value / 1000 : value);
    if (typeof value === "string") {
      const n = Number(value);
      if (Number.isFinite(n) && value.trim() !== "") return Math.floor(n > 1e12 ? n / 1000 : n);
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    }
    return null;
  }

  function extractPoints(payload) {
    const candidates = [
      payload && payload.points,
      payload && payload.data && payload.data.points,
      payload && payload.series,
      payload && payload.data && payload.data.series
    ];
    const list = candidates.find(Array.isArray);
    if (!list) throw new Error("Provider response did not contain an intraday points array.");

    return list.map((item) => {
      const t = parseTime(item.t ?? item.time ?? item.timestamp ?? item.date);
      const p = Number(item.p ?? item.price ?? item.close ?? item.c);
      return { time: t, price: p };
    }).filter((p) => p.time !== null && Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.time - b.time)
      .filter((p, i, arr) => i === 0 || p.time !== arr[i - 1].time);
  }

  async function fetchJson(url) {
    const response = await fetch(url, { method: "GET", cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Data provider returned HTTP ${response.status}.`);
    return body;
  }

  function isPriceFresh(payload) {
    const state = payload.data_state || {};
    const asOf = parseTime(payload.price_as_of || state.as_of || payload.updated_at);
    if (payload.stale === true || state.status === "stale") {
      return { fresh: false, asOf, reason: "Provider reports cached/stale data" };
    }
    if (!asOf) return { fresh: false, asOf: null, reason: "Provider timestamp missing" };
    const age = Math.max(0, Math.floor(Date.now() / 1000) - asOf);
    return {
      fresh: age <= MAX_PRICE_AGE_SECONDS,
      asOf,
      reason: age > MAX_PRICE_AGE_SECONDS ? `Price is ${Math.floor(age / 60)} min old` : ""
    };
  }

  function formatPrice(price) {
    return Number(price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtTime(seconds) {
    if (!seconds) return "timestamp unavailable";
    return new Date(seconds * 1000).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });
  }

  function aggregateCandles(points, minutes) {
    const bucketSize = minutes * 60;
    const buckets = new Map();

    points.forEach((point) => {
      const start = Math.floor(point.time / bucketSize) * bucketSize;
      if (!buckets.has(start)) {
        buckets.set(start, {
          time: start, open: point.price, high: point.price,
          low: point.price, close: point.price, count: 0
        });
      }
      const candle = buckets.get(start);
      candle.high = Math.max(candle.high, point.price);
      candle.low = Math.min(candle.low, point.price);
      candle.close = point.price;
      candle.count += 1;
    });

    return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
      .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close) && c.count > 0);
  }

  // LWMA gives the newest value the largest weight.
  function calculateLWMA(values, period) {
    if (!Array.isArray(values) || values.length < period) return [];
    const result = [];
    const denominator = period * (period + 1) / 2;

    for (let end = period - 1; end < values.length; end++) {
      let weightedSum = 0;
      let valid = true;
      for (let j = 0; j < period; j++) {
        const value = values[end - period + 1 + j].value;
        if (!Number.isFinite(value)) {
          valid = false;
          break;
        }
        weightedSum += value * (j + 1);
      }
      if (valid) result.push({
        time: values[end].time,
        value: weightedSum / denominator
      });
    }
    return result;
  }

  // HLCC/4 weighted close = (High + Low + Close + Close) / 4.
  function calculateWeightedClose(candleList) {
    return candleList.map((candle) => ({
      time: candle.time,
      value: (candle.high + candle.low + candle.close + candle.close) / 4
    }));
  }

  function calculateStochastic(candleList) {
  if (!Array.isArray(candleList) || candleList.length < 1) {
    return null;
  }

  // Stochastic K=1, D=1, slowing=1.
  // Use the candle's actual Close, High and Low.
  const candle = candleList[candleList.length - 1];

  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);

  if (
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    high < low ||
    close < low ||
    close > high
  ) {
    return null;
  }

  const range = high - low;

  // Avoid dividing by zero when the candle has no price range.
  const rawK = range === 0
    ? 50
    : ((close - low) / range) * 100;

  const k = Math.max(0, Math.min(100, rawK));

  // D=1 and slowing=1: no additional smoothing.
  return {
    k: k,
    d: k
  };

  }

  function setSignal(labelText, className, reason) {
    const label = $("signalLabel");
    label.textContent = labelText;
    label.className = className;
    $("signalReason").textContent = reason;
  }

  function updateSignal(lwma300, lwma100, stochastic) {
    const last300 = lwma300[lwma300.length - 1];
    const last100 = lwma100[lwma100.length - 1];

    if (!priceFresh) {
      setSignal("WAIT", "signal-wait", "Spot feed is stale or freshness could not be confirmed.");
      return;
    }
    if (!last300 || !last100 || !stochastic) {
      setSignal("WAIT", "signal-wait",
        `Need at least 399 candles for LWMA 300 plus LWMA 100; currently ${candles.length}.`);
      return;
    }

    if (last100.value > last300.value && stochastic.k <= OVERSOLD) {
      setSignal("BUY WATCH", "signal-buy",
        `LWMA100-of-LWMA300 > LWMA300 and Stochastic ${stochastic.k.toFixed(1)} ≤ ${OVERSOLD}. Confirm manually.`);
    } else if (last100.value < last300.value && stochastic.k >= OVERBOUGHT) {
      setSignal("SELL WATCH", "signal-sell",
        `LWMA100-of-LWMA300 < LWMA300 and Stochastic ${stochastic.k.toFixed(1)} ≥ ${OVERBOUGHT}. Confirm manually.`);
    } else {
      setSignal("WAIT", "signal-wait",
        `Conditions not aligned. Stochastic ${stochastic.k.toFixed(1)}; BUY needs ≤ ${OVERSOLD}, SELL needs ≥ ${OVERBOUGHT}.`);
    }
  }

  function renderCandles() {
    candles = aggregateCandles(rawPoints, selectedMinutes);
    if (!candles.length) {
      setStatus("NO CANDLE DATA", "Provider returned no usable observations", "bad");
      setSignal("WAIT", "signal-wait", "No usable candle data.");
      return;
    }

    const weightedClose = calculateWeightedClose(candles);
    const lwma300 = calculateLWMA(weightedClose, 300);
    const lwma100 = calculateLWMA(lwma300, 100);
    const stochastic = calculateStochastic(candles);

    if (candleSeries) {
      candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      lwma300Series.setData(lwma300);
      lwma100Series.setData(lwma100);
      chart.timeScale().fitContent();
    }

    $("lwma300Value").textContent = lwma300.length ? formatPrice(lwma300[lwma300.length - 1].value) : "Need 300 candles";
    $("lwma100Value").textContent = lwma100.length ? formatPrice(lwma100[lwma100.length - 1].value) : "Need 399 candles";
    $("stochasticValue").textContent = stochastic ? `${stochastic.k.toFixed(1)} / ${stochastic.d.toFixed(1)}` : "Unavailable";
    $("lastCandle").textContent = formatPrice(candles[candles.length - 1].close);
    $("observationCount").textContent = String(rawPoints.length);

    updateSignal(lwma300, lwma100, stochastic);
  }

  async function refreshData() {
    if (loading) return;
    loading = true;
    $("refreshBtn").disabled = true;
    $("refreshBtn").textContent = "Loading…";
    setStatus("CONNECTING", "Requesting provider data");

    try {
      const [spotResult, intradayResult] = await Promise.allSettled([
        fetchJson(`${API}/spot?compact=1&fresh=${Date.now()}`),
        fetchJson(`${API}/intraday?symbol=xau&hours=${HISTORY_HOURS}`)
      ]);

      priceFresh = false;
      if (spotResult.status === "fulfilled") {
        const data = spotResult.value;
        const price = Number(data.spot_usd_oz ?? data.xau?.price);
        const freshness = isPriceFresh(data);
        priceFresh = freshness.fresh;

        if (Number.isFinite(price) && price > 0) {
          $("spotPrice").textContent = "$" + formatPrice(price);
          $("priceMeta").textContent = freshness.fresh
            ? "Spot reference · " + fmtTime(freshness.asOf)
            : "Not confirmed fresh · " + (freshness.reason || "check provider timestamp");
          if (!freshness.fresh) setStatus("STALE / CHECK", freshness.reason || "Provider did not confirm freshness", "bad");
          else setStatus("CONNECTED", "Updated " + fmtTime(freshness.asOf), "good");
        } else {
          setStatus("PRICE UNAVAILABLE", "Provider did not return a valid gold price", "bad");
        }
      } else {
        $("priceMeta").textContent = "Current quote unavailable";
        setStatus("PRICE UNAVAILABLE", spotResult.reason?.message || "Could not load the gold spot price", "bad");
      }

      if (intradayResult.status === "fulfilled") {
        const points = extractPoints(intradayResult.value);
        if (points.length < 2) throw new Error("Not enough intraday observations yet.");
        rawPoints = points;
        renderCandles();

        const state = intradayResult.value.data_state || {};
        const stateText = state.status ? ` · feed ${state.status}` : "";
        $("dataUpdated").textContent =
          `${points.length} real samples${stateText}; last sample ${fmtTime(points[points.length - 1].time)}`;

        if (spotResult.status === "rejected") {
          setStatus("CHART CONNECTED", "Spot quote unavailable; signals held at WAIT", "bad");
          priceFresh = false;
          renderCandles();
        }
      } else {
        throw new Error(intradayResult.reason?.message || "Intraday feed is unavailable.");
      }
    } catch (error) {
      console.error("Kibs Gold data error:", error);
      setStatus("DATA ERROR", error.message || "Provider unavailable", "bad");
      setSignal("WAIT", "signal-wait", "Signal paused because the data request failed.");
      showToast("Data error: " + (error.message || "Please try again later."));
    } finally {
      loading = false;
      $("refreshBtn").disabled = false;
      $("refreshBtn").textContent = "↻ Refresh";
    }
  }

  document.querySelectorAll(".tf-btn").forEach((button) => {
    button.addEventListener("click", () => {
      selectedMinutes = Number(button.dataset.timeframe);
      document.querySelectorAll(".tf-btn").forEach((b) => b.classList.toggle("active", b === button));
      if (rawPoints.length) renderCandles();
    });
  });

  $("refreshBtn").addEventListener("click", refreshData);

  initChart();
  refreshData();
  refreshTimer = window.setInterval(refreshData, REFRESH_MS);
})();
