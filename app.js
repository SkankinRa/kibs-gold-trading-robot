/* Kibs Gold Trading Robot
 * Free reference feed: XAUS. No Deriv APIs, no order execution.
 * The API returns sampled prices; candles are aggregated from those observations.
 */
(() => {
  "use strict";

  const API = "https://xaus.com/api/v1";
  const REFRESH_MS = 60_000;
  const MAX_PRICE_AGE_SECONDS = 10 * 60;
  let selectedMinutes = 15;
  let rawPoints = [];
  let candles = [];
  let chart, candleSeries, ema20Series, ema50Series;
  let refreshTimer = null;
  let loading = false;

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
    $("dataStatus").style.color = kind === "good" ? "var(--green)" : kind === "bad" ? "var(--red)" : "var(--gold)";
  }

  function initChart() {
    if (!window.LightweightCharts) {
      setStatus("CHART LIBRARY ERROR", "Check internet connection", "bad");
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
    ema20Series = chart.addLineSeries({ color: "#e9c65c", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    ema50Series = chart.addLineSeries({ color: "#67a8ff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    new ResizeObserver(() => {
      if (chart) chart.applyOptions({ width: $("chart").clientWidth, height: $("chart").clientHeight });
    }).observe($("chart"));
  }

  function parseTime(value) {
    if (typeof value === "number") {
      // API timestamps may be seconds or milliseconds.
      return Math.floor(value > 1e12 ? value / 1000 : value);
    }
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
    return { fresh: age <= MAX_PRICE_AGE_SECONDS, asOf, age, reason: age > MAX_PRICE_AGE_SECONDS ? `Price is ${Math.floor(age / 60)} min old` : "" };
  }

  function formatPrice(price) {
    return Number(price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtTime(seconds) {
    if (!seconds) return "timestamp unavailable";
    return new Date(seconds * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function aggregateCandles(points, minutes) {
    const bucketSize = minutes * 60;
    const buckets = new Map();
    points.forEach((point) => {
      const start = Math.floor(point.time / bucketSize) * bucketSize;
      if (!buckets.has(start)) buckets.set(start, { time: start, open: point.price, high: point.price, low: point.price, close: point.price, count: 0 });
      const candle = buckets.get(start);
      candle.high = Math.max(candle.high, point.price);
      candle.low = Math.min(candle.low, point.price);
      candle.close = point.price;
      candle.count += 1;
    });
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
      .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close) && c.count > 0);
  }

  function calculateEma(items, period) {
    if (items.length < period) return [];
    const alpha = 2 / (period + 1);
    let ema = items.slice(0, period).reduce((sum, item) => sum + item.close, 0) / period;
    const result = [{ time: items[period - 1].time, value: ema }];
    for (let i = period; i < items.length; i++) {
      ema = items[i].close * alpha + ema * (1 - alpha);
      result.push({ time: items[i].time, value: ema });
    }
    return result;
  }

  function updateSignal(ema20, ema50) {
    const last = candles[candles.length - 1];
    const e20 = ema20[ema20.length - 1];
    const e50 = ema50[ema50.length - 1];
    const label = $("signalLabel");
    if (!last || !e20 || !e50) {
      label.textContent = "WAIT";
      label.className = "signal-wait";
      $("signalReason").textContent = "Need at least 50 candles for EMA 50";
      return;
    }
    if (last.close > e20.value && e20.value > e50.value) {
      label.textContent = "BUY BIAS";
      label.className = "signal-buy";
      $("signalReason").textContent = "Close > EMA 20 > EMA 50; trend filter only";
    } else if (last.close < e20.value && e20.value < e50.value) {
      label.textContent = "SELL BIAS";
      label.className = "signal-sell";
      $("signalReason").textContent = "Close < EMA 20 < EMA 50; trend filter only";
    } else {
      label.textContent = "WAIT";
      label.className = "signal-wait";
      $("signalReason").textContent = "Trend conditions are mixed; no clear alignment";
    }
  }

  function renderCandles() {
    candles = aggregateCandles(rawPoints, selectedMinutes);
    if (!candles.length) {
      setStatus("NO CANDLE DATA", "Provider returned no usable observations", "bad");
      return;
    }
    const ema20 = calculateEma(candles, 20);
    const ema50 = calculateEma(candles, 50);
    candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    ema20Series.setData(ema20);
    ema50Series.setData(ema50);
    chart.timeScale().fitContent();
    $("ema20Value").textContent = ema20.length ? formatPrice(ema20[ema20.length - 1].value) : "Not enough candles";
    $("ema50Value").textContent = ema50.length ? formatPrice(ema50[ema50.length - 1].value) : "Not enough candles";
    const last = candles[candles.length - 1];
    $("lastCandle").textContent = formatPrice(last.close);
    $("observationCount").textContent = String(rawPoints.length);
    updateSignal(ema20, ema50);
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
        fetchJson(`${API}/intraday?symbol=xau&hours=48`)
      ]);

      if (spotResult.status === "fulfilled") {
        const data = spotResult.value;
        const price = Number(data.spot_usd_oz ?? data.xau?.price);
        const freshness = isPriceFresh(data);
        if (Number.isFinite(price) && price > 0) {
          $("spotPrice").textContent = "$" + formatPrice(price);
          $("priceMeta").textContent = freshness.fresh ? "Spot reference · " + fmtTime(freshness.asOf) : "Not confirmed fresh · " + (freshness.reason || "check provider timestamp");
          if (!freshness.fresh) setStatus("STALE / CHECK", freshness.reason || "Provider did not confirm freshness", "bad");
          else setStatus("CONNECTED", "Updated " + fmtTime(freshness.asOf), "good");
        } else {
          throw new Error("Provider did not return a valid gold price.");
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
        $("dataUpdated").textContent = `${points.length} real samples${stateText}; last sample ${fmtTime(points[points.length - 1].time)}`;
        if (spotResult.status === "rejected") setStatus("CHART CONNECTED", "Spot quote unavailable; chart uses returned observations", "wait");
      } else {
        throw new Error(intradayResult.reason?.message || "Intraday feed is unavailable.");
      }
    } catch (error) {
      console.error("Kibs Gold data error:", error);
      if (!rawPoints.length) {
        $("chart").innerHTML = '<div class="chart-error">Live chart unavailable. No sample data has been invented.<br><br>' + escapeHtml(error.message) + '</div>';
      }
      setStatus("DATA ERROR", error.message || "Provider unavailable", "bad");
      showToast("Data error: " + (error.message || "Please try again later."));
    } finally {
      loading = false;
      $("refreshBtn").disabled = false;
      $("refreshBtn").textContent = "↻ Refresh";
    }
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
