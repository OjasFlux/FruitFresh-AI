
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const app = express();
// Render sits behind a reverse proxy; trust one hop so per-client settings rate limits work.
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 5000;
const MODEL_ID = "fruit-ripening-process/2";
const API_KEY = process.env.ROBOFLOW_API_KEY;

// Dashboard-managed Adafruit credentials are stored in Render's environment,
// never in browser storage or the local filesystem. Only this server uses the
// Render API token. Keep the settings password strong and private.
const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || "").trim();
const DASHBOARD_SETTINGS_PASSWORD = process.env.DASHBOARD_SETTINGS_PASSWORD || "";
const DEVICE_CONFIG_TOKEN = (process.env.DEVICE_CONFIG_TOKEN || "").trim();
const RENDER_API_ROOT = "https://api.render.com/v1";
const AIO_API_ROOT = "https://io.adafruit.com/api/v2";
const SETTINGS_MAX_FAILURES = 5;
const SETTINGS_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const settingsFailures = new Map();

// Adafruit IO cloud configuration. Keep AIO_KEY only on the backend and ESP8266.
const AIO_USERNAME = (process.env.AIO_USERNAME || "").trim();
const AIO_KEY = (process.env.AIO_KEY || "").trim();
const AIO_TEMPERATURE_FEED = (process.env.AIO_TEMPERATURE_FEED || "temperature").trim();
const AIO_HUMIDITY_FEED = (process.env.AIO_HUMIDITY_FEED || "humidity").trim();
const AIO_MQ135_FEED = (process.env.AIO_MQ135_FEED || "mq135").trim();
const AIO_SPOILAGE_FEED = (process.env.AIO_SPOILAGE_FEED || "spoilage-alert").trim();
const ROTTEN_ALERT_THRESHOLD = Math.max(0, Math.min(1, Number(process.env.ROTTEN_ALERT_THRESHOLD || 0.70)));
const ROTTEN_TRIGGER_FRAMES = Math.max(1, Math.min(10, Number.parseInt(process.env.ROTTEN_TRIGGER_FRAMES || "2", 10) || 2));
const ROTTEN_CLEAR_FRAMES = Math.max(1, Math.min(10, Number.parseInt(process.env.ROTTEN_CLEAR_FRAMES || "3", 10) || 3));
const ALERT_PUBLISH_RETRY_MS = 15000;
const ALERT_ACTIVE_HEARTBEAT_MS = 30000;
const DETECTION_STALE_AFTER_MS = 15000;
const AIO_REFRESH_INTERVAL_MS = 15000;
const SENSOR_STALE_AFTER_MS = 90000;
app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://10.197.254.3:5173",
  ],
}));

app.use(express.json({ limit: "5mb" }));

// Cached latest reading pulled from Adafruit IO. The ESP8266 publishes directly
// to the cloud, so sensor uploads do not depend on this laptop being online.
let latestSensorData = null;
let lastAioAttemptAt = 0;
let lastAioError = "";
let lastMq135Error = "";
let aioRefreshInFlight = null;

// Spoilage-alert state is in memory only. A confident "rotten" prediction
// must appear in several consecutive frames before the alert switches on.
// The alert is published only on state change, with a slow heartbeat while active
// so an ESP8266 that reconnects can request/receive the current state.
let spoilageAlertActive = false;
let rottenConsecutiveFrames = 0;
let clearConsecutiveFrames = 0;
let spoilageTriggerConfidence = null;
let spoilageAlertSince = null;
let lastSuccessfulDetectionAt = 0;
let lastAlertPublishedValue = null;
let lastAlertAttemptValue = null;
let lastAlertPublishAttemptAt = 0;
let lastAlertPublishError = "";
let alertPublishInFlight = null;

function spoilageAlertConfigured() {
  return Boolean(AIO_USERNAME && AIO_KEY && AIO_SPOILAGE_FEED);
}

