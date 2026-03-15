import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import axios from "axios";
import pLimit from "p-limit";
import { chromium, request as playwrightRequest } from "playwright";

const BASE_URL = "https://www.copart.com";
const OUTPUT_DIR = path.resolve("output");
const OUTPUT_FILE = process.env.OUTPUT_FILE
  ? path.resolve(process.env.OUTPUT_FILE)
  : path.join(OUTPUT_DIR, "copart_cars.json");


const TARGET_LOTS = Number(process.env.TARGET_LOTS || 5000); // 5000
const CONCURRENCY = Number(process.env.CONCURRENCY || 15);
const IMAGES_CONCURRENCY = Number(process.env.IMAGES_CONCURRENCY || 2);
const SEARCH_PAGE_SIZE = Number(process.env.SEARCH_PAGE_SIZE || 100);
const SEARCH_MAX_PAGES = Number(process.env.SEARCH_MAX_PAGES || 300);
const SEARCH_STALL_PAGES = Number(process.env.SEARCH_STALL_PAGES || 12);
const HEADLESS = process.env.HEADLESS === "true";
const SESSION_WAIT_MS = Number(process.env.SESSION_WAIT_MS || 15000);
// Copart search URL with filters. The browser navigates here to capture the filtered API request.
// SEARCH_TERMS iteration is skipped — filters from the URL are used instead.
const SEARCH_URL = process.env.SEARCH_URL ||
  "https://www.copart.com/lotSearchResults?free=false&displayStr=AUTOMOBILE,%5B0%20TO%2034800%5D,%5B2016%20TO%202027%5D&from=%2FvehicleFinder&fromSource=widget&qId=29c7ea24-cf30-4916-bf49-5f4a83ecc29e-1773432519447&searchCriteria=%7B%22query%22:%5B%22*%22%5D,%22filter%22:%7B%22VEHT%22:%5B%22vehicle_type_code:VEHTYPE_V%22%5D,%22TITL%22:%5B%22title_group_code:TITLEGROUP_C%22,%22title_group_code:TITLEGROUP_S%22%5D,%22PRID%22:%5B%22damage_type_code:DAMAGECODE_FR%22,%22damage_type_code:DAMAGECODE_HL%22,%22damage_type_code:DAMAGECODE_MC%22,%22damage_type_code:DAMAGECODE_MN%22,%22damage_type_code:DAMAGECODE_NW%22,%22damage_type_code:DAMAGECODE_RR%22,%22damage_type_code:DAMAGECODE_RO%22,%22damage_type_code:DAMAGECODE_SD%22,%22damage_type_code:DAMAGECODE_ST%22,%22damage_type_code:DAMAGECODE_TP%22,%22damage_type_code:DAMAGECODE_UN%22,%22damage_type_code:DAMAGECODE_VN%22%5D,%22ODM%22:%5B%22odometer_reading_received:%5B0%20TO%2092100%5D%22%5D,%22YEAR%22:%5B%22lot_year:%5B2010%20TO%202026%5D%22%5D%7D,%22searchName%22:%22%22,%22watchListOnly%22:false,%22freeFormSearch%22:false%7D";
const SEARCH_TERMS = (process.env.SEARCH_TERMS ||
  "toyota,honda,ford,chevrolet,nissan,bmw,mercedes,audi,hyundai,kia,lexus,jeep,dodge,subaru,volkswagen")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

