require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const yargs = require("yargs");
const { configurePage, fetchHtml, loadFile, saveFile } = require("../utils");
const { details } = require("./utils");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Command-line arguments
const argv = yargs
    .option("start-index", {
        type: "number",
        default: 1,
        description: "Starting page index",
    })
    .option("all", {
        type: "boolean",
        default: false,
        description: "Scrape all A-Z content",
    }).argv;

// Configurable
const baseUrl = process.env.BASE_URL;
const fullUrl = `${baseUrl}all-my-repacks-a-z`;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const file = process.env.FILE;
const cacheFile = process.env.CACHE_FILE;
let cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

// Update cache with new page count
async function updateCachePageCount(browser) {
    try {
        const page = await browser.newPage();
        await configurePage(page);
        await page.goto(fullUrl, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });

        const lastPageNum = await page.evaluate(() => {
            const paginator = document.querySelector(".lcp_paginator");
            if (!paginator) return null;
            const links = paginator.querySelectorAll("a");
            if (links.length < 2) return 1;
            const penultimateLink = links[links.length - 2];
            return parseInt(penultimateLink.getAttribute("title")) || 1;
        });

        if (lastPageNum && lastPageNum !== cache.pages) {
            cache.pages = lastPageNum;
            cache.lastChecked = new Date().toISOString();
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            log.info(
                `⚡️ Updated cache. ${lastPageNum} is last page and ${cache.lastChecked} is last game checked.`
            );
        } else if (!lastPageNum) {
            log.warn("Could not determine page count");
        }

        await page.close();
        return lastPageNum || cache.pages;
    } catch (err) {
        log.error("Failed to update cache page count", { error: err.message });
        return cache.pages;
    }
}

// Save current page number to state.json
async function saveState(pageNum) {
    try {
        const state = { currentPage: pageNum };
        fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
        log.debug("Saved state", { currentPage: pageNum });
    } catch (err) {
        log.error("Save state failed", { error: err.message });
    }
}

// Load current page number from state.json
function loadState() {
    try {
        if (fs.existsSync("state.json")) {
            const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
            return state.currentPage || argv.startIndex;
        }
        return argv.startIndex;
    } catch (err) {
        log.error("Load state failed, using start-index", {
            error: err.message,
            startIndex: argv.startIndex,
        });
        return argv.startIndex;
    }
}

// Scrape newest games from page 1
async function scrapeNewestGames(browser, attempt = 1) {
    let page = null;
    try {
        page = await browser.newPage();
        let currentPageUrl = baseUrl;

        log.data(`Starting scraping new games… Wait a moment…`);

        await configurePage(page);

        while (true) {
            try {
                await page.goto(currentPageUrl, {
                    waitUntil: "domcontentloaded",
                    timeout: timeout,
                });
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } catch (err) {
                if (
                    err.message.includes("Navigation timeout") ||
                    err.message.includes("net::ERR_CONNECTION_REFUSED") ||
                    err.message.includes("net::ERR_CONNECTION_RESET")
                ) {
                    log.warn(
                        `Navigation attempt failed for ${currentPageUrl}. Error: ${err.message}`
                    );
                    if (attempt >= maxRetries) {
                        log.error(`All retries failed for ${currentPageUrl}`);
                        await page.close();
                        return;
                    }
                    log.info(
                        `Retrying ${currentPageUrl} (attempt ${
                            attempt + 1
                        }/${maxRetries})`,
                        { currentPageUrl }
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay * (attempt + 1))
                    );
                    await page.close();
                    return scrapeNewestGames(browser, attempt + 1);
                } else {
                    throw err;
                }
            }

            // Step 2: Select all articles and extract data
            const articles = await page.evaluate(() => {
                const articleNodes = document.querySelectorAll("article");
                return Array.from(articleNodes)
                    .slice(1) // Skip the first article
                    .map((article) => {
                        const time = article.querySelector("time.entry-date");
                        const titleLink =
                            article.querySelector(".entry-title > a");
                        return {
                            timestamp: time?.getAttribute("datetime"),
                            name: titleLink?.textContent.trim(),
                            link: titleLink?.href,
                        };
                    })
                    .filter(
                        (item) =>
                            item.timestamp &&
                            item.name &&
                            item.link &&
                            !item.name.toUpperCase().startsWith("UPDATE")
                    );
            });

            log.data(
                `🔥 Found ${articles.length} games on page ${currentPageUrl}`
            );

            const lastChecked = new Date(cache.lastChecked);
            if (
                articles.length > 0 &&
                new Date(articles[0].timestamp) <= lastChecked
            ) {
                log.info(
                    `🛑 Stopping pagination: First game on page is older than ${lastChecked.toISOString()}`
                );
                break;
            }

            const existingGames = await loadFile(file);
            const existingLinks = new Set(
                existingGames.map((game) => game.link)
            );
            let maxId =
                existingGames.length > 0
                    ? Math.max(...existingGames.map((g) => g.id))
                    : 0;

            const newArticles = articles.filter(
                (article) => new Date(article.timestamp) > lastChecked
            );

            log.data(
                `🔎 Found ${
                    newArticles.length
                } new games since ${lastChecked.toISOString()} on page ${currentPageUrl}`
            );

            for (const { name, link, timestamp } of newArticles) {
                if (!existingLinks.has(link)) {
                    const game = {
                        id: ++maxId,
                        name,
                        link,
                        timestamp,
                    };
                    log.info(`🔎 Found new game: ${game.name} (${game.link})`);

                    const [updatedGame, verified] = await details(
                        game,
                        browser
                    );
                    // Log updatedGame for debugging
                    log.debug(`Details for ${game.name}`, {
                        updatedGame,
                        verified,
                    });

                    // Check if updatedGame.direct is an object before accessing
                    const hasValidDirectLinks =
                        updatedGame.direct &&
                        typeof updatedGame.direct === "object" &&
                        Object.keys(updatedGame.direct).length > 0;

                    if (
                        verified ||
                        updatedGame.size > 0 ||
                        updatedGame.magnet ||
                        hasValidDirectLinks
                    ) {
                        const newGame = {
                            id: updatedGame.id,
                            name: updatedGame.name,
                            link: updatedGame.link,
                            date: updatedGame.date,
                            tags: updatedGame.tags || [],
                            creator: updatedGame.creator || [],
                            original: updatedGame.original || "",
                            packed: updatedGame.packed || "",
                            size: updatedGame.size || 0,
                            verified: updatedGame.verified,
                            magnet: updatedGame.magnet || null,
                            direct: updatedGame.direct || {},
                            lastChecked:
                                updatedGame.lastChecked ||
                                new Date().toISOString(),
                        };
                        await saveFile(newGame, file, { isSingleGame: true });
                        log.info(`✅ Saved new game: ${newGame.name}`);
                    } else {
                        log.warn(
                            `⚠️ Skipping save for ${game.name}: incomplete data`
                        );
                    }
                } else {
                    log.debug(
                        `Game already exists in games.json: ${name} (${link})`
                    );
                }
            }

            const nextPageLink = await page.evaluate(() => {
                const nextButton = document.querySelector(".pagination .next");
                return nextButton ? nextButton.href : null;
            });

            if (nextPageLink) {
                log.info(`🔗 Found next page: ${nextPageLink}`);
                currentPageUrl = nextPageLink;
            } else {
                log.info("🛑 No next page found, stopping pagination");
                break;
            }
        }

        cache.lastChecked = new Date().toISOString();
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        log.info(`⚡️ Updated lastChecked to ${cache.lastChecked}`);

        await page.close();
    } catch (err) {
        log.error(`Newest games scraping failed. Error: ${err.message}`);
        if (page) {
            await page.close();
        }
        throw err;
    }
}