function getSpoilageAlertStatus() {
  return {
    active: spoilageAlertActive,
    configured: spoilageAlertConfigured(),
    feed: AIO_SPOILAGE_FEED,
    confidenceThreshold: ROTTEN_ALERT_THRESHOLD,
    requiredTriggerFrames: ROTTEN_TRIGGER_FRAMES,
    requiredClearFrames: ROTTEN_CLEAR_FRAMES,
    triggerConfidence: spoilageTriggerConfidence,
    activeSince: spoilageAlertSince,
    lastDetectionAt: lastSuccessfulDetectionAt ? new Date(lastSuccessfulDetectionAt).toISOString() : null,
    published: lastAlertPublishedValue === null ? null : lastAlertPublishedValue === "1",
    publishError: lastAlertPublishError || "",
  };
}

async function postSpoilageAlert(value) {
  const endpoint = new URL(
    `${AIO_API_ROOT}/${encodeURIComponent(AIO_USERNAME)}/feeds/${encodeURIComponent(AIO_SPOILAGE_FEED)}/data`
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-AIO-Key": AIO_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ value }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    // Do not surface credentials or the raw upstream body in logs/UI.
    throw new Error(`Adafruit IO alert feed publish failed (HTTP ${response.status}). Confirm the '${AIO_SPOILAGE_FEED}' feed exists and the AIO key has write access.`);
  }
}

function requestSpoilageAlertPublish(force = false) {
  if (!spoilageAlertConfigured()) {
    lastAlertPublishError = "Set AIO_USERNAME and AIO_KEY on the backend and create the spoilage-alert feed.";
    return;
  }
  if (alertPublishInFlight) return;

  const desiredValue = spoilageAlertActive ? "1" : "0";
  const now = Date.now();
  const stateChanged = desiredValue !== lastAlertPublishedValue;
  const activeHeartbeatDue = desiredValue === "1" && now - lastAlertPublishAttemptAt >= ALERT_ACTIVE_HEARTBEAT_MS;
  if (!force && !stateChanged && !activeHeartbeatDue) return;
  if (!force && lastAlertAttemptValue === desiredValue && now - lastAlertPublishAttemptAt < ALERT_PUBLISH_RETRY_MS) return;

  lastAlertAttemptValue = desiredValue;
  lastAlertPublishAttemptAt = now;
  alertPublishInFlight = (async () => {
    try {
      await postSpoilageAlert(desiredValue);
      lastAlertPublishedValue = desiredValue;
      lastAlertPublishError = "";
      console.log(`Spoilage alert published: ${desiredValue === "1" ? "ACTIVE" : "CLEAR"}`);
    } catch (error) {
      lastAlertPublishError = error.name === "TimeoutError"
        ? "Adafruit IO alert publish timed out. It will retry."
        : error.message || "Could not publish the spoilage alert.";
      console.error("Adafruit IO spoilage alert:", lastAlertPublishError);
    } finally {
      alertPublishInFlight = null;
      // If the desired state changed while a request was in flight, publish it next.
      if (spoilageAlertConfigured() && (spoilageAlertActive ? "1" : "0") !== lastAlertPublishedValue) {
        requestSpoilageAlertPublish(false);
      }
    }
  })();
}

function updateSpoilageAlert(predictions) {
  lastSuccessfulDetectionAt = Date.now();
  expireStaleSpoilageAlert();

  const confidentRotten = (Array.isArray(predictions) ? predictions : [])
    .map((item) => ({
      normalizedClass: String(item?.class || "").toLowerCase().replace(/[^a-z0-9]/g, ""),
      confidence: Number(item?.confidence),
    }))
    .filter((item) => item.normalizedClass === "rotten" && Number.isFinite(item.confidence) && item.confidence >= ROTTEN_ALERT_THRESHOLD);

  if (confidentRotten.length > 0) {
    rottenConsecutiveFrames += 1;
    clearConsecutiveFrames = 0;
    spoilageTriggerConfidence = Math.max(...confidentRotten.map((item) => item.confidence));
    if (!spoilageAlertActive && rottenConsecutiveFrames >= ROTTEN_TRIGGER_FRAMES) {
      spoilageAlertActive = true;
      spoilageAlertSince = new Date().toISOString();
      console.warn(`Spoilage alert ACTIVE (rotten confidence ${Math.round(spoilageTriggerConfidence * 100)}%).`);
    }
  } else {
    clearConsecutiveFrames += 1;
    rottenConsecutiveFrames = 0;
    if (spoilageAlertActive && clearConsecutiveFrames >= ROTTEN_CLEAR_FRAMES) {
      spoilageAlertActive = false;
      spoilageAlertSince = null;
      spoilageTriggerConfidence = null;
      console.log("Spoilage alert CLEAR after consecutive frames without a confident rotten prediction.");
    }
  }

  // Publish on transitions, retry failures slowly, and refresh active state at a
  // modest heartbeat interval so a reconnecting device can catch up via /get.
  requestSpoilageAlertPublish(false);
  return getSpoilageAlertStatus();
}

