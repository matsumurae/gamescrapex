require("dotenv").config();

const fs = require("fs").promises;
const log = require("@vladmandic/pilogger");
const yargs = require("yargs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const {
    fetchHtml,
    loadCache,
    saveCache,
    loadProgress,
    saveProgress,
    saveFile,
    loadFile,
} = require("../utils");

const BASE_URL = process.env.BASE_URL;
const DODI_URL = `${process.env.BASE_URL}/DODI-torrents/page/`;
const DODI_WEBSITE_URL = `${process.env.DODI_WEBSITE_URL}/all-repacks-a-z-2/`;
const OUTPUT_FILE = process.env.FILE;
const TIMEOUT = process.env.TIMEOUT;
const CACHE_FILE = process.env.CACHE_FILE;
const PROGRESS_FILE = process.env.PROGRESS_FILE;
const MAX_RETRIES = process.env.MAX_RETRIES;

const argv = yargs
    .option("update", {
        alias: "u",
        type: "boolean",
        description: "Update games by checking dates against cache.lastChecked",
        default: false,
    })
    .option("count", {
        alias: "c",
        type: "boolean",
        description: "Count items in games.json and check for duplicates",
        default: false,
    })
    .help().argv;

// Scrape details for a single game link from 1337x
async function scrapeDetail(link, browser) {
    const page = await browser.newPage();
    const fullLink = `${BASE_URL}${link}`;
    try {
        log.info(`Fetching details for ${fullLink}`);

        const html = await fetchHtml(fullLink, browser);
        if (!html) {
            log.error(`Failed to fetch HTML for ${fullLink}`);
            await page.close();
            return null;
        }

        await page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: TIMEOUT,
        });

        const descriptionExists = await page.$("#description");
        if (!descriptionExists) {
            log.warn(`#description selector not found on ${fullLink}`);
            await page.close();
            return null;
        }

        await page.waitForSelector("#description", { timeout: TIMEOUT });

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

            const name = (() => {
                const title = document.title;
                let cleanTitle = title
                    .replace(/^Download\s+/i, "")
                    .replace(/\s*\(From.*$/, "")
                    .replace(/\[DODI Repack\]/i, "")
                    .replace(/\s*Torrent\s*\|\s*1337x/i, "")
                    .replace(/\s+/g, " ")
                    .trim();
                return cleanTitle;
            })();

            return {
                name,
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

// Scrape games from 1337x
async function scrapeDodi(updateMode = false) {
    const browser = await puppeteer.launch({ headless: true });
    let games = await loadFile(OUTPUT_FILE);
    let maxId =
        games.length > 0
            ? Math.max(...games.map((g) => parseInt(g.id) || 0))
            : 0;
    try {
        const cache = await loadCache(CACHE_FILE);
        const totalPages = cache.pages || 1;
        log.info(`Total pages to scrape: ${totalPages}`);

        const progress = await loadProgress(PROGRESS_FILE);
        let lastCheckedPage = progress.lastCheckedIndex || 1;
        log.info(`Resuming from page ${lastCheckedPage}`);

        let lastCheckedTime = null;
        if (updateMode) {
            if (!cache.lastChecked) {
                log.warn(
                    `No lastChecked timestamp in cache. Falling back to full scrape.`
                );
                updateMode = false;
            } else {
                lastCheckedTime = new Date(cache.lastChecked);
                if (isNaN(lastCheckedTime)) {
                    log.warn(
                        `Invalid lastChecked timestamp in cache. Falling back to full scrape.`
                    );
                    updateMode = false;
                } else {
                    log.info(
                        `Update mode: Only scraping games newer than ${lastCheckedTime.toISOString()}`
                    );
                }
            }
        }

        for (let pageNum = lastCheckedPage; pageNum <= totalPages; pageNum++) {
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
                    continue;
                } else {
                    log.state(
                        `📦 Found ${links.length} torrents on page ${pageNum}`
                    );
                }

                let allGamesOlder = true; // Track if all games on page are older
                for (const link of links) {
                    const fullLink = `${BASE_URL}${link}`; // Prepend BASE_URL to the relative link
                    if (games.some((result) => result.link === fullLink)) {
                        log.info(`‼️ Already saved, skipping: ${fullLink}`);
                        continue;
                    }

                    if (updateMode) {
                        const gameDetailsPreview = await scrapeDetail(
                            link,
                            browser
                        );
                        if (!gameDetailsPreview) {
                            log.warn(
                                `⚠️ Skipping due to detail scrape failure: ${fullLink}`
                            );
                            continue;
                        }

                        const gameDate = gameDetailsPreview.date
                            ? new Date(gameDetailsPreview.date)
                            : null;
                        const gameUpdated = gameDetailsPreview.updated
                            ? new Date(gameDetailsPreview.updated)
                            : null;
                        const referenceTime = gameUpdated || gameDate;

                        if (!referenceTime || isNaN(referenceTime)) {
                            log.warn(
                                `⚠️ No valid date or updated time for ${fullLink}, skipping in update mode`
                            );
                            continue;
                        }

                        if (referenceTime <= lastCheckedTime) {
                            log.info(
                                `⏳ Skipping ${fullLink}: Not newer than ${lastCheckedTime.toISOString()}`
                            );
                            continue;
                        } else {
                            allGamesOlder = false;
                        }
                    }

                    log.info(`🔎 Scraping [${games.length + 1}] ${fullLink}`);
                    const gameDetails = await scrapeDetail(link, browser);
                    if (!gameDetails) {
                        log.warn(
                            `⚠️ Skipping due to detail scrape failure: ${fullLink}`
                        );
                        continue;
                    }

                    maxId += 1;
                    gameDetails.id = maxId;
                    gameDetails.link = fullLink;
                    gameDetails.verified = !!(
                        gameDetails.magnet && gameDetails.size > 0
                    );
                    gameDetails.lastChecked = new Date().toISOString();
                    games.push(gameDetails);
                    log.data(`Added ${gameDetails.fullName}`, {
                        link: fullLink,
                    });

                    await saveFile(gameDetails, OUTPUT_FILE, {
                        logMessage: `Saved game ${gameDetails.fullName} to ${OUTPUT_FILE}`,
                        isSingleGame: true,
                    });
                }

                // If all games on this page were older, stop scraping further pages
                if (updateMode && allGamesOlder) {
                    log.info(
                        `🛑 All games on page ${pageNum} are older than ${lastCheckedTime.toISOString()}. Stopping scrape.`
                    );
                    break;
                }

                // Update progress and cache after each page
                await saveProgress(PROGRESS_FILE, pageNum);
                cache.lastChecked = new Date().toISOString(); // Update cache after each page
                await saveCache(cache, CACHE_FILE);
                log.info(
                    `Updated cache with lastChecked timestamp for page ${pageNum}`
                );
            } catch (err) {
                log.error(`Error processing page ${pageNum}: ${err.message}`);
                await page.close();
                continue;
            }
        }
    } catch (err) {
        log.error(`Error in scrapeDodi: ${err.message}`);
    } finally {
        await browser.close();
        log.info("Browser closed.");

        // Delete progress.json if in update mode
        if (updateMode) {
            try {
                await fs.unlink(PROGRESS_FILE);
                log.info(`Deleted ${PROGRESS_FILE} after update completion.`);
            } catch (err) {
                if (err.code === "ENOENT") {
                    log.info(
                        `${PROGRESS_FILE} does not exist, no deletion needed.`
                    );
                } else {
                    log.error(
                        `Failed to delete ${PROGRESS_FILE}: ${err.message}`
                    );
                }
            }
        }
    }
}

// Count items in games.json
async function countItems() {
    try {
        const games = await loadFile(OUTPUT_FILE);
        const gamesCount = games.length;

        const seenLinks = new Set();
        const duplicates = games.filter((game) => {
            if (seenLinks.has(game.link)) return true;
            seenLinks.add(game.link);
            return false;
        });

        if (duplicates.length > 0) {
            log.warn(
                `Found ${duplicates.length} duplicates in ${OUTPUT_FILE}`,
                duplicates
            );
        } else {
            log.info(`No duplicates found in ${OUTPUT_FILE}`);
        }

        log.data(
            `🔥 Found ${gamesCount} games and ${duplicates.length} duplicates`
        );

        return {
            gamesCount,
            duplicatesCount: duplicates.length,
        };
    } catch (err) {
        log.error(`⚠️ Count items failed. Error: ${err.message}`);
        return {
            gamesCount: 0,
            duplicatesCount: 0,
        };
    }
}

// Handle command-line arguments
if (require.main === module) {
    const args = process.argv.slice(2);
    if (argv.count) {
        countItems();
    } else if (argv.update) {
        scrapeDodi(true);
    } else {
        scrapeDodi(false);
    }
}
