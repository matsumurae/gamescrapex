# Game scraper

1. Imitate a real browser using pupetteer
2. Retrieve newest games
3. Keep the number of pages to avoid re-checking every time
4. **Search** using local JSON data instead of scraping again (saving time)

List of providers:

| Provider   | Status | Magnet     | Datanodes | Last update | Total                |
| ---------- | ------ | ---------- | --------- | ----------- | -------------------- |
| 🔥 Fitgirl | ✅     | ✅         | ✅        | 3/08/2025   | 5933 (5804 verified) |
| DODI       | ✅     | ✅ (1337x) | ❌        | 3/08/2025   | 2000                 |
| GOG Games  | TODO   | —          | —         | —           | —                    |
| SteamRIP   | TODO   | —          | —         | —           | —                    |
| Elamigos   | TODO   | —          | —         | —           | —                    |

## Fitgirl

Add your `.env` file with

```env
FILE=games.json
CACHE_FILE=cache.json
TEMP_FILE=temp.json
BASE_URL=https://fitgirl-repacks.site/
MAX_RETRIES=5
RETRY_DELAY=30000
TIMEOUT=30000
```

| Script          | Description                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| fitgirl:compare | Updates and cleans a game database by comparing lists, scraping details, and handling redirects |
| fitgirl:check   | Check if any games isn't on games.json but on complete.json. Checking if it has redirects.      |
| fitgirl:count   | loads, counts, finds duplicates and differences between them and shows a summary                |
| fitgirl:find    | Searches a game JSON file for a term or shows newest and largest games, then logs the results   |
| fitgirl:update  | Checks and updates game dates and links by comparing JSON data with website using Puppeteer.    |
| fitgirl:newest  | Scrapes game, saves new entries and tracks progress.                                            |
| fitgirl:url     | Scrape specific URL using args and check if name or links changed.                              |
| fitgirl:pages   | Scrape all pages and save them.                                                                 |

### fitgirl:compare

Checks which games aren't on `games.json` and fetch the data on her website to add them.

### fitgirl:count

Loads and counts items from three files (games.json, complete.json, and temp.json). It checks for duplicates in games.json, compares the lists to find items unique to each file, logs this info, and returns a summary of counts and differences.

It will show something like this:

```
Loaded 3253 games from games.json
Reading games.json… It has 3253 and 3251 verified.
✅ complete.json loaded correctly! It has 5873 games.
🔥 3253 on games.json and 3251 verified.
✨ 5873 on complete.json
📝 2667 on temp.json
⚠️ 2669 missing games.
```

### fitgirl:find

Search in games.json any game.

### fitgirl:update

Checks and updates game dates and links by comparing local JSON data with website info using Puppeteer.

This will update:

-   Date
-   Name
-   lastChecked to know when was the last fetch
-   Magnet link
-   Direct links (datanodes and fuckingfast)

### fitgirl:newest

Scrape only new games, if you have a `lastChecked` inside `cache.json`.

### fitgirl:url

Scrape specific url using arguments. Checks if name and links changed to update.

`npm run fitgirl:url <URL>`

### itgirl:pages

**If you don't have a `complete.json` file… Be patient! This takes a bit of time.**

Scrape all from A to Z and adds them to `complete.json`. For this, use the flag `--all`.

## DODI