function expireStaleSpoilageAlert() {
  if (
    spoilageAlertActive &&
    lastSuccessfulDetectionAt > 0 &&
    Date.now() - lastSuccessfulDetectionAt > DETECTION_STALE_AFTER_MS
  ) {
    spoilageAlertActive = false;
    rottenConsecutiveFrames = 0;
    clearConsecutiveFrames = 0;
    spoilageTriggerConfidence = null;
    spoilageAlertSince = null;
    console.warn("Spoilage alert CLEAR because fresh camera inference stopped arriving.");
    requestSpoilageAlertPublish(false);
  }
}

function adafruitConfigured() {
  // Temperature and humidity are required. MQ-135 is optional so the DHT22 data
  // remains visible while the gas sensor or its feed is being configured.
  return Boolean(AIO_USERNAME && AIO_KEY && AIO_TEMPERATURE_FEED && AIO_HUMIDITY_FEED);
}

async function fetchLatestAioFeed(feedKey) {
  const endpoint = new URL(
    `${AIO_API_ROOT}/${encodeURIComponent(AIO_USERNAME)}/feeds/${encodeURIComponent(feedKey)}/data/last`
  );

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      "X-AIO-Key": AIO_KEY,
      "Accept": "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  const responseText = await response.text();
  let record;
  try {
    record = JSON.parse(responseText);
  } catch {
    throw new Error(`Adafruit IO returned an unreadable response for feed '${feedKey}'.`);
  }

  if (!response.ok) {
    // Don't log or return credentials. Feed names and HTTP status are enough to troubleshoot.
    throw new Error(`Adafruit IO feed '${feedKey}' request failed (HTTP ${response.status}). Check the username, key, and feed key.`);
  }

  const value = Number(record.value);
  const createdAt = record.created_at || record.createdAt;
  const timestamp = Date.parse(createdAt);

  if (!Number.isFinite(value) || !Number.isFinite(timestamp)) {
    throw new Error(`Adafruit IO feed '${feedKey}' has no valid numeric reading yet. Publish a reading from the ESP8266 first.`);
  }

  return { value, createdAt: new Date(timestamp).toISOString() };
}

async function refreshAdafruitSensorCache(force = false) {
  if (!adafruitConfigured()) {
    lastAioError = "Configure AIO_USERNAME and AIO_KEY in the project root .env file.";
    return;
  }

  if (aioRefreshInFlight) {
    await aioRefreshInFlight;
    return;
  }

  const now = Date.now();
  if (!force && now - lastAioAttemptAt < AIO_REFRESH_INTERVAL_MS) return;
  lastAioAttemptAt = now;

  aioRefreshInFlight = (async () => {
    try {
      // DHT22 feeds are required. MQ-135 is fetched independently so a missing
      // or not-yet-published gas feed cannot hide valid temperature/humidity.
      const [temperatureResult, humidityResult, mq135Result] = await Promise.allSettled([
        fetchLatestAioFeed(AIO_TEMPERATURE_FEED),
        fetchLatestAioFeed(AIO_HUMIDITY_FEED),
        fetchLatestAioFeed(AIO_MQ135_FEED),
      ]);

      if (temperatureResult.status === "rejected") throw temperatureResult.reason;
      if (humidityResult.status === "rejected") throw humidityResult.reason;

      const temperature = temperatureResult.value;
      const humidity = humidityResult.value;
      const mq135 = mq135Result.status === "fulfilled" ? mq135Result.value : null;
      const pairTimestamp = Math.min(
        Date.parse(temperature.createdAt),
        Date.parse(humidity.createdAt)
      );

      latestSensorData = {
        deviceId: "ESP8266-ESP12E",
        source: "Adafruit IO",
        temperature: Number(temperature.value.toFixed(2)),
        humidity: Number(humidity.value.toFixed(2)),
        mq135Raw: mq135 ? Math.round(mq135.value) : null,
        receivedAt: new Date(pairTimestamp).toISOString(),
        temperatureUpdatedAt: temperature.createdAt,
        humidityUpdatedAt: humidity.createdAt,
        mq135UpdatedAt: mq135 ? mq135.createdAt : null,
      };
      lastAioError = "";
      lastMq135Error = mq135Result.status === "rejected"
        ? (mq135Result.reason?.message || "MQ-135 feed has no reading yet.")
        : "";
    } catch (error) {
      lastAioError = error.name === "TimeoutError"
        ? "Adafruit IO timed out. The last saved cloud reading is being retained."
        : error.message || "Could not read the Adafruit IO feeds.";
      console.error("Adafruit IO sensor refresh:", lastAioError);
    } finally {
      aioRefreshInFlight = null;
    }
  })();

  await aioRefreshInFlight;
}

