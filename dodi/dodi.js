require("dotenv").config();

const log = require("@vladmandic/pilogger");
const {
    fetchHtml,
    loadCache,
    saveCache,
    loadProgress,
    saveProgress,
    saveFile,
    loadFile,
    configurePage,
    getPuppeteer,
} = require("../utils");

const BASE_URL = process.env.BASE_URL;
const DODI_URL = `${process.env.BASE_URL}/DODI-torrents/page/`;
const DODI_WEBSITE_URL = `${process.env.DODI_WEBSITE_URL}/all-repacks-a-z-2/`;
const OUTPUT_FILE = process.env.FILE;
const TIMEOUT = parseInt(process.env.TIMEOUT) || 60000;
const CACHE_FILE = process.env.CACHE_FILE;
const PROGRESS_FILE = process.env.PROGRESS_FILE;
const MAX_RETRIES = 3;

// Bypass DataNodes link
async function bypassLink(url, browser, attempt = 1) {
    if (attempt > MAX_RETRIES) {
        log.error(`Max retries reached for ${url}`);
        return null;
    }

    // Check if URL is from lootdest.org or rinku.me
    if (!url.includes("lootdest.org") && !url.includes("rinku.me")) {
        log.warn(
            `URL ${url} is not a valid DataNodes link (lootdest.org or rinku.me)`
        );
        return null;
    }

    const page = await browser.newPage();
    try {
        await configurePage(page);
        await page.goto(url, { waitUntil: "networkidle2", timeout: TIMEOUT });
        await page.waitForTimeout(3000);

        let finalUrl = await page.evaluate(() => {
            const link = Array.from(document.querySelectorAll("a")).find((a) =>
                a.href.includes("datanodes.to")
            );
            return link ? link.href : null;
        });

        if (!finalUrl) {
            const button = await page.$(
                'a#proceed, button, a[href*="datanodes.to"]'
            );
            if (button) {
                await button.click();
                await page
                    .waitForNavigation({
                        waitUntil: "networkidle2",
                        timeout: TIMEOUT,
                    })
                    .catch(() => {});
                finalUrl =
                    (await page.evaluate(() => {
                        const link = Array.from(
                            document.querySelectorAll("a")
                        ).find((a) => a.href.includes("datanodes.to"));
                        return link ? link.href : null;
                    })) || page.url();
            }
        }

        await page.close();
        if (finalUrl && finalUrl.includes("datanodes.to")) {
            log.info(`Bypassed to: ${finalUrl}`);
            return finalUrl;
        }
        log.warn(
            `No DataNodes URL for ${url}, retrying (${
                attempt + 1
            }/${MAX_RETRIES})`
        );
        return await bypassLink(url, browser, attempt + 1);
    } catch (err) {
        log.error(`Bypass error for ${url}: ${err.message}`);
        await page.close();
        return attempt < MAX_RETRIES
            ? await bypassLink(url, browser, attempt + 1)
            : null;
    }
}

// Scrape details for a single game link from 1337x
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

            const fullName = (() => {
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

// Scrape games from 1337x
async function scrapeDodi() {
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
        let lastCheckedPage = progress.lastCheckedIndex || 0;
        log.info(`Resuming from page ${lastCheckedPage + 1}`);

        for (
            let pageNum = lastCheckedPage + 1;
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

                    await saveFile(gameDetails, OUTPUT_FILE, {
                        logMessage: `Saved game ${gameDetails.name} to ${OUTPUT_FILE}`,
                        isSingleGame: true,
                    });
                }

                await saveProgress(PROGRESS_FILE, pageNum);
            } catch (err) {
                log.error(`Error processing page ${pageNum}: ${err.message}`);
                await page.close();
                continue;
            }
        }

        cache.lastChecked = new Date().toISOString();
        await saveCache(cache, CACHE_FILE);
        log.info("Updated cache with lastChecked timestamp");
    } catch (err) {
        log.error(`Error in scrapeDodi: ${err.message}`);
    } finally {
        await browser.close();
        log.info("Browser closed.");
    }
}

