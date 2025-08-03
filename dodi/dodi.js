require("dotenv").config();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const {
    fetchHtml,
    loadCache,
    saveCache,
    loadProgress,
    saveProgress,
    saveFile,
    loadFile,
} = require("../utils");

puppeteer.use(StealthPlugin());

const BASE_URL = process.env.BASE_URL;
const DODI_URL = `${process.env.BASE_URL}/DODI-torrents/page/`;
const outputFile = process.env.FILE;
const timeout = parseInt(process.env.TIMEOUT);
const cacheFile = process.env.CACHE_FILE;
const progressFile = process.env.PROGRESS_FILE;

// Scrape details for a single game link (unchanged)
async function scrapeDetail(link, browser) {
    const page = await browser.newPage();
    try {
        const fullLink = `${BASE_URL}${link}`;
        log.info(`Fetching details for ${fullLink}`);

        const html = await fetchHtml(fullLink, browser);
        if (!html) {
            log.error(`Failed to fetch HTML for ${fullLink}`);
            await page.close();
            return null;
        }

        await page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: timeout,
        });

        const descriptionExists = await page.$("#description");
        if (!descriptionExists) {
            log.warn(`#description selector not found on ${fullLink}`);
            await page.close();
            return null;
        }

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

            const fullName = (() => {
                const title = document.title;
                let cleanTitle = title
                    .replace(/^Download\s+/i, "") // Remove "Download" prefix
                    .replace(/\s*\(From.*$/, "") // Remove "(From ...)" part
                    .replace(/\[DODI Repack\]/i, "") // Remove "[DODI Repack]"
                    .replace(/\s*Torrent\s*\|\s*1337x/i, "") // Remove "Torrent | 1337x"
                    .replace(/\s+/g, " ") // Normalize multiple spaces
                    .trim(); // Trim whitespace
                return cleanTitle;
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
        log.error(`Error in scrapeDetail for ${fullLink}: ${err.message}`);
        await page.close();
        return null;
    }
}

// Main scraping function (unchanged)
async function scrapeDodi() {
    const browser = await puppeteer.launch({ headless: true });
    let games = await loadFile(outputFile);
    let maxId =
        games.length > 0
            ? Math.max(...games.map((g) => parseInt(g.id) || 0))
            : 0;
    try {
        const cache = await loadCache(cacheFile);
        const totalPages = cache.pages || 1;
        log.info(`Total pages to scrape: ${totalPages}`);

        const progress = await loadProgress(progressFile);
        let lastCheckedPage = progress.lastCheckedIndex || 0;
        log.info(`Resuming from page ${lastCheckedPage + 1}`);

        for (
            let pageNum = lastCheckedPage + 1; // Start from the next page
            pageNum <= totalPages;
            pageNum++
        ) {
            const url = `${DODI_URL}${pageNum}/`;
            log.info(`🔎 Fetching page ${pageNum}: ${url}`);

            const html = await fetchHtml(url, browser);
            if (!html) {
                log.error(`🚩 Failed to fetch page ${pageNum}`);
                continue;
            }

            const page = await browser.newPage();
            try {
                await page.setContent(html);
                const links = await page.$$eval(
                    "table.table-list tbody tr td.name a",
                    (elements) =>
                        elements
                            .map((a) => a.href)
                            .filter((href) => href.includes("/torrent/"))
                );
                const formattedLinks = links
                    .map((link) => {
                        const parts = link.split("/");
                        const titleSegment = parts[parts.length - 2];
                        if (!titleSegment) return null;
                        let gameTitle = titleSegment
                            .replace(/^\d+-/, "")
                            .replace(/-/g, " ")
                            .replace(/DODI Repack$/, "")
                            .replace(/MULTi\d+/, "")
                            .replace(/From \d+\.?\d* GB/, "")
                            .replace(/v\d+\.?\d*\.?\d*/, "")
                            .replace(/Build \d+/, "")
                            .replace(/\s+/g, " ")
                            .trim();
                        return gameTitle ? `- ${gameTitle}` : null;
                    })
                    .filter((title) => title !== null)
                    .join("\n");
                log.info(
                    `Games on page ${pageNum}: \n ${
                        formattedLinks || "- No games found -"
                    }`
                );
                await page.close();

                if (links.length === 0) {
                    log.info(
                        `🚫 No torrents found on page ${pageNum}. Continuing…`
                    );
                } else {
                    log.state(
                        `📦 Found ${links.length} torrents on page ${pageNum}`
                    );
                }

                for (const link of links) {
                    if (games.some((result) => result.link === link)) {
                        log.info(`‼️ Already saved, skipping: ${link}`);
                        continue;
                    }

                    log.info(`🔎 Scraping [${games.length + 1}] ${link}`);
                    const gameDetails = await scrapeDetail(link, browser);
                    if (!gameDetails) {
                        log.warn(
                            `⚠️ Skipping due to detail scrape failure: ${link}`
                        );
                        continue;
                    }

                    maxId += 1;
                    gameDetails.id = maxId;
                    gameDetails.name = gameDetails.fullName;
                    gameDetails.link = link;
                    gameDetails.verified = !!(
                        gameDetails.magnet && gameDetails.size > 0
                    );
                    gameDetails.lastChecked = new Date().toISOString();
                    games.push(gameDetails);
                    log.data(`Added ${gameDetails.name}`, { link });

                    await saveFile(gameDetails, outputFile, {
                        logMessage: `Saved game ${gameDetails.name} to ${outputFile}`,
                        isSingleGame: true,
                    });
                }

                // Save progress after processing the page
                await saveProgress(progressFile, pageNum);
            } catch (err) {
                log.error(`Error processing page ${pageNum}: ${err.message}`);
                await page.close();
                continue;
            }
        }

        cache.lastChecked = new Date().toISOString();
        await saveCache(cache, cacheFile);
        log.info("Updated cache with lastChecked timestamp");
    } catch (err) {
        log.error(`Error in scrapeDodi: ${err.message}`);
    } finally {
        await browser.close();
        log.info("Browser closed.");
    }
}

// New countItems function for games.json
async function countItems() {
    try {
        const games = await loadFile(outputFile);
        const gamesCount = games.length;

        // Check for duplicates in games.json based on link
        const seenLinks = new Set();
        const duplicates = games.filter((game) => {
            if (seenLinks.has(game.link)) return true;
            seenLinks.add(game.link);
            return false;
        });

        if (duplicates.length > 0) {
            log.warn(
                `Found ${duplicates.length} duplicates in ${outputFile}`,
                duplicates
            );
        } else {
            log.info(`No duplicates found in ${outputFile}`);
        }

        log.data(
            `🔥 Found ${gamesCount} games and ${duplicates.length} duplicates`
        );

        return {
            gamesCount,
            duplicatesCount: duplicates.length,
        };
    } catch (err) {
        log.error(`⚠️  Count items failed. Error: ${err.message}`);
        return {
            gamesCount: 0,
            uniqueCount: 0,
            duplicatesCount: 0,
        };
    }
}

// Handle command-line arguments
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes("--count")) {
        countItems();
    } else {
        scrapeDodi();
    }
}