async function waitForEnter(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${message}\nPress Enter to continue... `);
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function toCookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/[^\d.-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function sanitizeHeaders(headers = {}) {
  const blocked = new Set([
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "cookie",
  ]);

  const result = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (blocked.has(key)) continue;
    result[k] = v;
  }
  return result;
}

function findFirstKeyValue(root, keys) {
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const stack = [root];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    for (const [k, v] of Object.entries(cur)) {
      if (wanted.has(k.toLowerCase()) && v !== undefined && v !== null && v !== "") {
        return v;
      }
      if (v && typeof v === "object") stack.push(v);
    }
  }

  return null;
}

// Global cache: lotNumber (string) -> full lot object from search results
const lotDataCache = new Map();

function collectLotNumbersFromAny(root) {
  const lotNumbers = new Set();
  const stack = [root];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (typeof cur !== "object") continue;

    for (const [k, v] of Object.entries(cur)) {
      const key = k.toLowerCase();

      if (
        (key.includes("lotnumber") || key === "lot" || key === "lot_number") &&
        (typeof v === "string" || typeof v === "number")
      ) {
        const lot = String(v).replace(/\D/g, "");
        if (lot.length >= 6) lotNumbers.add(lot);
      }

      if (typeof v === "string") {
        const m = v.match(/\/lot\/(\d{6,})/i);
        if (m) lotNumbers.add(m[1]);
      }

      if (v && typeof v === "object") stack.push(v);
    }
  }

  return lotNumbers;
}

// Extract full lot objects from search response and populate lotDataCache
function cacheLotObjectsFromResponse(root) {
  const LOT_FIELDS = new Set([
    "year", "make", "vin", "color", "transmission", "drive", "fuel",
    // Copart abbreviated field names
    "lcy", "mkn", "lm", "clr", "tsmn", "drv", "ft", "fv", "mv",
  ]);
  const stack = [root];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
      if (Array.isArray(cur)) for (const item of cur) stack.push(item);
      continue;
    }

    const lotNum =
      cur.lot_number ?? cur.lotNumber ?? cur.lotNum ?? cur.ln ?? null;
    if (lotNum) {
      const lot = String(lotNum).replace(/\D/g, "");
      if (lot.length >= 6) {
        // Only cache if this object has real vehicle data (at least year or make)
        const hasVehicleData =
          Object.keys(cur).some((k) => LOT_FIELDS.has(k.toLowerCase())) ||
          cur.year || cur.make || cur.vin || cur.lcy || cur.mkn;
        if (hasVehicleData && !lotDataCache.has(lot)) {
          lotDataCache.set(lot, cur);
        }
      }
    }

    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
}

const IMAGE_CDN_RE = /cs\.copart\.com|c-static\.copart\.com|img\.copart\.com|copartmaui\.com|copart-cdn\.com|inventoryimages/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;
const API_ENDPOINT_RE = /inventoryv2\.copart\.io|\/v1\/lotImages\//i;

function isIncapsulaBlock(resp) {
  if (!resp) return false;
  if (typeof resp.data === "string" && resp.data.includes("Incapsula")) return true;
  if (typeof resp.data === "string" && resp.data.trim().startsWith("<html") && resp.data.includes("iframe")) return true;
  return false;
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return null;
}

// Extract the unique image hash (UUID) from a Copart image URL
function imageHash(url) {
  const m = url.match(/\/([0-9a-f]{20,})_(?:v?ful|v?hrs|v?thb)\./i);
  return m ? m[1] : null;
}

// Deduplicate images: one _ful URL per unique hash; fall back to any URL if hash not found
function deduplicateImagesByHash(urls) {
  const seen = new Map(); // hash → url
  const noHash = [];
  for (const url of urls) {
    const h = imageHash(url);
    if (!h) {
      noHash.push(url);
      continue;
    }
    if (seen.has(h)) {
      // Prefer _ful over _hrs
      const existing = seen.get(h);
      if (url.includes("_ful.") && !existing.includes("_ful.")) {
        seen.set(h, url);
      }
      continue;
    }
    seen.set(h, url);
  }
  return [...seen.values(), ...noHash];
}

function isActualImageUrl(url) {
  if (!url) return false;
  if (API_ENDPOINT_RE.test(url)) return false;
  return IMAGE_CDN_RE.test(url) || IMAGE_EXT_RE.test(url);
}

function extractImages(details) {
  const urls = new Set();

  const preferredRoots = [
    findFirstKeyValue(details, ["imagesList"]),
    findFirstKeyValue(details, ["imageList"]),
    findFirstKeyValue(details, ["images"]),
  ].filter(Boolean);

  // Always include top-level object so standalone imageUrl / thumbnail_image fields are found
  const stack = preferredRoots.length ? [...preferredRoots, details] : [details];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }

    if (typeof cur !== "object") continue;

    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string" && /(url|image|path)/i.test(k)) {
        const normalized = normalizeImageUrl(v);
        if (normalized && isActualImageUrl(normalized)) urls.add(normalized);
      }

      if (typeof v === "string") {
        const normalized = normalizeImageUrl(v);
        if (normalized && isActualImageUrl(normalized)) {
          urls.add(normalized);
        }
      }

      if (v && typeof v === "object") stack.push(v);
    }
  }

  return Array.from(urls);
}

function buildLocation(details) {
  const city = findFirstKeyValue(details, ["location_city", "locationCity", "city"]);
  const state = findFirstKeyValue(details, ["location_state", "locationState", "stateName", "state"]);
  if (city && state) {
    const zip = findFirstKeyValue(details, ["zip_code", "location_zip", "locationZip", "zip"]);
    const parts = [city, state, zip].filter(Boolean).map((x) => String(x).trim());
    return parts.join(", ");
  }

  const named = findFirstKeyValue(details, [
    "sale_name",
    "saleName",
    "yard_name",
    "yardName",
    "yn",           // Copart abbreviated: yard name
    "sale_location",
    "saleLocation",
    "locationDescription",
    "location",
  ]);
  if (typeof named === "string" && named.trim()) return named.trim();

  return null;
}

function mapLotDetails(rawDetails, lotNumber) {
  const lot = String(
    findFirstKeyValue(rawDetails, ["lotNumber", "lot_number"]) || lotNumber
  );

  const estimatedRetail = findFirstKeyValue(rawDetails, [
    "lotPlugAcv",   // Copart: Actual Cash Value (primary field)
    "estimated_retail_value",
    "est_retail_value",
    "estimatedRetailValue",
    "estRetailValue",
    "rcn",
    "actv",
    "cv",
    "lv",
    "ev",
    "pv",
    "retailValue",
    "estimatedValue",
    "actualValue",
    "cleanValue",
  ]);

  return {
    lot_number: lot,
    vin: findFirstKeyValue(rawDetails, ["vin", "fv", "mv", "maskedVin", "masked_vin"]) || null,
    year: toNumber(findFirstKeyValue(rawDetails, ["year", "lcy", "modelYear", "model_year"])),
    make: findFirstKeyValue(rawDetails, ["make", "mkn", "makeName", "make_name"]) || null,
    model: findFirstKeyValue(rawDetails, ["model_group", "modelGroup", "lm", "model", "modelName", "full_model_name"]) || null,
    trim: findFirstKeyValue(rawDetails, ["trim", "tmtp", "trimName", "trim_name"]) || null,
    body_style: findFirstKeyValue(rawDetails, ["bstl", "vty", "bodyStyle", "body_style", "vehicleStyle", "styleDesc"]) || null,
    engine: findFirstKeyValue(rawDetails, ["egn", "engine", "eng", "engineDesc", "engine_description", "engineDescription", "engineSize", "engine_size"]) || null,
    full_model_name:
      findFirstKeyValue(rawDetails, [
        "model_detail",
        "modelDetail",
        "fullModelName",
        "full_model_name",
        "ldu",          // Copart abbreviated: lot description / full title
        "titleDescription",
        "title_description",
      ]) || null,
    build_sheet: findFirstKeyValue(rawDetails, ["buildSheet", "build_sheet"]) || null,
    item_url: `${BASE_URL}/lot/${lot}`,
    color: findFirstKeyValue(rawDetails, ["color", "clr", "vehicleColor", "vehicle_color"]) || null,
    transmission: findFirstKeyValue(rawDetails, ["transmission", "tsmn", "transmissionType", "transmission_type"]) || null,
    drive: findFirstKeyValue(rawDetails, ["drive", "drv", "driveLine", "drivetrain", "drive_line"]) || null,
    fuel: findFirstKeyValue(rawDetails, ["fuel_type", "ft", "fuelType", "fuel"]) || null,
    buy_it_now_price: toNumber(findFirstKeyValue(rawDetails, ["buy_it_now_price", "bnp", "buyItNow", "buyItNowPrice"])),
    estimated_retail_value: toNumber(estimatedRetail),
    estimated_retail_value_formatted: toNumber(estimatedRetail) != null
      ? `$${Number(toNumber(estimatedRetail)).toLocaleString("en-US")}`
      : null,
    odometer: toNumber(findFirstKeyValue(rawDetails, ["odometer", "orr", "ord", "odometerReading", "odometer_reading"])),
    damage:
      findFirstKeyValue(rawDetails, ["damage_description", "dd", "damageDescription", "damage", "primaryDamage", "primary_damage"]) ||
      findFirstKeyValue(rawDetails, ["secondary_damage", "secondaryDamage"]) ||
      null,
    location: buildLocation(rawDetails),
    images: extractImages(rawDetails),
  };
}

function normalizeCarRecord(record) {
  return {
    lot_number: record?.lot_number ?? null,
    vin: record?.vin ?? null,
    year: record?.year ?? null,
    make: record?.make ?? null,
    model: record?.model ?? null,
    trim: record?.trim ?? null,
    body_style: record?.body_style ?? null,
    engine: record?.engine ?? null,
    full_model_name: record?.full_model_name ?? null,
    build_sheet: record?.build_sheet ?? null,
    item_url: record?.item_url ?? null,
    color: record?.color ?? null,
    transmission: record?.transmission ?? null,
    drive: record?.drive ?? null,
    fuel: record?.fuel ?? null,
    buy_it_now_price: record?.buy_it_now_price ?? null,
    estimated_retail_value: record?.estimated_retail_value ?? null,
    estimated_retail_value_formatted: record?.estimated_retail_value_formatted ?? null,
    odometer: record?.odometer ?? null,
    damage: record?.damage ?? null,
    location: record?.location ?? null,
    images: Array.isArray(record?.images) ? record.images : [],
  };
}

async function withRetry(fn, retries = 3, baseDelay = 700) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const waitMs = baseDelay * attempt + randomBetween(50, 250);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

function prepareSearchPayload(templateBody, start, page, size) {
  const body = templateBody ? deepClone(templateBody) : {};
  const patchNumericKeys = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) patchNumericKeys(item);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      if (["start", "offset", "from"].includes(lower)) {
        node[key] = start;
      } else if (["page", "pagenumber"].includes(lower)) {
        node[key] = page;
      } else if (["size", "limit", "rows", "pagesize"].includes(lower)) {
        node[key] = size;
      } else if (value && typeof value === "object") {
        patchNumericKeys(value);
      }
    }
  };

  patchNumericKeys(body);

  if (!body || Object.keys(body).length === 0) {
    return {
      query: ["*"],
      start,
      page,
      size,
    };
  }

  if (body.start == null) body.start = start;
  if (body.page == null) body.page = page;
  if (body.size == null) body.size = size;

  return body;
}

function buildPagedUrl(templateUrl, start, page, size) {
  const url = new URL(templateUrl);
  const update = (key, value) => {
    if (url.searchParams.has(key)) url.searchParams.set(key, String(value));
  };

  update("start", start);
  update("offset", start);
  update("from", start);
  update("page", page);
  update("pageNumber", page);
  update("size", size);
  update("rows", size);
  update("limit", size);

  return url.toString();
}

function isLikelyLotSearchApi(url, method = "GET") {
  if (!url || typeof url !== "string") return false;
  const lowerUrl = url.toLowerCase();
  const upperMethod = String(method).toUpperCase();

  if (!lowerUrl.includes("copart.com/public/")) return false;
  if (lowerUrl.includes("fetchdirective.html")) return false;
  if (lowerUrl.endsWith(".css") || lowerUrl.endsWith(".js") || lowerUrl.endsWith(".html")) {
    return false;
  }

  if (lowerUrl.includes("/public/lots/search")) return true;
  if (lowerUrl.includes("/search") && (upperMethod === "POST" || upperMethod === "GET")) {
    return true;
  }

  return false;
}

function applySearchTermToBody(baseBody, term) {
  if (!term) return baseBody || {};
  const body = deepClone(baseBody || {});
  let patched = false;

  const patchNode = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) patchNode(item);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      const lower = key.toLowerCase();
      const looksLikeSearchKey =
        lower.includes("query") ||
        lower.includes("search") ||
        lower.includes("keyword") ||
        lower.includes("freeform");

      if (looksLikeSearchKey) {
        if (typeof value === "string") {
          node[key] = term;
          patched = true;
          continue;
        }
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          node[key] = [term];
          patched = true;
          continue;
        }
      }

      if (value && typeof value === "object") patchNode(value);
    }
  };

  patchNode(body);

  if (!patched) {
    body.freeFormSearch = term;
    if (body.query == null) body.query = [term];
  }

  return body;
}

async function initCopartSession() {
  console.log("Opening Copart session...");

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  let capturedSearchRequest = null;
  let seedLots = [];
  let capturedSearchStatus = null;
  let capturedLotDetailsUrl = null;
  let capturedLotImagesUrl = null;
  let capturedLotImagesHeaders = null;

  page.on("request", (request) => {
    if (request.url().includes("/lotdetails/")) {
      capturedLotDetailsUrl = request.url();
    }
    const rUrl = request.url().toLowerCase();
    if (
      rUrl.includes("copart.com/public/") &&
      rUrl.includes("image") &&
      !rUrl.includes("/search") &&
      !rUrl.includes("search?") &&
      ["xhr", "fetch"].includes(request.resourceType())
    ) {
      if (!capturedLotImagesUrl) capturedLotImagesUrl = request.url();
      // Always capture the latest browser headers for the images API
      capturedLotImagesHeaders = sanitizeHeaders(request.headers());
    }

    if (!isLikelyLotSearchApi(request.url(), request.method())) return;
    if (!["xhr", "fetch"].includes(request.resourceType())) return;

    let body = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = null;
    }

    capturedSearchRequest = {
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body,
    };
  });

  page.on("response", async (response) => {
    if (response.url().includes("/lotdetails/")) {
      capturedLotDetailsUrl = response.url();
    }
    {
      const rUrl = response.url().toLowerCase();
      if (
        rUrl.includes("copart.com/public/") &&
        ["xhr", "fetch"].includes(response.request().resourceType())
      ) {
        try {
          const data = await response.json().catch(() => null);
          if (data) {
            // Detect response that contains actual lot image URLs
            const json = JSON.stringify(data);
            const hasImages = /ids-c-prod-lpp|_ful\.jpg|_thb\.jpg|_hrs\.jpg/.test(json);
            if (hasImages && !capturedLotImagesUrl) {
              capturedLotImagesUrl = response.url();
              console.log(`[session] Captured lot images URL from response body: ${capturedLotImagesUrl}`);
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (!isLikelyLotSearchApi(response.url(), response.request().method())) return;
    if (!["xhr", "fetch"].includes(response.request().resourceType())) return;

    let data = null;
    try {
      data = await response.json();
    } catch {
      return;
    }

    const found = Array.from(collectLotNumbersFromAny(data));
    if (found.length > seedLots.length || response.url().includes("/public/lots/search")) {
      seedLots = found;
      capturedSearchStatus = response.status();

      const req = response.request();
      let body = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }

      capturedSearchRequest = {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        body,
      };
    }
  });

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await sleep(5000);

  const startUrl = SEARCH_URL || `${BASE_URL}/vehicleFinder`;
  if (SEARCH_URL) {
    console.log(`Using custom search URL: ${SEARCH_URL.slice(0, 80)}...`);
  }
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  // lotSearchResults page auto-fires API requests — wait longer to ensure capture
  await sleep(SEARCH_URL ? 8000 : 5000);

  const safePageEvaluate = async (fn, fallback = null) => {
    for (let i = 0; i < 3; i += 1) {
      try {
        return await page.evaluate(fn);
      } catch (err) {
        const msg = String(err?.message || "");
        const transient =
          msg.includes("Execution context was destroyed") ||
          msg.includes("Cannot find context with specified id");
        if (!transient || i === 2) return fallback;
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await sleep(1000);
      }
    }
    return fallback;
  };

  // Trigger at least one real search request in browser traffic.
  await safePageEvaluate(() => {
    const byText = (selector, text) =>
      Array.from(document.querySelectorAll(selector)).find((el) =>
        (el.textContent || "").toLowerCase().includes(text)
      );

    const searchBtn =
      byText("button", "search") ||
      byText("[role='button']", "search") ||
      document.querySelector("button[type='submit']") ||
      document.querySelector("[data-uname*='search']");

    if (searchBtn) searchBtn.click();
    return true;
  });

  await sleep(2000);
  await page.keyboard.press("Enter").catch(() => {});
  await sleep(SESSION_WAIT_MS);

  if (!HEADLESS && !capturedSearchRequest) {
    console.log(
      "No search API captured yet. In opened browser: solve anti-bot (if shown), run any vehicle search, then return here."
    );
    await waitForEnter("After search results are visible in browser");
    await sleep(5000);
  }

  let capturedLotPageImages = [];
  const lotPageApiResponses = [];
  if (seedLots.length > 0) {
    // Capture all XHR/fetch responses from the lot page to identify the images endpoint
    const lotPageResponseHandler = async (response) => {
      if (!["xhr", "fetch"].includes(response.request().resourceType())) return;
      const url = response.url();
      if (!url.includes("copart.com")) return;
      try {
        const data = await response.json().catch(() => null);
        if (data && typeof data === "object") {
          const topKeys = Object.keys(data).slice(0, 10);
          const nestedKeys = data.data && typeof data.data === "object" ? Object.keys(data.data).slice(0, 10) : [];
          const allKeys = [...new Set([...topKeys, ...nestedKeys])];
          lotPageApiResponses.push({ url, status: response.status(), topKeys, allKeys });
        }
      } catch { /* ignore */ }
    };
    page.on("response", lotPageResponseHandler);

    await page.goto(`${BASE_URL}/lot/${seedLots[0]}`, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await sleep(4000);
    // Scroll to trigger lazy-loaded content (image gallery)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
    await sleep(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(2000);

    // Try to extract image URLs directly from the page JS state
    capturedLotPageImages = await safePageEvaluate(() => {
      const urls = new Set();
      // Try Vue/Nuxt store
      try {
        const app = document.querySelector("#app")?.__vue_app__ || document.querySelector("#__nuxt")?.__vue_app__;
        const store = app?.config?.globalProperties?.$store;
        if (store) {
          const state = store.state;
          const json = JSON.stringify(state);
          const matches = json.match(/https?:\/\/[^"]*(?:ids-c-prod-lpp|lpp|copart)[^"]*\.(?:jpg|png|webp)/gi) || [];
          matches.forEach((u) => urls.add(u));
        }
      } catch {}
      // Try window.__NUXT__
      try {
        if (window.__NUXT__) {
          const json = JSON.stringify(window.__NUXT__);
          const matches = json.match(/https?:\/\/[^"]*(?:ids-c-prod-lpp|lpp|copart)[^"]*\.(?:jpg|png|webp)/gi) || [];
          matches.forEach((u) => urls.add(u));
        }
      } catch {}
      // Try all img tags and background images
      try {
        document.querySelectorAll("img[src]").forEach((el) => {
          if (/copart/i.test(el.src)) urls.add(el.src);
        });
        document.querySelectorAll("[style]").forEach((el) => {
          const m = el.getAttribute("style")?.match(/url\(['"]?([^'"()]+copart[^'"()]+)['"]?\)/i);
          if (m) urls.add(m[1]);
        });
      } catch {}
      return Array.from(urls);
    }, []) || [];

    page.removeListener("response", lotPageResponseHandler);

    if (capturedLotPageImages.length > 0) {
      console.log(`[session] Extracted ${capturedLotPageImages.length} image URLs from lot page JS state`);
    }

    // Log all lot page API endpoints to help identify the images API
    if (lotPageApiResponses.length > 0) {
      console.log(`[session] Lot page API calls (${lotPageApiResponses.length}):`);
      for (const r of lotPageApiResponses) {
        console.log(`  ${r.status} ${r.url}  keys: ${r.topKeys.join(", ")}`);
      }
    }

    // Auto-detect images endpoint from lot page responses
    if (!capturedLotImagesUrl) {
      for (const r of lotPageApiResponses) {
        const allKeys = r.allKeys || r.topKeys;
        if (allKeys.some((k) => /image|photo/i.test(k)) || r.url.toLowerCase().includes("image")) {
          capturedLotImagesUrl = r.url;
          console.log(`[session] Auto-detected images endpoint: ${capturedLotImagesUrl}`);
          break;
        }
      }
    }
  }

  const cookies = await context.cookies();
  const storageState = await context.storageState();
  const userAgent =
    (await safePageEvaluate(() => navigator.userAgent, null)) ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const pageLotMatches =
    (await safePageEvaluate(() => {
    const html = document.documentElement?.outerHTML || "";
    const matches = html.match(/\/lot\/(\d{6,})/gi) || [];
    const lots = new Set(matches.map((m) => (m.match(/(\d{6,})/) || [])[1]).filter(Boolean));
    return Array.from(lots);
  }, [])) || [];

  await browser.close();

  if (capturedSearchRequest?.url) {
    console.log(
      `Captured search endpoint: ${capturedSearchRequest.method || "POST"} ${capturedSearchRequest.url} (seed lots: ${seedLots.length}, status: ${capturedSearchStatus ?? "n/a"})`
    );
  } else {
    console.warn("Could not capture search request from browser traffic.");
  }

  if (seedLots.length === 0 && pageLotMatches.length > 0) {
    seedLots = pageLotMatches;
    console.log(`Collected lot numbers: ${seedLots.length} (seed from page HTML)`);
  }

  if (capturedLotDetailsUrl) {
    console.log(`Captured lot details endpoint template: ${capturedLotDetailsUrl}`);
  }
  if (capturedLotImagesUrl) {
    console.log(`Captured lot images endpoint template: ${capturedLotImagesUrl}`);
  }

  return {
    cookies,
    storageState,
    userAgent,
    capturedSearchRequest,
    capturedLotDetailsUrl,
    capturedLotImagesUrl,
    capturedLotPageImages,
    capturedLotImagesHeaders,
    seedLots,
  };
}

async function collectLotNumbers(client, searchConfig, targetLots) {
  const lots = new Set(searchConfig?.seedLots || []);
  const searchCandidates = [
    searchConfig?.capturedSearchRequest?.url
      ? {
          url: searchConfig.capturedSearchRequest.url,
          method: (searchConfig.capturedSearchRequest.method || "POST").toUpperCase(),
          headers: searchConfig.capturedSearchRequest.headers || {},
          body: searchConfig.capturedSearchRequest.body || {},
        }
      : null,
    {
      url: `${BASE_URL}/public/lots/search`,
      method: "POST",
      headers: {},
      body: {},
    },
  ].filter(Boolean);

  const uniq = [];
  const seen = new Set();
  for (const candidate of searchCandidates) {
    const k = `${candidate.method}:${candidate.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(candidate);
  }

  if (lots.size > 0) {
    console.log(`Collected lot numbers: ${lots.size} (seed from browser response)`);
  }

  // Always iterate SEARCH_TERMS to bypass the 1000-result API cap; each term adds unique lots
  const plans = [null, ...SEARCH_TERMS];
  for (const term of plans) {
    if (lots.size >= targetLots) break;
    let stalledPages = 0;

    if (term) console.log(`Switching search term: ${term}`);

    for (let pageIndex = 0; pageIndex < SEARCH_MAX_PAGES && lots.size < targetLots; pageIndex += 1) {
      if (stalledPages >= SEARCH_STALL_PAGES) break;

      const start = pageIndex * SEARCH_PAGE_SIZE;
      const beforeCount = lots.size;
      let pageData = null;
      let lastErr = null;
      let lastStatus = null;

      for (const candidate of uniq) {
        try {
          const resp = await withRetry(
            () => {
              const headers = sanitizeHeaders(candidate.headers || {});
              if (candidate.method === "GET") {
                const url = buildPagedUrl(candidate.url, start, pageIndex, SEARCH_PAGE_SIZE);
                return client.get(url, { headers });
              }

              const termBodyTemplate = applySearchTermToBody(candidate.body || {}, term);
              const body = prepareSearchPayload(
                termBodyTemplate,
                start,
                pageIndex,
                SEARCH_PAGE_SIZE
              );
              return client.post(candidate.url, body, { headers });
            },
            2
          );
          lastStatus = resp.status;
          if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`HTTP ${resp.status}`);
          }
          pageData = resp.data;
          break;
        } catch (err) {
          lastErr = err;
        }
      }

      if (!pageData || typeof pageData === "string") {
        stalledPages += 1;
        console.warn(`Search page ${pageIndex} failed: ${lastErr?.message || "unknown error"}`);
        continue;
      }

      cacheLotObjectsFromResponse(pageData);
      const pageLots = collectLotNumbersFromAny(pageData);
      if (pageLots.size === 0 && pageIndex < 3) {
        const keys = Object.keys(pageData || {}).slice(0, 12).join(", ");
        console.warn(
          `Search page ${pageIndex} returned 0 lots (status: ${lastStatus ?? "n/a"}). Top-level keys: ${keys || "n/a"}`
        );
      }

      for (const lot of pageLots) {
        lots.add(lot);
        if (lots.size >= targetLots) break;
      }

      if (lots.size === beforeCount) {
        stalledPages += 1;
      } else {
        stalledPages = 0;
      }

      console.log(`Collected lot numbers: ${lots.size}`);
      await sleep(randomBetween(150, 450));
    }
  }

  return Array.from(lots).slice(0, targetLots);
}

