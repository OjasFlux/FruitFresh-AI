
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Camera,
  CameraOff,
  CheckCircle2,
  CircleAlert,
  ScanLine,
  ShieldAlert,
  Thermometer,
  Droplets,
  Wifi,
  WifiOff,
} from "lucide-react";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "" : "http://localhost:5000");

const CLASS_INFO = {
  freshripe: { label: "Fresh Ripe", color: "#35d399" },
  freshunripe: { label: "Fresh Unripe", color: "#60a5fa" },
  overripe: { label: "Overripe", color: "#fbbf24" },
  ripe: { label: "Ripe", color: "#34d399" },
  rotten: { label: "Rotten", color: "#fb7185" },
  unripe: { label: "Unripe", color: "#93c5fd" },
};

function getClassInfo(name = "unknown") {
  const key = name.toLowerCase().replace(/[\s_-]/g, "");
  return CLASS_INFO[key] || {
    label: name.replace(/[_-]/g, " "),
    color: "#a5b4fc",
  };
}

function drawDetections(canvas, image, predictions) {
  const context = canvas.getContext("2d");
  if (!context) return;

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  predictions.forEach((item) => {
    const x = Number(item.x);
    const y = Number(item.y);
    const boxWidth = Number(item.width);
    const boxHeight = Number(item.height);

    if (![x, y, boxWidth, boxHeight].every(Number.isFinite)) return;

    const left = Math.max(0, x - boxWidth / 2);
    const top = Math.max(0, y - boxHeight / 2);
    const right = Math.min(width, x + boxWidth / 2);
    const bottom = Math.min(height, y + boxHeight / 2);

    if (right <= left || bottom <= top) return;

    const info = getClassInfo(item.class);
    const confidence = Math.max(
      0,
      Math.min(1, Number(item.confidence) || 0)
    );

    const fontSize = Math.max(12, Math.round(width / 42));
    const label = `${info.label} ${(confidence * 100).toFixed(1)}%`;

    context.strokeStyle = info.color;
    context.lineWidth = Math.max(2, width / 320);
    context.strokeRect(left, top, right - left, bottom - top);

    context.font = `600 ${fontSize}px Arial`;
    const labelWidth = context.measureText(label).width + 14;
    const labelHeight = fontSize + 10;
    const labelTop = Math.max(0, top - labelHeight);

    context.fillStyle = info.color;
    context.fillRect(
      left,
      labelTop,
      Math.min(width - left, labelWidth),
      labelHeight
    );

    context.fillStyle = "#07111b";
    context.fillText(label, left + 7, labelTop + fontSize + 1);
  });
}

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const runningRef = useRef(false);
  const busyRef = useRef(false);
  const sessionRef = useRef(0);

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const [detections, setDetections] = useState([]);
  const [status, setStatus] = useState("Camera stopped");
  const [error, setError] = useState("");
  const [lastDetection, setLastDetection] = useState(null);
  const [totalScans, setTotalScans] = useState(0);
  const [sensorData, setSensorData] = useState(null);
  const [sensorConnected, setSensorConnected] = useState(false);
  const [sensorError, setSensorError] = useState("");
  const [spoilageAlert, setSpoilageAlert] = useState({
    active: false,
    configured: false,
    confidenceThreshold: 0.7,
    feed: "spoilage-alert",
    publishError: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function checkBackend() {
      try {
        const response = await fetch(`${API_URL}/api/health`);
        const data = await response.json();

        if (!response.ok) throw new Error("Backend unavailable");

        if (!cancelled) {
          setBackendReady(true);

          if (data.apiKeyConfigured === false) {
            setError("The backend is running, but its Roboflow API key is missing.");
          }
        }
      } catch {
        if (!cancelled) setBackendReady(false);
      }
    }

    checkBackend();
    const timer = setInterval(checkBackend, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSensorData() {
      try {
        const response = await fetch(`${API_URL}/api/sensors`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load sensor data.");

        const result = await response.json();
        if (cancelled) return;

        setSensorData(result.data || null);
        setSensorConnected(Boolean(result.connected));
        setSensorError(result.error || "");
      } catch (err) {
        if (!cancelled) {
          setSensorConnected(false);
          setSensorError(err.message || "Sensor endpoint is unavailable.");
        }
      }
    }

    loadSensorData();
    // Adafruit IO is cached by the backend; poll the dashboard without hammering the cloud API.
    const timer = setInterval(loadSensorData, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSpoilageAlert() {
      try {
        const response = await fetch(`${API_URL}/api/alerts`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load spoilage alert status.");
        const result = await response.json();
        if (!cancelled) setSpoilageAlert(result);
      } catch (err) {
        if (!cancelled) {
          setSpoilageAlert((current) => ({
            ...current,
            configured: false,
            publishError: err.message || "Alert status endpoint is unavailable.",
          }));
        }
      }
    }

    loadSpoilageAlert();
    const timer = setInterval(loadSpoilageAlert, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    sessionRef.current += 1;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (videoRef.current) videoRef.current.srcObject = null;

    setCameraOn(false);
    setCameraReady(false);
    setStatus("Camera stopped");
  }, []);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      sessionRef.current += 1;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function startCamera() {
    if (!backendReady) {
      setError("Start the Node.js backend before starting detection.");
      return;
    }

    setError("");
    setDetections([]);
    setStatus("Requesting camera permission...");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "environment",
        },
        audio: false,
      });

      streamRef.current = stream;

      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        return;
      }

      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      sessionRef.current += 1;
      runningRef.current = true;
      setCameraOn(true);
      setCameraReady(true);
      setStatus("Camera active. Analyzing frames...");
    } catch (err) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setCameraOn(false);
      setCameraReady(false);
      setStatus("Camera unavailable");
      setError(
        err.name === "NotAllowedError"
          ? "Camera permission was denied. Allow access in your browser settings."
          : `Could not start camera: ${err.message}`
      );
    }
  }

  useEffect(() => {
    if (!cameraOn || !cameraReady) return;

    let cancelled = false;
    let timeoutId;
    const session = sessionRef.current;

    async function detectFrame() {
      if (
        cancelled ||
        !runningRef.current ||
        session !== sessionRef.current
      ) return;

      if (busyRef.current) {
        timeoutId = setTimeout(detectFrame, 200);
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas || video.readyState < 2 || !video.videoWidth) {
        timeoutId = setTimeout(detectFrame, 200);
        return;
      }

      busyRef.current = true;

      try {
        const scale = Math.min(1, 640 / video.videoWidth);
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);

        canvas.width = width;
        canvas.height = height;

        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0, width, height);

        const frameData = canvas.toDataURL("image/jpeg", 0.75);

        const response = await fetch(`${API_URL}/api/detect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: frameData }),
        });

        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Detection failed");

        if (cancelled || session !== sessionRef.current) return;

        const items = Array.isArray(result.predictions)
          ? result.predictions
          : [];

        const capturedImage = new Image();
        await new Promise((resolve, reject) => {
          capturedImage.onload = resolve;
          capturedImage.onerror = reject;
          capturedImage.src = frameData;
        });

        if (cancelled || session !== sessionRef.current) return;

        drawDetections(canvas, capturedImage, items);
        setDetections(items);
        if (result.spoilageAlert) setSpoilageAlert(result.spoilageAlert);
        setLastDetection(new Date());
        setTotalScans((count) => count + 1);
        setStatus(items.length ? `${items.length} detection(s) found` : "No fruit detected");
        setError("");

      } catch (err) {
        if (!cancelled && session === sessionRef.current) {
          setError(err.message);
          setStatus("Detection request failed");
        }
      } finally {
        busyRef.current = false;

        if (!cancelled && runningRef.current && session === sessionRef.current) {
          timeoutId = setTimeout(detectFrame, 1500);
        }
      }
    }

    detectFrame();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [cameraOn, cameraReady]);

  const detectedClasses = [
    ...new Set(detections.map((item) => item.class || "unknown")),
  ];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">🍎</div>
          <div>
            <h1>FruitFresh <span>AI</span></h1>
            <p>Intelligent fruit condition monitoring</p>
          </div>
        </div>

        <div className="header-status">
          <span className={`status-dot ${backendReady ? "online" : ""}`} />
          {backendReady ? "Backend connected" : "Backend disconnected"}
        </div>
      </header>

      <section className="stats-grid">
        <article className="stat-card">
          <span className="stat-icon"><Camera size={19} /></span>
          <span className="stat-label">Camera</span>
          <strong>{cameraOn ? "Active" : "Stopped"}</strong>
          <small>{cameraOn ? "Analyzing frames" : "Waiting to start"}</small>
        </article>

        <article className="stat-card">
          <span className="stat-icon"><Activity size={19} /></span>
          <span className="stat-label">Frame analyses</span>
          <strong>{totalScans}</strong>
          <small>This session</small>
        </article>

        <article className="stat-card">
          <span className="stat-icon"><ScanLine size={19} /></span>
          <span className="stat-label">Current detections</span>
          <strong>{detections.length}</strong>
          <small>{detections.length === 1 ? "Fruit in current frame" : "Fruits in current frame"}</small>
        </article>
      </section>

      <section className={`spoilage-alert-strip ${spoilageAlert.active ? "is-active" : ""} ${!spoilageAlert.configured ? "is-unconfigured" : ""}`} aria-live="polite">
        <div className="spoilage-alert-symbol">
          {spoilageAlert.active ? <CircleAlert size={21} /> : <CheckCircle2 size={21} />}
        </div>
        <div className="spoilage-alert-copy">
          <span className="spoilage-alert-eyebrow">AI SPOILAGE INDICATOR</span>
          <strong>
            {spoilageAlert.active
              ? "Potential spoilage detected"
              : spoilageAlert.configured
                ? "No active spoilage alert"
                : "Cloud alert feed not configured"}
          </strong>
          <p>
            {spoilageAlert.active
              ? (spoilageAlert.publishError
                ? `Model confidence ${Math.round(Number(spoilageAlert.triggerConfidence || 0) * 100)}%. Cloud delivery error: ${spoilageAlert.publishError}`
                : spoilageAlert.published === true
                  ? `Model confidence ${Math.round(Number(spoilageAlert.triggerConfidence || 0) * 100)}%. Alert published to Adafruit IO; the ESP8266 should activate the red LED and buzzer.`
                  : `Model confidence ${Math.round(Number(spoilageAlert.triggerConfidence || 0) * 100)}%. Waiting for Adafruit IO alert publication.`)
              : spoilageAlert.configured
                ? (spoilageAlert.publishError || `Alert starts at ${Math.round(Number(spoilageAlert.confidenceThreshold || 0.7) * 100)}% confidence for ${spoilageAlert.requiredTriggerFrames || 2} consecutive frames, and clears after ${spoilageAlert.requiredClearFrames || 3} clear frames.`)
                : (spoilageAlert.publishError || "Create the Adafruit IO feed named spoilage-alert and configure AIO_SPOILAGE_FEED on the backend.")}
          </p>
        </div>
        <span className="spoilage-alert-status">
          {spoilageAlert.active ? "ALERT ACTIVE" : !spoilageAlert.configured ? "NOT READY" : spoilageAlert.publishError ? "CLOUD ERROR" : "SYSTEM ARMED"}
        </span>
      </section>

      <section className="workspace-grid">
      <aside className="panel sensor-panel">
        <div className="panel-heading">
          <div>
            <h3>Environmental sensor</h3>
            <p>Adafruit IO cloud · ESP8266 ESP-12E · DHT22 + MQ-135</p>
          </div>
          <span className={`live-badge ${sensorConnected ? "is-live" : ""}`}>
            <span /> {sensorConnected ? "DEVICE ONLINE" : "WAITING FOR DEVICE"}
          </span>
        </div>

        <div className="sensor-metrics">
          <article className="sensor-metric">
            <span className="sensor-metric-icon"><Thermometer size={20} /></span>
            <div>
              <span className="stat-label">Temperature</span>
              <strong>{sensorData ? `${Number(sensorData.temperature).toFixed(1)} °C` : "-- °C"}</strong>
              <small>Ambient temperature</small>
            </div>
          </article>
          <article className="sensor-metric">
            <span className="sensor-metric-icon humidity-icon"><Droplets size={20} /></span>
            <div>
              <span className="stat-label">Humidity</span>
              <strong>{sensorData ? `${Number(sensorData.humidity).toFixed(1)} %` : "-- %"}</strong>
              <small>Relative humidity</small>
            </div>
          </article>
          <article className="sensor-metric">
            <span className="sensor-metric-icon gas-icon"><Activity size={20} /></span>
            <div>
              <span className="stat-label">MQ-135 signal</span>
              <strong>{sensorData && sensorData.mq135Raw !== null && sensorData.mq135Raw !== undefined && Number.isFinite(Number(sensorData.mq135Raw)) ? `${Math.round(Number(sensorData.mq135Raw))} / 1023` : "-- / 1023"}</strong>
              <small>Raw ADC value · not ppm</small>
            </div>
          </article>
        </div>

        <div className="sensor-footer">
          {sensorConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>
            {sensorError
              ? sensorError
              : sensorConnected && sensorData
                ? `Cloud sample from ${new Date(sensorData.receivedAt).toLocaleTimeString()} · ${sensorData.source || "Adafruit IO"}`
                : sensorData
                  ? `Last reading ${new Date(sensorData.receivedAt).toLocaleTimeString()}; waiting for new data.`
                  : "Waiting for Adafruit IO readings. Check the ESP8266 MQTT connection and the temperature, humidity, and mq135 feeds."}
          </span>
        </div>
      </aside>

      <div className="vision-column">
      <section className="main-grid">
        <article className="panel camera-panel">
          <div className="panel-heading">
            <div>
              <h3>Live detection view</h3>
              <p>Bounding boxes match the analyzed frame.</p>
            </div>
            <span className={`live-badge ${cameraOn ? "is-live" : ""}`}>
              <span /> {cameraOn ? "LIVE" : "STANDBY"}
            </span>
          </div>

          <div className="video-frame">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="camera-source"
            />

            <canvas
              ref={canvasRef}
              className={`detection-canvas ${cameraReady ? "visible" : ""}`}
            />

            {!cameraOn && (
              <div className="video-placeholder">
                <div className="placeholder-icon"><Camera size={22} /></div>
                <strong>Camera preview is off</strong>
                <p>Start the webcam to begin detection.</p>
              </div>
            )}
          </div>

          <div className="camera-footer">
            <div className="camera-status">
              <span className={`status-dot ${cameraOn ? "online" : ""}`} />
              <span>{status}</span>
            </div>

            {!cameraOn ? (
              <button
                className="button button-primary"
                onClick={startCamera}
                disabled={!backendReady}
              >
                <Camera size={18} /> Start webcam
              </button>
            ) : (
              <button className="button button-secondary" onClick={stopCamera}>
                <CameraOff size={18} /> Stop webcam
              </button>
            )}
          </div>

          {!backendReady && (
            <div className="inline-warning">
              <CircleAlert size={17} />
              Start the Node.js backend to enable detection.
            </div>
          )}

          {error && (
            <div className="error-message">
              <CircleAlert size={17} /> <span>{error}</span>
            </div>
          )}
        </article>

        <aside className="panel results-panel">
          <div className="panel-heading">
            <div>
              <h3>Detection results</h3>
              <p>Latest model predictions</p>
            </div>
            <ScanLine size={21} className="heading-icon" />
          </div>

          {detections.length === 0 ? (
            <div className="empty-results">
              <div className="empty-icon"><ScanLine size={28} /></div>
              <strong>No fruit detected yet</strong>
              <p>Position fruit clearly inside the camera view.</p>
            </div>
          ) : (
            <div className="detections-list">
              {detections.map((item, index) => {
                const info = getClassInfo(item.class);
                const confidence = Math.max(
                  0,
                  Math.min(100, Number(item.confidence || 0) * 100)
                );

                return (
                  <div className="detection-item" key={`${item.class}-${index}`}>
                    <div className="detection-top">
                      <div className="class-name">
                        <span
                          className="class-indicator"
                          style={{ backgroundColor: info.color }}
                        />
                        <strong>{info.label}</strong>
                      </div>
                      <strong className="confidence">{confidence.toFixed(1)}%</strong>
                    </div>
                    <div className="confidence-track">
                      <div
                        className="confidence-fill"
                        style={{
                          width: `${confidence}%`,
                          backgroundColor: info.color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="result-summary">
            <span>Classes detected</span>
            <div className="class-tags">
              {detectedClasses.length
                ? detectedClasses.map((name) => (
                    <span key={name}>{getClassInfo(name).label}</span>
                  ))
                : <span>Waiting for results</span>}
            </div>
          </div>

          <div className="last-updated">
            <CheckCircle2 size={16} />
            <span>
              {lastDetection
                ? `Last analyzed ${lastDetection.toLocaleTimeString()}`
                : "No completed analysis yet"}
            </span>
          </div>
        </aside>
      </section>
      </div>
      </section>

      <section className="notice">
        <ShieldAlert size={19} />
        <div>
          <strong>Model limitations</strong>
          <p>
            Predictions describe visual classes learned by the model. They
            cannot confirm internal fruit quality or food safety.
          </p>
        </div>
      </section>

      <footer className="footer">
        <span>FruitFresh AI</span>
        <span>AI vision · Adafruit IO telemetry · FruitFresh-AI</span>
      </footer>
    </main>
  );
}

export default App;