function dashboardSettingsEnabled() {
  return Boolean(
    RENDER_API_KEY &&
    /^srv-[A-Za-z0-9]+$/.test(RENDER_SERVICE_ID) &&
    DASHBOARD_SETTINGS_PASSWORD.length >= 12 &&
    DEVICE_CONFIG_TOKEN.length >= 24
  );
}

function safePasswordMatch(supplied, expected) {
  // Hash both inputs first, so timingSafeEqual always compares equal-length buffers.
  const suppliedHash = crypto.createHash("sha256").update(String(supplied || "")).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(suppliedHash, expectedHash);
}

function settingsRateLimit(req) {
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const previous = settingsFailures.get(key);
  if (!previous || now - previous.startedAt > SETTINGS_FAILURE_WINDOW_MS) {
    settingsFailures.set(key, { startedAt: now, failures: 0 });
    return { key, limited: false };
  }
  return { key, limited: previous.failures >= SETTINGS_MAX_FAILURES };
}

function recordSettingsFailure(key) {
  const now = Date.now();
  const entry = settingsFailures.get(key);
  if (!entry || now - entry.startedAt > SETTINGS_FAILURE_WINDOW_MS) {
    settingsFailures.set(key, { startedAt: now, failures: 1 });
  } else {
    entry.failures += 1;
  }
}

