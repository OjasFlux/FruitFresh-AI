#include <ESP8266WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_MQTT.h>
#include <Adafruit_MQTT_Client.h>
#include "secrets.h"  // Copy secrets.example.h to secrets.h and enter credentials locally.

// ============================================================
// FruitFresh-AI: ESP8266 ESP-12E + DHT22 + MQ-135 + I2C LCD
// Publishes temperature, humidity, and MQ-135 raw ADC to Adafruit IO.
// Assumes a common 16x2 I2C LCD backpack at address 0x27.
// ============================================================

// Credentials live in the ignored local secrets.h file, not in this source file.
#define AIO_SERVER   "io.adafruit.com"
#define AIO_SERVERPORT 8883
#define AIO_SPOILAGE_FEED "spoilage-alert"

// -------- DHT22 module --------
#define DHT_PIN D4
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

// -------- MQ-135 analog output --------
// AO MUST use the external voltage divider described in the wiring notes.
#define MQ135_PIN A0

// -------- I2C LCD --------
// NodeMCU ESP-12E: SDA = D2 / GPIO4, SCL = D1 / GPIO5
#define LCD_SDA D2
#define LCD_SCL D1
#define LCD_ADDRESS 0x27       // Try 0x3F if your LCD has a different address
#define LCD_COLUMNS 16
#define LCD_ROWS 2
LiquidCrystal_I2C lcd(LCD_ADDRESS, LCD_COLUMNS, LCD_ROWS);

// -------- Spoilage-alert outputs --------
// Use external LEDs with series resistors. Use a transistor/driver for a
// buzzer that draws more current than a GPIO pin can safely supply.
#define GREEN_LED_PIN D7      // GPIO13
#define RED_LED_PIN D5        // GPIO14
#define BUZZER_PIN D6         // GPIO12; expects active-HIGH buzzer driver/module
const unsigned long BUZZER_REPEAT_MS = 2500;
const unsigned long BUZZER_ON_MS = 180;
bool alertStateKnown = false;
bool spoilageAlertActive = false;
unsigned long alertBuzzerCycleStart = 0;

// -------- Adafruit IO MQTT (TLS) --------
WiFiClientSecure secureClient;
Adafruit_MQTT_Client mqtt(
  &secureClient,
  AIO_SERVER,
  AIO_SERVERPORT,
  AIO_USERNAME,
  AIO_KEY
);

// Create Adafruit IO feeds with these exact keys: temperature, humidity, mq135.
Adafruit_MQTT_Publish temperatureFeed(&mqtt, AIO_USERNAME "/feeds/temperature");
Adafruit_MQTT_Publish humidityFeed(&mqtt, AIO_USERNAME "/feeds/humidity");
Adafruit_MQTT_Publish mq135Feed(&mqtt, AIO_USERNAME "/feeds/mq135");
Adafruit_MQTT_Subscribe spoilageAlertSubscription(&mqtt, AIO_USERNAME "/feeds/" AIO_SPOILAGE_FEED);
Adafruit_MQTT_Publish spoilageAlertGet(&mqtt, AIO_USERNAME "/feeds/" AIO_SPOILAGE_FEED "/get");

const unsigned long PUBLISH_INTERVAL_MS = 15000;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;
const unsigned long MQTT_RETRY_INTERVAL_MS = 15000;
const unsigned long LCD_PAGE_INTERVAL_MS = 3000;

unsigned long lastPublishAt = 0;
unsigned long lastWifiRetryAt = 0;
unsigned long lastMqttAttemptAt = 0;
unsigned long lastLCDPageAt = 0;

float latestTemperature = NAN;
float latestHumidity = NAN;
int latestMqRaw = 0;
bool hasValidReadings = false;
bool lastPublishOK = false;
uint8_t lcdPage = 0;

// Print a clean, padded line to the 16x2 LCD.
void printLCDLine(uint8_t row, const String& text) {
  lcd.setCursor(0, row);
  String line = text;
  if (line.length() > LCD_COLUMNS) {
    line = line.substring(0, LCD_COLUMNS);
  }
  lcd.print(line);
  for (int i = line.length(); i < LCD_COLUMNS; i++) {
    lcd.print(' ');
  }
}

// Status display: line 1 and line 2 are shown; line3 is used if line2 is empty.
void showMessage(const String& line1, const String& line2, const String& line3) {
  printLCDLine(0, line1);
  String bottom = line2.length() > 0 ? line2 : line3;
  printLCDLine(1, bottom);
}

