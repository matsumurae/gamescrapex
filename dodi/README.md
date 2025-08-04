## DODI

Add your `.env` file with

```env
FILE=games.json
CACHE_FILE=cache.json
TEMP_FILE=temp.json
PROGRESS_FILE=progress.json
BASE_URL=https://1337x.to
DODI_WEBSITE_URL=https://dodi-repacks.site
MAX_RETRIES=5
RETRY_DELAY=30000
TIMEOUT=30000
```

| Script      | Description                                          |
| ----------- | ---------------------------------------------------- |
| dodi        | Scrape all pages and save them.                      |
| dodi:count  | loads, counts, finds duplicates and shows a summary  |
| dodi:update | Scrapes game, saves new entries and tracks progress. |

### dodi

**If you don't have a `games.json` file… Be patient! This takes a bit of time.**

Scrape all from 1 till last page.

### dodi:update

Scrape only new games, if you have a `lastChecked` inside `cache.json`.

### dodi:count

It show like:

```
🌀 Loading JSON, wait a sec…
No duplicates found in games.json
🔥 Found 2000 games and 0 duplicates
```