async function callRenderApi(endpointPath, options = {}) {
  const response = await fetch(`${RENDER_API_ROOT}${endpointPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${RENDER_API_KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    // Do not forward the Render API response body; it may include sensitive metadata.
    throw new Error(`Render API request failed (HTTP ${response.status}). Check the Render API key, service ID, and service-level environment variable settings.`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function validateAdafruitCredentials(username, aioKey) {
  const endpoint = `${AIO_API_ROOT}/${encodeURIComponent(username)}/feeds?limit=1`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { "X-AIO-Key": aioKey, Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Adafruit IO rejected this username/key. Check both values and try again.");
  }
  if (!response.ok) {
    throw new Error(`Could not validate Adafruit IO credentials (HTTP ${response.status}). Try again shortly.`);
  }
}

// The ESP8266 uses a stable device token and talks to this hosted backend over
// HTTPS. The AIO key stays server-side: the backend publishes readings to Adafruit
// IO, and the device polls the current alert state here. Rotating AIO credentials
// in dashboard Settings therefore does not require reflashing the ESP8266.
async function publishSensorValueToAio(feedKey, value) {
  const endpoint = `${AIO_API_ROOT}/${encodeURIComponent(AIO_USERNAME)}/feeds/${encodeURIComponent(feedKey)}/data`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-AIO-Key": AIO_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ value }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`Adafruit IO feed '${feedKey}' publish failed (HTTP ${response.status}).`);
  }
}

function deviceTokenIsValid(req) {
  const suppliedToken = req.get("X-Device-Token") || "";
  return Boolean(DEVICE_CONFIG_TOKEN && safePasswordMatch(suppliedToken, DEVICE_CONFIG_TOKEN));
}

app.post("/api/device/readings", async (req, res) => {
  if (!DEVICE_CONFIG_TOKEN || DEVICE_CONFIG_TOKEN.length < 24) {
    return res.status(503).json({ error: "Device API is not configured." });
  }
  if (!deviceTokenIsValid(req)) {
    return res.status(401).json({ error: "Unauthorized device." });
  }
  if (!adafruitConfigured()) {
    return res.status(503).json({ error: "Adafruit IO is not configured on the backend." });
  }

  const { temperature, humidity, mq135Raw } = req.body || {};
  const temp = Number(temperature);
  const hum = Number(humidity);
  const mq = Number(mq135Raw);
  if (
    !Number.isFinite(temp) || temp < -40 || temp > 85 ||
    !Number.isFinite(hum) || hum < 0 || hum > 100 ||
    !Number.isInteger(mq) || mq < 0 || mq > 1023
  ) {
    return res.status(400).json({ error: "Invalid sensor values. Check temperature, humidity, and MQ-135 ADC readings." });
  }

  try {
    const results = await Promise.allSettled([
      publishSensorValueToAio(AIO_TEMPERATURE_FEED, Number(temp.toFixed(2))),
      publishSensorValueToAio(AIO_HUMIDITY_FEED, Number(hum.toFixed(2))),
      publishSensorValueToAio(AIO_MQ135_FEED, mq),
    ]);
    const failures = results.filter((item) => item.status === "rejected");
    if (failures.length) {
      const messages = failures.map((item) => item.reason?.message || "Adafruit IO publish failed.");
      console.error("Device sensor forwarding:", messages.join(" | "));
      return res.status(502).json({ error: "One or more readings could not be sent to Adafruit IO. Check the account key and feed names." });
    }

    res.status(201).json({ accepted: true, source: "ESP8266", published: true, publishedAt: new Date().toISOString() });
  } catch (error) {
    console.error("Device sensor forwarding error:", error.message);
    res.status(502).json({ error: "Could not forward sensor readings to Adafruit IO." });
  }
});

app.get("/api/device/alert", (req, res) => {
  if (!DEVICE_CONFIG_TOKEN || DEVICE_CONFIG_TOKEN.length < 24) {
    return res.status(503).json({ error: "Device API is not configured." });
  }
  if (!deviceTokenIsValid(req)) {
    return res.status(401).json({ error: "Unauthorized device." });
  }

  expireStaleSpoilageAlert();
  const stateKnown = lastSuccessfulDetectionAt > 0 && Date.now() - lastSuccessfulDetectionAt <= DETECTION_STALE_AFTER_MS;
  res.set("Cache-Control", "no-store");
  res.json({
    configured: spoilageAlertConfigured(),
    stateKnown,
    active: stateKnown && spoilageAlertActive,
    updatedAt: lastSuccessfulDetectionAt ? new Date(lastSuccessfulDetectionAt).toISOString() : null,
  });
});

// The gear button exposes only a non-secret status. The AIO key is never sent back
// to React, even after a successful update.
app.get("/api/settings/status", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    enabled: dashboardSettingsEnabled(),
    aioUsername: AIO_USERNAME || "",
    aioKeyConfigured: Boolean(AIO_KEY),
    message: dashboardSettingsEnabled()
      ? "Adafruit IO credentials can be updated securely here."
      : "Credential settings need RENDER_API_KEY, RENDER_SERVICE_ID, DASHBOARD_SETTINGS_PASSWORD (12+ characters), and DEVICE_CONFIG_TOKEN (24+ characters) in Render's service environment.",
  });
});

app.post("/api/settings/adafruit", async (req, res) => {
  if (!dashboardSettingsEnabled()) {
    return res.status(503).json({
      error: "Dashboard credential settings are not enabled. Configure RENDER_API_KEY, RENDER_SERVICE_ID, DASHBOARD_SETTINGS_PASSWORD, and DEVICE_CONFIG_TOKEN on Render first.",
    });
  }

  const rate = settingsRateLimit(req);
  if (rate.limited) {
    return res.status(429).json({ error: "Too many unsuccessful settings attempts. Wait 15 minutes and try again." });
  }

  const { adminPassword, username: rawUsername, aioKey: rawAioKey } = req.body || {};
  const username = typeof rawUsername === "string" ? rawUsername.trim() : "";
  const aioKey = typeof rawAioKey === "string" ? rawAioKey.trim() : "";

  if (!safePasswordMatch(adminPassword, DASHBOARD_SETTINGS_PASSWORD)) {
    recordSettingsFailure(rate.key);
    return res.status(401).json({ error: "Settings password is incorrect." });
  }
  settingsFailures.delete(rate.key);

  if (!username || username.length > 100 || /\s/.test(username)) {
    return res.status(400).json({ error: "Enter a valid Adafruit IO username without spaces." });
  }
  if (!aioKey || aioKey.length < 12 || aioKey.length > 300 || /\s/.test(aioKey)) {
    return res.status(400).json({ error: "Enter a valid Adafruit IO key without spaces." });
  }

  let credentialsSavedToRender = false;
  try {
    // Verify credentials before writing them to Render, preventing typos from
    // overwriting working service settings.
    await validateAdafruitCredentials(username, aioKey);

    const servicePath = `/services/${encodeURIComponent(RENDER_SERVICE_ID)}/env-vars`;
    // This endpoint updates one service-level env var at a time. These variables
    // must not be managed only by a linked Render environment group.
    await callRenderApi(`${servicePath}/AIO_KEY`, {
      method: "PUT",
      body: JSON.stringify({ value: aioKey }),
    });
    try {
      await callRenderApi(`${servicePath}/AIO_USERNAME`, {
        method: "PUT",
        body: JSON.stringify({ value: username }),
      });
    } catch (usernameError) {
      // Best-effort rollback of the first update, using the credentials already
      // loaded by this instance; do not log the values.
      if (AIO_KEY) {
        try {
          await callRenderApi(`${servicePath}/AIO_KEY`, {
            method: "PUT",
            body: JSON.stringify({ value: AIO_KEY }),
          });
        } catch { /* leave the original, actionable error below */ }
      }
      throw usernameError;
    }

    credentialsSavedToRender = true;
    try {
      await callRenderApi(`/services/${encodeURIComponent(RENDER_SERVICE_ID)}/deploys`, {
        method: "POST",
        body: JSON.stringify({ clearCache: "do_not_clear" }),
      });
    } catch (deployError) {
      return res.status(502).json({
        error: "Adafruit IO credentials were saved in Render, but Render did not start the redeployment. Open Render and choose Manual Deploy → Deploy latest commit.",
      });
    }

    console.log("Adafruit IO credentials validated and Render redeployment requested from dashboard settings.");
    return res.status(202).json({
      saved: true,
      deploying: true,
      message: "Adafruit IO credentials validated and saved. Render is redeploying the service now; the dashboard may briefly reconnect.",
    });
  } catch (error) {
    console.error("Dashboard Adafruit settings update failed:", error.message);
    return res.status(502).json({
      error: credentialsSavedToRender
        ? "The credentials are saved in Render, but redeployment did not complete. Open Render and manually deploy the latest service configuration."
        : (error.message || "Could not save Adafruit IO settings. Check credentials and Render configuration."),
    });
  }
});

app.get("/api/health", (req, res) => {
  expireStaleSpoilageAlert();
  res.json({
    status: "ok",
    model: MODEL_ID,
    apiKeyConfigured: Boolean(API_KEY),
    adafruitConfigured: adafruitConfigured(),
    spoilageAlertConfigured: spoilageAlertConfigured(),
    spoilageAlert: getSpoilageAlertStatus(),
  });
});

app.get("/api/alerts", (req, res) => {
  expireStaleSpoilageAlert();
  res.set("Cache-Control", "no-store");
  res.json(getSpoilageAlertStatus());
});

// If the camera page is closed or inference stops, fail safe by clearing an
// active hardware alarm rather than leaving the buzzer on indefinitely.
const spoilageStaleGuard = setInterval(expireStaleSpoilageAlert, 3000);
if (typeof spoilageStaleGuard.unref === "function") spoilageStaleGuard.unref();

// The dashboard reads this endpoint. The Node backend proxies Adafruit IO so the
// private Adafruit IO key is never exposed in browser JavaScript.
app.get("/api/sensors", async (req, res) => {
  await refreshAdafruitSensorCache();

  const ageMs = latestSensorData
    ? Date.now() - Date.parse(latestSensorData.receivedAt)
    : Infinity;
  const configured = adafruitConfigured();
  const connected = Boolean(latestSensorData && ageMs >= 0 && ageMs <= SENSOR_STALE_AFTER_MS);

  res.set("Cache-Control", "no-store");
  res.json({
    source: "Adafruit IO",
    configured,
    connected,
    data: latestSensorData,
    lastCheckedAt: lastAioAttemptAt ? new Date(lastAioAttemptAt).toISOString() : null,
    error: !configured
      ? "Adafruit IO is not configured. Add AIO_USERNAME and AIO_KEY to the project root .env file."
      : lastAioError || (!latestSensorData
        ? "No temperature/humidity cloud reading yet. Check the ESP8266 and the Adafruit IO temperature and humidity feeds."
        : (!connected ? "The latest temperature/humidity reading is older than 90 seconds. Check the ESP8266 and Adafruit IO feeds." : "")),
    mq135Error: lastMq135Error,
  });
});

app.post("/api/detect", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({
        error: "ROBOFLOW_API_KEY is missing from the project root .env file.",
      });
    }

    const { image } = req.body || {};

    if (
      typeof image !== "string" ||
      !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(image)
    ) {
      return res.status(400).json({ error: "A valid webcam frame is required." });
    }

    const base64Image = image.substring(image.indexOf(",") + 1);

    if (!base64Image || base64Image.length > 4_500_000) {
      return res.status(413).json({ error: "Image is empty or too large." });
    }

    const endpoint = new URL(
      `https://serverless.roboflow.com/${MODEL_ID}`
    );
    endpoint.searchParams.set("api_key", API_KEY);

    const inferenceResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: base64Image,
      signal: AbortSignal.timeout(30000),
    });

    const responseText = await inferenceResponse.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      return res.status(502).json({
        error: "Roboflow returned an invalid response.",
      });
    }

    if (!inferenceResponse.ok) {
      console.error("Roboflow error:", inferenceResponse.status, result);
      return res.status(inferenceResponse.status).json({
        error: result.message || result.error || "Inference failed.",
      });
    }

    const predictions = Array.isArray(result.predictions) ? result.predictions : [];
    const spoilageAlert = updateSpoilageAlert(predictions);
    res.json({ ...result, spoilageAlert });
  } catch (error) {
    console.error("Detection error:", error.message);

    res.status(error.name === "TimeoutError" ? 504 : 500).json({
      error: error.name === "TimeoutError"
        ? "Roboflow inference timed out."
        : "Detection request failed.",
    });
  }
});


