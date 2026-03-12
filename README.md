# Copart Scraper

> Scrape Copart auction listings with filters — Node.js, Playwright, no API key required.

A scraper for [copart.com](https://www.copart.com). Opens a real browser, intercepts API requests with your search filters, and collects all matching lots into a JSON file.

Use cases:

- analyzing salvage car prices
- building a lot database with photos and VINs
- monitoring auction listings

## How it works

1. Playwright opens a real Chromium browser and loads Copart with your search URL
2. The script intercepts API requests the browser sends during search — extracting cookies, XSRF token, and filter parameters
3. axios then paginates through the lot list via Copart's internal API (`/public/lots/search-results`)
4. For each lot, details are fetched in parallel (`/public/data/lotdetails/solr/lotNumber/{n}`)
5. Everything is saved to `output/copart_cars.json`

The browser is only needed to initialize the session. If Copart shows a CAPTCHA or Cloudflare challenge, you can solve it manually in the open window — the script will continue automatically after you press Enter.

## Installation

```bash
git clone https://github.com/your-username/copart-parser
cd copart-parser
npm install
npx playwright install chromium
```

## Usage

```bash
node scraper.js
```

A Chromium browser will open. If Copart shows a CAPTCHA or bot check — solve it manually, then press Enter in the terminal.

Results are saved to `output/copart_cars.json`.

## Search filters

By default the script uses the search URL hardcoded in `scraper.js` (line 25). This is a link from your Copart search with all your selected filters applied.

To change the filters — open the desired search on copart.com, copy the URL from the address bar, and replace the `SEARCH_URL` value in the script (or pass it as an environment variable):

```bash
SEARCH_URL="https://www.copart.com/lotSearchResults?..." node scraper.js
```

## Configuration

All parameters can be overridden via environment variables:

| Variable          | Default | Description                                              |
|-------------------|---------|----------------------------------------------------------|
| `TARGET_LOTS`     | `5000`  | Number of lots to collect                                |
| `CONCURRENCY`     | `15`    | Parallel requests when fetching lot details              |
| `HEADLESS`        | `false` | `true` — run browser without UI (background mode)        |
| `SESSION_WAIT_MS` | `15000` | Wait time after browser opens (ms) before scraping       |
| `OUTPUT_FILE`     | —       | Output file path (default: `output/copart_cars.json`)    |
| `SEARCH_URL`      | —       | Search URL with filters (overrides the one in the script)|

Example — collect 1000 lots in background mode:

```bash
TARGET_LOTS=1000 HEADLESS=true node scraper.js
```

## Output format

Each lot in `copart_cars.json`:

```json
{
  "lot_number": "12345678",
  "vin": "JTHBF5C2...",
  "year": 2015,
  "make": "Toyota",
  "model": "Camry",
  "trim": "LE",
  "full_model_name": "Toyota Camry LE",
  "color": "Silver",
  "transmission": "Automatic",
  "drive": "FWD",
  "fuel": "Gasoline",
  "odometer": 145000,
  "damage": "Front End",
  "location": "Los Angeles, CA, 90001",
  "buy_it_now_price": 8500,
  "estimated_retail_value": 12000,
  "item_url": "https://www.copart.com/lot/12345678",
  "images": [
    "https://cs.copart.com/...jpg"
  ]
}
```

## Dependencies

- [playwright](https://playwright.dev) — browser automation, bot detection bypass
- [axios](https://axios-http.com) — HTTP requests to Copart API
- [p-limit](https://github.com/sindresorhus/p-limit) — concurrency control for parallel requests

## Keywords

copart scraper, copart parser, copart auction scraper, copart lot data, copart API, salvage car scraper, used car auction data, vehicle auction scraper, copart nodejs, playwright scraper, copart json export, copart search scraper, salvage title cars, copart vehicle data extraction