function buildLotDetailsCandidates(lotNumber, capturedTemplateUrl) {
  const lot = String(lotNumber);
  const urls = [];

  if (capturedTemplateUrl && !capturedTemplateUrl.includes("lot-images")) {
    const fromTemplate = capturedTemplateUrl
      .replace(/\{LOT_NUMBER\}/gi, lot)
      .replace(/(\d{6,})/, lot);
    urls.push(fromTemplate);
  }

  urls.push(`${BASE_URL}/public/data/lotdetails/solr/lotNumber/${lot}`);
  urls.push(`${BASE_URL}/public/data/lotdetails/solr/lotNumbers/${lot}`);
  urls.push(`${BASE_URL}/public/data/lotdetails/lotNumber/${lot}`);
  urls.push(`${BASE_URL}/public/data/lotdetails/solr/${lot}`);
  urls.push(`${BASE_URL}/public/data/lotdetails/${lot}`);

  return unique(urls);
}

function extractImageUrlsFromList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((item) => {
      if (typeof item === "string") return [normalizeImageUrl(item)];
      if (!item || typeof item !== "object") return [];
      // Prefer fullUrl (Copart API field), then other known fields
      const specific = [
        item?.fullUrl, item?.fullImageUrl, item?.url, item?.imageUrl,
        item?.highResUrl, item?.highRes, item?.src, item?.imageLink,
        item?.imageSrc, item?.image, item?.photo, item?.link,
        item?.filePath, item?.imageFile,
      ].map(normalizeImageUrl).filter(Boolean);
      // If we found specific fields, use only those (avoids pulling thumbnails from generic scan)
      if (specific.length > 0) return specific;
      const any = Object.values(item)
        .filter((v) => typeof v === "string")
        .map(normalizeImageUrl)
        .filter((u) => u && isActualImageUrl(u));
      return any;
    })
    .filter((u) => u && isActualImageUrl(u));
}