// Scrape from DODI to get DataNodes
async function scrapeDodiWebsite(checkDataNodes = false) {
    const browser = await getPuppeteer(TIMEOUT);

    try {
        const games = await loadFile(
            OUTPUT_FILE,
            `Loading games from ${OUTPUT_FILE}`
        );
        let maxId =
            games.length > 0
                ? Math.max(...games.map((g) => parseInt(g.id) || 0))
                : 0;

        const page = await browser.newPage();
        await configurePage(page);
        log.info(`Fetching DODI website: ${DODI_WEBSITE_URL}`);
        await page.goto(DODI_WEBSITE_URL, {
            waitUntil: "networkidle2",
            timeout: TIMEOUT,
        });

        // Step 1: Get all game links from the main page
        const gameItems = await page.evaluate(() => {
            const items = Array.from(
                document.querySelectorAll(".entry-content ul li a")
            )
                .map((a) => ({ name: a.textContent.trim(), link: a.href }))
                .filter((item) => item.name && item.link);
            return items;
        });

        if (gameItems.length === 0) {
            log.warn(`No games found with selector .entry-content ul li a`);
            await page.close();
            return;
        } else {
            log.info(`Found ${gameItems.length} games on DODI website`);
        }

        for (const { name, link } of gameItems) {
            // Normalize name for matching (remove special characters, extra spaces, etc.)
            const normalizedName = name
                .toLowerCase()
                .replace(/[-+]/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            // Step 2: Check if game exists in games.json
            const existingGame = games.find((g) => {
                const jsonName = g.name
                    .toLowerCase()
                    .replace(/[-+]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                return jsonName === normalizedName;
            });

            if (existingGame) {
                if (checkDataNodes && !existingGame.datanodes) {
                    log.info(`Checking DataNodes for existing game: ${name}`);
                    const datanodes = await scrapeDatanodes(link, browser);
                    if (datanodes) {
                        existingGame.datanodes = datanodes;
                        existingGame.lastChecked = new Date().toISOString();
                        await saveFile(games, OUTPUT_FILE, {
                            logMessage: `Updated DataNodes for ${name}`,
                        });
                    } else {
                        log.warn(`No DataNodes link found for ${name}`);
                    }
                } else {
                    log.info(`Found existing: ${name}`);
                }
                continue;
            }

            // Handle new games (if needed)
            log.info(`Scraping new game: ${name}`);
            const gameDetails = await scrapeDatanodes(link, browser);
            if (gameDetails) {
                const newGame = {
                    id: ++maxId,
                    name,
                    link, // Store DODI link
                    datanodes: gameDetails,
                    lastChecked: new Date().toISOString(),
                };
                games.push(newGame);
                await saveFile(newGame, OUTPUT_FILE, {
                    logMessage: `Saved game ${name} to ${OUTPUT_FILE}`,
                    isSingleGame: true,
                });
            } else {
                log.warn(`Failed to scrape DataNodes for ${name}`);
            }
        }

        log.info("DODI website scraping complete");
        await page.close();
    } catch (err) {
        log.error(`DODI website scraper error: ${err.message}`);
    } finally {
        await browser.close();
        log.info("Browser closed");
    }
}

// Updated scrapeDatanodes to only return the DataNodes link
async function scrapeDatanodes(link, browser) {
    const page = await browser.newPage();
    try {
        await configurePage(page);
        await page.goto(link, { waitUntil: "networkidle2", timeout: TIMEOUT });

        const result = await page.evaluate(() => {
            const content = document.querySelector(".entry-content");
            if (!content) return null;

            const datanodesLink = Array.from(
                content.querySelectorAll("a")
            ).find((a) =>
                a.textContent.trim().toLowerCase().includes("datanodes")
            )?.href;

            return datanodesLink || null;
        });

        await page.close();

        if (!result) {
            log.warn(`No DataNodes link found for ${link}`);
            return null;
        }

        // Bypass the DataNodes link (e.g., lootdest.org or rinku.me) to get the final URL
        const finalDatanodes = await bypassLink(result, browser);
        log.data(`DataNodes for ${link}: ${finalDatanodes}`);
        return finalDatanodes;
    } catch (err) {
        log.error(`Details error for ${link}: ${err.message}`);
        await page.close();
        return null;
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
    if (args.includes("--count")) {
        countItems();
    } else if (args.includes("--datanodes")) {
        scrapeDodiWebsite(true);
    } else {
        scrapeDodi();
    }
}