void renderReadingsPage() {
  if (!hasValidReadings) return;

  if (lcdPage == 0) {
    printLCDLine(0, "Temp: " + String(latestTemperature, 1) + " C");
    printLCDLine(1, "Humidity: " + String(latestHumidity, 1) + "%");
  } else if (lcdPage == 1) {
    printLCDLine(0, "MQ135 raw:" + String(latestMqRaw));
    printLCDLine(1, lastPublishOK ? "Cloud: PUBLISHED" : "Cloud: NOT SENT");
  } else {
    printLCDLine(0, "SPOILAGE ALERT");
    if (!alertStateKnown) printLCDLine(1, "Alert: waiting");
    else printLCDLine(1, spoilageAlertActive ? "ALERT: ROT" : "Status: no alert");
  }
}

void setAlertOutputs() {
  if (!alertStateKnown) {
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    return;
  }

  if (spoilageAlertActive) {
    digitalWrite(GREEN_LED_PIN, LOW);
    digitalWrite(RED_LED_PIN, HIGH);
    const unsigned long phase = (millis() - alertBuzzerCycleStart) % BUZZER_REPEAT_MS;
    digitalWrite(BUZZER_PIN, phase < BUZZER_ON_MS ? HIGH : LOW);
  } else {
    digitalWrite(RED_LED_PIN, LOW);
    digitalWrite(BUZZER_PIN, LOW);
    // Green means the device has a known-clear alert state AND a live cloud link.
    digitalWrite(GREEN_LED_PIN,
      (WiFi.status() == WL_CONNECTED && mqtt.connected()) ? HIGH : LOW);
  }
}

void handleSpoilageAlertPayload(const char* payload) {
  String value(payload ? payload : "");
  value.trim();
  value.replace("\"", "");
  value.toLowerCase();

  if (value == "1" || value == "true" || value == "active" || value == "on") {
    spoilageAlertActive = true;
    alertStateKnown = true;
    alertBuzzerCycleStart = millis();
    Serial.println("SPOILAGE ALERT ACTIVE: red LED on; buzzer pulses.");
  } else if (value == "0" || value == "false" || value == "clear" || value == "off") {
    spoilageAlertActive = false;
    alertStateKnown = true;
    Serial.println("Spoilage alert clear: green LED on.");
  } else {
    Serial.print("Unrecognized spoilage-alert payload: ");
    Serial.println(value);
    return;
  }

  setAlertOutputs();
  if (hasValidReadings) renderReadingsPage();
}

void processMqttSubscriptions() {
  Adafruit_MQTT_Subscribe* subscription;
  // Short timeout avoids blocking sensor sampling while still processing cloud messages.
  while ((subscription = mqtt.readSubscription(10))) {
    if (subscription == &spoilageAlertSubscription) {
      Serial.print("Received spoilage-alert payload: ");
      Serial.println((char*)spoilageAlertSubscription.lastread);
      handleSpoilageAlertPayload((char*)spoilageAlertSubscription.lastread);
    }
  }
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  showMessage("Connecting Wi-Fi", "Please wait...", "");

  const unsigned long startAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAt < 20000) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi connected.");
    Serial.print("ESP8266 IP: ");
    Serial.println(WiFi.localIP());
    showMessage("Wi-Fi connected", WiFi.localIP().toString(), "Adafruit IO next");
  } else {
    Serial.println("Wi-Fi timed out. Check SSID/password and 2.4 GHz Wi-Fi.");
    showMessage("Wi-Fi failed", "Check credentials", "Retrying...");
  }
}