function parseLotImagesResponse(data) {
  if (!data) return null;
  // Unwrap common envelope layers
  const candidates = [data, data?.data, data?.data?.data, data?.result, data?.response].filter(Boolean);
  for (const payload of candidates) {
    for (const key of ["imagesList", "images", "imageList", "lotImages", "photos", "imageUrls", "imgList", "pictureList"]) {
      const val = payload?.[key];
      if (!val) continue;
      // Handle { content: [...] } wrapper (Copart lotImages API returns imagesList.content)
      const list = Array.isArray(val) ? val : Array.isArray(val?.content) ? val.content : null;
      if (list && list.length > 0) {
        const urls = extractImageUrlsFromList(list);
        if (urls.length > 0) return urls;
      }
    }
    if (Array.isArray(payload) && payload.length > 0) {
      const urls = extractImageUrlsFromList(payload);
      if (urls.length > 0) return urls;
    }
  }
  // Last resort: scan all string values in the response for image URLs
  const allUrls = [];
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const v of Object.values(obj)) {
      if (typeof v === "string") {
        const u = normalizeImageUrl(v);
        if (u && isActualImageUrl(u)) allUrls.push(u);
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  };
  scan(data);
  return allUrls.length > 0 ? unique(allUrls) : null;
}

async function fetchLotImages(client, pwClient, lot, capturedLotImagesUrl, capturedLotImagesHeaders) {
  const patchCapturedUrl = (tmpl) => {
    if (!tmpl) return null;
    // Replace lot number if present
    let u = tmpl
      .replace(/\/lots\/\d+\//, `/lots/${lot}/`)
      .replace(/\/\d{6,}\/images/, `/${lot}/images`)
      .replace(/\/\d{6,}$/, `/${lot}`);
    // If URL ends with a slash or has no lot number, append it
    if (u === tmpl || u.endsWith("/")) u = u.replace(/\/?$/, `/${lot}`);
    return u;
  };

  const candidates = unique([
    patchCapturedUrl(capturedLotImagesUrl),
    // Variations of the lot-images endpoint (with and without /USA country suffix)
    `${BASE_URL}/public/data/lotdetails/solr/lot-images/${lot}/USA`,
    `${BASE_URL}/public/data/lotdetails/solr/lotImages/${lot}/USA`,
    `${BASE_URL}/public/data/lotdetails/solr/lot-images/${lot}`,
    `${BASE_URL}/public/data/lotdetails/solr/lotImages/${lot}`,
    `${BASE_URL}/public/data/lotdetails/solr/lotNumber/${lot}/images`,
    `${BASE_URL}/public/data/lotdetails/solr/lot-images?lotNumber=${lot}`,
    `${BASE_URL}/public/lots/${lot}/images`,
    `${BASE_URL}/public/lots/${lot}/lotImages`,
    `${BASE_URL}/public/data/lotdetails/lotimages/${lot}`,
    `${BASE_URL}/public/data/lotdetails/imagepaths/${lot}`,
    `${BASE_URL}/public/lots/${lot}/imagesList`,
    `${BASE_URL}/public/data/lotimages/${lot}`,
  ].filter(Boolean));

  const debugLots = (fetchLotImages._debugCount || 0) < 3;
  fetchLotImages._debugCount = (fetchLotImages._debugCount || 0) + 1;

  if (debugLots) {
    console.log(`[images-debug lot=${lot}] capturedLotImagesUrl=${capturedLotImagesUrl || "none"}`);
    console.log(`[images-debug lot=${lot}] candidates: ${candidates.join(", ")}`);
  }

  // Use browser-captured headers if available — these bypass Incapsula
  const imagesHeaders = capturedLotImagesHeaders
    ? { ...capturedLotImagesHeaders, Accept: "application/json, text/plain, */*" }
    : undefined;

  for (const url of candidates) {
    try {
      const resp = await withRetry(() => client.get(url, imagesHeaders ? { headers: imagesHeaders } : {}), 2);
      if (debugLots) console.log(`[images-debug lot=${lot}] ${url} → HTTP ${resp.status}${isIncapsulaBlock(resp) ? " (Incapsula)" : ""}`);
      const needsPwFallback = resp.status === 403 || isIncapsulaBlock(resp);
      if (resp.status >= 200 && resp.status < 300 && resp.data && !isIncapsulaBlock(resp)) {
        const topKeys = typeof resp.data === "object" ? Object.keys(resp.data).slice(0, 8).join(", ") : String(resp.data).slice(0, 80);
        const dataKeys = resp.data?.data && typeof resp.data.data === "object" ? Object.keys(resp.data.data).slice(0, 8).join(", ") : "";
        if (debugLots) {
          console.log(`[images-debug lot=${lot}] response keys: ${topKeys}${dataKeys ? ` | data keys: ${dataKeys}` : ""}`);
        }
        // Always write first 200 response to debug file so we can inspect the structure
        if (fetchLotImages._imagesDebugLogged === undefined) {
          fetchLotImages._imagesDebugLogged = true;
          fs.writeFile(
            path.join(OUTPUT_DIR, "debug_images_raw.json"),
            JSON.stringify({ lot, url, topKeys, dataKeys, response: resp.data }, null, 2),
            "utf-8"
          ).catch(() => {});
          console.log(`[images-debug] Full 200 images response written to output/debug_images_raw.json (lot=${lot}, url=${url})`);
        }
        const urls = parseLotImagesResponse(resp.data);
        if (urls && urls.length > 0) return urls;
      }
      if (needsPwFallback && pwClient) {
        const pwResp = await withRetry(() => pwClient.get(url, { headers: imagesHeaders }), 2);
        if (pwResp.status() >= 200 && pwResp.status() < 300) {
          const data = await pwResp.json().catch(() => null);
          if (data) {
            if (debugLots) {
              const topKeys = typeof data === "object" ? Object.keys(data).slice(0, 8).join(", ") : String(data).slice(0, 80);
              console.log(`[images-debug lot=${lot}] pw response keys: ${topKeys}`);
            }
            const urls = parseLotImagesResponse(data);
            if (urls && urls.length > 0) return urls;
          }
        }
      }
    } catch (err) {
      if (debugLots) console.log(`[images-debug lot=${lot}] ${url} → error: ${err.message}`);
    }
  }
  return null;
}

async function fetchLotDetails(client, pwClient, lotNumber, capturedLotDetailsUrl, capturedLotImagesUrl, capturedLotImagesHeaders, imagesLimit) {
  const lot = String(lotNumber);

  // Primary source: full lot object cached from search results
  const cachedLotData = lotDataCache.get(lot) || null;

  // Try to fetch inspection details (damage + images) from lot-details API
  const fetchInspectionData = async () => {
    const candidates = buildLotDetailsCandidates(lot, capturedLotDetailsUrl);
    for (const url of candidates) {
      try {
        const axiosResp = await withRetry(() => client.get(url), 2);
        const needsPwFallback = axiosResp.status === 403 || isIncapsulaBlock(axiosResp);
        if (axiosResp.status >= 200 && axiosResp.status < 300 && !isIncapsulaBlock(axiosResp)) {
          const data = axiosResp.data;
          if (data?.returnCode !== undefined && data.returnCode !== 1 && data.returnCode !== 0) continue;
          const payload = data?.data || data;
          return payload?.lotDetails || payload?.lot || payload;
        }
        if (needsPwFallback && pwClient) {
          const pwResp = await withRetry(() => pwClient.get(url), 2);
          if (pwResp.status() >= 200 && pwResp.status() < 300) {
            const data = await pwResp.json().catch(() => null);
            if (!data) continue;
            if (data?.returnCode !== undefined && data.returnCode !== 1 && data.returnCode !== 0) continue;
            const payload = data?.data || data;
            return payload?.lotDetails || payload?.lot || payload;
          }
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  };

  const [inspectionData, lotImagesList] = await Promise.all([
    fetchInspectionData(),
    imagesLimit(async () => {
      await sleep(randomBetween(300, 600));
      return fetchLotImages(client, pwClient, lot, capturedLotImagesUrl, capturedLotImagesHeaders);
    }),
  ]);

  if (!cachedLotData && !inspectionData) {
    throw new Error(`No data available for lot ${lot}`);
  }

  // Debug: dump raw data of first lot to file
  if (fetchLotDetails._debugLogged === undefined) {
    fetchLotDetails._debugLogged = true;
    const debugData = { lot, inspectionData, cachedLotData, lotImagesList, note: "See console for [images-debug] and [session] logs" };
    fs.writeFile(
      path.join(OUTPUT_DIR, "debug_lot_raw.json"),
      JSON.stringify(debugData, null, 2),
      "utf-8"
    ).catch(() => {});
    console.log(`[DEBUG] Raw lot data written to output/debug_lot_raw.json (lot ${lot})`);
  }

  // Merge: search result data (vehicle info) + inspection data (damage, images)
  const merged = { ...(inspectionData || {}), ...(cachedLotData || {}) };

  const record = normalizeCarRecord(mapLotDetails(merged, lot));

  // Merge additional images from the lot images API (full gallery)
  if (lotImagesList && lotImagesList.length > 0) {
    const extraUrls = lotImagesList
      .flatMap((item) => {
        if (typeof item === "string") return [normalizeImageUrl(item)];
        return [
          normalizeImageUrl(item?.url || item?.imageUrl || item?.src),
          normalizeImageUrl(item?.fullImageUrl),
          normalizeImageUrl(item?.highRes),
        ];
      })
      .filter((u) => u && isActualImageUrl(u));

    const combined = unique([...record.images, ...extraUrls]);
    record.images = combined;
  }

  // Upgrade thumbnails to full-size: _thb → _ful
  record.images = record.images.map((url) =>
    url.includes("_thb.") ? url.replace(/_thb\./, "_ful.") : url
  );

  // Deduplicate by image hash — keep one _ful URL per unique image, drop _hrs duplicates
  record.images = deduplicateImagesByHash(record.images);

  return record;
}

async function main() {
  const session = await initCopartSession();
  const cookieHeader = toCookieHeader(session.cookies);

  const xsrfCookie = session.cookies.find((c) => c.name.toLowerCase().includes("xsrf"));

  const defaultHeaders = {
    "User-Agent": session.userAgent,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    Cookie: cookieHeader,
  };

  if (xsrfCookie?.value) {
    defaultHeaders["x-xsrf-token"] = decodeURIComponent(xsrfCookie.value);
  }

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 45000,
    headers: defaultHeaders,
    validateStatus: () => true,
  });

  const pwClient = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: session.storageState,
    extraHTTPHeaders: {
      "User-Agent": session.userAgent,
      Accept: "application/json, text/plain, */*",
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
    },
  });

  try {
    if (!session.capturedSearchRequest && (!session.seedLots || session.seedLots.length === 0)) {
      throw new Error(
        "No search traffic captured in browser session. In HEADLESS=false mode, solve anti-bot and run a manual search before returning to terminal."
      );
    }

    const lots = await collectLotNumbers(
      client,
      {
        capturedSearchRequest: session.capturedSearchRequest,
        seedLots: session.seedLots,
      },
      TARGET_LOTS
    );

    if (lots.length === 0) {
      throw new Error(
        "Could not collect lot numbers. Try HEADLESS=false and complete any challenge in browser."
      );
    }

    if (lots.length < TARGET_LOTS) {
      console.warn(`Warning: collected only ${lots.length} lots (target=${TARGET_LOTS}).`);
    }

    const limit = pLimit(CONCURRENCY);
    const imagesLimit = pLimit(IMAGES_CONCURRENCY);
    let completed = 0;

    const tasks = lots.map((lotNumber) =>
      limit(async () => {
        await sleep(randomBetween(80, 220));
        try {
          console.log(`Fetching details: ${lotNumber}`);
          const details = await fetchLotDetails(
            client,
            pwClient,
            lotNumber,
            session.capturedLotDetailsUrl,
            session.capturedLotImagesUrl,
            session.capturedLotImagesHeaders,
            imagesLimit
          );
          completed += 1;
          if (completed % 100 === 0 || completed === lots.length) {
            console.log(`Progress: ${completed}/${lots.length}`);
          }
          return details;
        } catch (err) {
          console.warn(`Failed lot ${lotNumber}: ${err.message}`);
          return null;
        }
      })
    );

    const results = (await Promise.all(tasks)).filter(Boolean);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");

    console.log(`Saved: ${results.length} cars`);
    console.log(`File: ${OUTPUT_FILE}`);
  } finally {
    await pwClient.dispose();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
