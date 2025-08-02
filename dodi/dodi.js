require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

puppeteer.use(StealthPlugin());

const BASE_URL = "https://1337x.to";
const START_URL = `${BASE_URL}/DODI-torrents/`;
const outputFile = "dodi.json";
const timeout = parseInt(process.env.TIMEOUT);

async function scrapeDetail(link, browser) {
    const page = await browser.newPage();
    try {
        await page.goto(link, {
            waitUntil: "domcontentloaded",
            timeout: timeout,
        });

        await page.waitForSelector("#description", { timeout: timeout });

        const result = await page.evaluate(() => {
            const desc = document.querySelector("#description");
            const text = desc.textContent;

            function relativeTimeToISO(text) {
                const now = new Date();

                const match = text.match(
                    /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i
                );
                if (!match) return null;

                const value = parseInt(match[1], 10);
                const unit = match[2];

                const date = new Date(now);

                switch (unit) {
                    case "second":
                        date.setSeconds(now.getSeconds() - value);
                        break;
                    case "minute":
                        date.setMinutes(now.getMinutes() - value);
                        break;
                    case "hour":
                        date.setHours(now.getHours() - value);
                        break;
                    case "day":
                        date.setDate(now.getDate() - value);
                        break;
                    case "week":
                        date.setDate(now.getDate() - value * 7);
                        break;
                    case "month":
                        date.setMonth(now.getMonth() - value);
                        break;
                    case "year":
                        date.setFullYear(now.getFullYear() - value);
                        break;
                }

                return date.toISOString();
            }

            const getTextAfterLabel = (label) => {
                const lists = document.querySelectorAll(".box-info ul.list li");
                for (const li of lists) {
                    const strong = li.querySelector("strong");
                    const span = li.querySelector("span");
                    if (
                        strong &&
                        span &&
                        strong.textContent.trim() ===
                            label.replace(":", "").trim()
                    ) {
                        return span.textContent.trim();
                    }
                }
                return "";
            };

            const magnet = (() => {
                const el = document.querySelector('a[href^="magnet:"]');
                return el ? el.href : "";
            })();

            const genre = (() => {
                if (!desc) return [];
                const match = text.match(/Genre:\s*([^\n]+)/i);
                return match ? match[1].split(",").map((t) => t.trim()) : [];
            })();

            const publisher = (() => {
                if (!desc) return [];

                const devMatch = text.match(/Developer\s*:\s*([^\n]+)/i);
                const pubMatch = text.match(/Publisher\s*:\s*([^\n]+)/i);

                const devs = devMatch
                    ? devMatch[1].split(",").map((s) => s.trim())
                    : [];
                const pubs = pubMatch
                    ? pubMatch[1].split(",").map((s) => s.trim())
                    : [];

                return [...new Set([...devs, ...pubs])];
            })();

            const dateText = getTextAfterLabel("Date uploaded:");
            const updatedText = getTextAfterLabel("Last checked:");
            const date = relativeTimeToISO(dateText);
            const updated = relativeTimeToISO(updatedText);

            const originalMatch = text.match(/Final Size\s*:\s*([\d.]+)\s*GB/i);
            const packedMatch = text.match(
                /Repack Size\s*:\s*From\s*([\d.]+)\s*GB/i
            );

            const original = originalMatch ? `${originalMatch[1]} GB` : null;
            const packed = packedMatch ? `${packedMatch[1]} GB` : null;
            const size = originalMatch ? parseFloat(originalMatch[1]) : null;

            // Get name from <title>
            const fullName = (() => {
                const title = document.title;

                // Remove "Download " from the beginning and "(From…)" and everything after
                const cleanTitle = title
                    .replace(/^Download\s+/i, "")
                    .replace(/\s*\(From.*$/, "");
                return cleanTitle.trim();
            })();

            return {
                fullName,
                magnet,
                genre,
                publisher,
                original,
                date,
                packed,
                size,
                updated,
            };
        });

        await page.close();
        return result;
    } catch (err) {
        await page.close();
        log.error(`❌ Error in scrapeDetail for ${link}: ${err.message}`);
        return null;
    }
}

async function scrapeDodi() {
    log.configure({ inspect: { breakLength: 400 } });
    log.header("Starting DODI scraper with pagination");

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ],
    });

    let results = [];
    // Load existing results to check for duplicates
    if (fs.existsSync(outputFile)) {
        try {
            results = JSON.parse(fs.readFileSync(outputFile, "utf8"));
            log.info(
                `📂 Loaded ${results.length} existing torrents from ${outputFile}`
            );
        } catch (err) {
            log.error(`❌ Error reading ${outputFile}: ${err.message}`);
        }
    }

    let pageNum = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const pageUrl = `${START_URL}${pageNum}/`;
        log.info(`🔎 Loading page ${pageNum}: ${pageUrl}`);

        const page = await browser.newPage();
        try {
            const response = await page.goto(pageUrl, {
                waitUntil: "domcontentloaded",
                timeout,
            });

            if (response.status() === 404) {
                log.info(`🚫 Page ${pageNum} returned 404. Stopping.`);
                hasMorePages = false;
                await page.close();
                break;
            }

            const torrents = await page.$$eval(
                "table.table-list tbody tr td.name a",
                (elements) =>
                    elements
                        .map((a) => ({
                            link: a.href,
                        }))
                        .filter((t) => t.link.includes("/torrent/"))
            );

            await page.close();

            if (torrents.length === 0) {
                log.info(
                    `🚫 No more torrents found on page ${pageNum}. Stopping…`
                );
                hasMorePages = false;
                break;
            }

            log.state(
                `📦 Found ${torrents.length} torrents on page ${pageNum}`
            );

            for (let i = 0; i < torrents.length; i++) {
                const { link } = torrents[i];

                // Check for duplicates
                if (results.some((result) => result.link === link)) {
                    log.info(`‼️  Already saved, skipping: ${link}`);
                    continue;
                }

                log.state(`🔎 Scraping [${results.length + 1}] ${link}`);

                const detail = await scrapeDetail(link, browser);
                if (!detail) {
                    log.warn(
                        `⚠️  Skipping due to detail scrape failure: ${link}`
                    );
                    continue;
                }

                results.push({
                    id: results.length + 1,
                    name: detail.fullName,
                    link,
                    date: detail.date,
                    updated: detail.updated,
                    tags: detail.genre,
                    publisher: detail.publisher,
                    original: detail.original,
                    packed: detail.packed,
                    size: detail.size,
                    magnet: detail.magnet,
                    lastChecked: new Date().toISOString(),
                });

                // Save incrementally
                fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
            }

            pageNum++;
        } catch (err) {
            log.error(`Failed to process page ${pageNum}: ${err.message}`);
            await page.close();
            hasMorePages = false;
        }
    }

    log.info(`✅ dodi.json saved with ${results.length} torrents total`);
    await browser.close();
}

if (require.main === module) scrapeDodi();