// In production, serve the built React/Vite app from the same HTTPS origin.
// Local development still uses Vite on port 5173 and this server for /api routes.
if (process.env.NODE_ENV === "production") {
  const WEB_DIST_DIR = path.resolve(__dirname, "../web/dist");
  app.use(express.static(WEB_DIST_DIR, { maxAge: "1h", index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "API endpoint not found." });
    }
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`FruitFresh AI API (local): http://localhost:${PORT}`);
  console.log(`FruitFresh AI API (LAN):   http://10.197.254.3:${PORT}`);
  console.log(`Sensor API (Adafruit proxy): http://localhost:${PORT}/api/sensors`);
  if (process.env.NODE_ENV === "production") console.log("Serving the built React dashboard from this service.");
  console.log(`Model: ${MODEL_ID}`);
  console.log(`Roboflow API key: ${API_KEY ? "configured" : "MISSING"}`);
  console.log(`Adafruit IO: ${adafruitConfigured() ? `configured (required: ${AIO_TEMPERATURE_FEED}, ${AIO_HUMIDITY_FEED}; optional: ${AIO_MQ135_FEED})` : "NOT CONFIGURED: set AIO_USERNAME and AIO_KEY in ../.env"}`);
  console.log(`Spoilage alert: ${spoilageAlertConfigured() ? `feed '${AIO_SPOILAGE_FEED}', threshold ${Math.round(ROTTEN_ALERT_THRESHOLD * 100)}%, trigger ${ROTTEN_TRIGGER_FRAMES} frames, clear ${ROTTEN_CLEAR_FRAMES} frames` : "NOT CONFIGURED: create spoilage-alert feed and set AIO credentials"}`);
  if (spoilageAlertConfigured()) {
    // Clear any stale alert on server boot. The first new detections can raise it again.
    requestSpoilageAlertPublish(true);
  }
});