bool connectAdafruitIO() {
  if (mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;
  if (millis() - lastMqttAttemptAt < MQTT_RETRY_INTERVAL_MS) return false;

  lastMqttAttemptAt = millis();
  Serial.println("Connecting to Adafruit IO MQTT (TLS)...");
  const int8_t result = mqtt.connect();
  if (result != 0) {
    Serial.print("Adafruit IO MQTT connection failed: ");
    Serial.println(mqtt.connectErrorString(result));
    mqtt.disconnect();
    showMessage("Adafruit IO fail", "Check user/key", "Retrying soon");
    return false;
  }

  Serial.println("Adafruit IO MQTT connected.");
  delay(100);
  // Adafruit IO does not retain MQTT messages like a generic retained topic.
  // Request the latest feed value with the required one-byte NUL payload.
  // The subscription must already have been registered BEFORE mqtt.connect().
  const uint8_t getPayload[1] = { 0 };
  const bool requestedState = spoilageAlertGet.publish((uint8_t*)getPayload, sizeof(getPayload));
  Serial.print("Requested latest spoilage-alert state: ");
  Serial.println(requestedState ? "OK" : "FAILED");
  showMessage("Cloud connected", "Alert feed ready", "Publishing sensors");
  return true;
}

void maintainConnections() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiRetryAt >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiRetryAt = millis();
      Serial.println("Wi-Fi disconnected; reconnecting...");
      WiFi.reconnect();
    }
    return;
  }

  if (!mqtt.connected()) {
    connectAdafruitIO();
  } else {
    processMqttSubscriptions();
  }
  setAlertOutputs();
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("FruitFresh-AI: ESP8266 + DHT22 + MQ-135 + I2C LCD -> Adafruit IO");

  // I2C pins on NodeMCU ESP-12E: SDA=D2, SCL=D1.
  Wire.begin(LCD_SDA, LCD_SCL);
  Wire.setClock(100000);

  lcd.init();
  lcd.backlight();
  lcd.clear();
  showMessage("FruitFresh-AI", "Starting...", "");

  dht.begin();
  pinMode(MQ135_PIN, INPUT);

  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  // Prototype-only: TLS encryption is used, but server certificates are not validated.
  // Before a serious/public deployment, replace setInsecure() with certificate validation.
  secureClient.setInsecure();
  secureClient.setTimeout(8);

  // CRITICAL: Adafruit_MQTT requires subscriptions to be registered BEFORE connect().
  // Calling mqtt.subscribe() after mqtt.connect() leaves the alert feed unsubscribed.
  if (mqtt.subscribe(&spoilageAlertSubscription)) {
    Serial.println("Spoilage-alert subscription registered before MQTT connect.");
  } else {
    Serial.println("ERROR: Could not register spoilage-alert subscription.");
  }

  Serial.println("MQ-135 uses A0 through an external voltage divider.");
  Serial.println("Green LED: D7; Red LED: D5; buzzer driver: D6.");
  Serial.println("Create Adafruit IO feed key 'spoilage-alert' for cloud control.");
  Serial.println("MQ-135 raw ADC is 0..1023, not calibrated ppm.");
  Serial.println("Allow the MQ-135 to warm up; initial readings drift.");
  Serial.println("If LCD is blank, verify wiring and try I2C address 0x3F instead of 0x27.");

  connectWiFi();
  lastPublishAt = millis() - PUBLISH_INTERVAL_MS;
  lastMqttAttemptAt = millis() - MQTT_RETRY_INTERVAL_MS;
}

void loop() {
  maintainConnections();

  // Rotate 16x2 LCD pages so all readings/status remain readable.
  if (hasValidReadings && millis() - lastLCDPageAt >= LCD_PAGE_INTERVAL_MS) {
    lastLCDPageAt = millis();
    lcdPage = (lcdPage + 1) % 3;
    renderReadingsPage();
  }

  if (millis() - lastPublishAt < PUBLISH_INTERVAL_MS) {
    setAlertOutputs();
    delay(10);
    return;
  }
  lastPublishAt = millis();

  const float humidity = dht.readHumidity();
  const float temperature = dht.readTemperature();
  const int mqRaw = analogRead(MQ135_PIN); // ESP8266 ADC range 0..1023

  Serial.println("------------------------------");
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("DHT22 reading failed; check VCC=3V3, DATA=D4, GND=GND.");
    showMessage("DHT22 read error", "Check sensor pins", "DATA: D4");
    return;
  }

  latestTemperature = temperature;
  latestHumidity = humidity;
  latestMqRaw = mqRaw;
  hasValidReadings = true;
  lcdPage = 0;
  lastLCDPageAt = millis();

  Serial.print("Temperature: "); Serial.print(temperature, 1); Serial.println(" C");
  Serial.print("Humidity: "); Serial.print(humidity, 1); Serial.println(" %");
  Serial.print("MQ-135 raw ADC: "); Serial.println(mqRaw);

  bool published = false;
  if (connectAdafruitIO()) {
    const bool tempOK = temperatureFeed.publish(temperature, 2);
    delay(200);
    const bool humidityOK = humidityFeed.publish(humidity, 2);
    delay(200);
    const bool mqOK = mq135Feed.publish(mqRaw);
    published = tempOK && humidityOK && mqOK;

    Serial.print("Temperature feed publish: "); Serial.println(tempOK ? "OK" : "FAILED");
    Serial.print("Humidity feed publish: "); Serial.println(humidityOK ? "OK" : "FAILED");
    Serial.print("MQ-135 feed publish: "); Serial.println(mqOK ? "OK" : "FAILED");
  } else {
    Serial.println("Adafruit IO not connected; values were not published.");
  }

  lastPublishOK = published;
  renderReadingsPage();
}
