# Game scraper

1. Imitate a real browser using pupetteer (but cannot bypass Cloudflare)
2. Retrieve newest games using lastChecked
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

## `cache.json`

You need one like…

```json
{
    "pages": 119,
    "lastChecked": "2025-08-03T17:58:46.175Z"
}
```

**Pages** are the total of pages so the code knows where to stop. **Lastchecked** is used to retrieve updates.

## `.env`

Each folder has it's own, both have the same on: TIMEOUT, RETRY_DELAY, MAX_RETRIES, FILE, CACHE_FILE and TEMP_FILE. Some can have PROGRESS_FILE, and of course BASE_URL changes. Check each README to know what to put.

## Providers wiki

-   [Fitgirl](fitgirl/README.md)
-   [DODI](dodi/README.md)