// Main scraping function for all pages
async function scrapeAll() {
    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
            "--disable-gpu", // Disable GPU for compatibility
            "--disable-dev-shm-usage", // Avoid shared memory issues
        ],
        protocolTimeout: 60000,
    });

    // Update cache page count
    const cachedNumPages = await updateCachePageCount(browser);

    let startPage = loadState();
    let id = 1;
    let games = [];
    if (fs.existsSync("complete.json")) {
        games = JSON.parse(fs.readFileSync("complete.json", "utf8"));
        id = games.length > 0 ? Math.max(...games.map((g) => g.id)) + 1 : 1;
    }

    // Iterate through all pages starting from startPage
    for (let pageNum = startPage; pageNum <= cachedNumPages; pageNum++) {
        const pageUrl = `${fullUrl}/?lcp_page0=${pageNum}#lcp_instance_0`;
        const content = await fetchHtml(pageUrl, browser);
        if (!content) {
            log.error("No content fetched for page", { pageNum });
            continue;
        }

        const page = await browser.newPage();
        try {
            await configurePage(page);
            await page.goto(pageUrl, {
                waitUntil: "networkidle2",
                timeout: timeout,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelay));

            // Extract games
            const gamesElements = await page.evaluate(() => {
                const list = document.querySelector("ul.lcp_catlist");
                if (!list) return [];
                const items = list.querySelectorAll("li a");
                return Array.from(items)
                    .map((a) => ({
                        name: a.textContent.trim(),
                        link: a.href,
                    }))
                    .filter((item) => item.name && item.link);
            });

            log.data(
                `🔥 Scraped page ${pageNum} with ${gamesElements.length} games`
            );

            // Process each game individually
            for (const { name, link } of gamesElements) {
                const game = {
                    id: id++,
                    name,
                    link,
                    page: pageNum,
                };
                log.info(`🔎 Found game: ${game.name}`);
                await saveFile(game, "complete.json", {
                    isSingleGame: true,
                });
            }

            await saveState(pageNum + 1);
            await page.close();
        } catch (err) {
            log.error("Page processing failed", {
                pageNum,
                error: err.message,
            });
            await page.close();
        }
    }

    log.data(`🔥 Scraping complete!`);
    await browser.close();
}

// Main execution
async function main() {
    // log.configure({ inspect: { breakLength: 500 } });
    // log.headerJson();

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
            "--disable-gpu", // Disable GPU for compatibility
            "--disable-dev-shm-usage", // Avoid shared memory issues
        ],
    });

    try {
        if (argv.all) {
            await scrapeAll();
        } else {
            await scrapeNewestGames(browser);
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
}
