require("dotenv").config();

const fs = require("fs");
const log = require("@vladmandic/pilogger");
const yargs = require("yargs");
const {
    configurePage,
    fetchHtml,
    loadFile,
    saveFile,
    getPuppeteer,
} = require("../utils");
const { details } = require("./utils");

// Command-line arguments
const argv = yargs
    .option("start-index", {
        alias: "s",
        type: "number",
        default: 1,
        description: "Starting page index",
    })
    .option("all", {
        alias: "a",
        type: "boolean",
        default: false,
        description: "Scrape all A-Z content",
    })
    .option("fetch", {
        alias: "f",
        type: "string",
        description: "Fetch details for a specific game by name or link",
    })
    .help().argv;

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
                            !item.name.toUpperCase().startsWith("UPDATE") &&
                            !item.name.toUpperCase().includes("UPDATED")
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
                    // Check if the game name has changed
                    const existingGame = existingGames.find(
                        (g) => g.link === link
                    );
                    if (existingGame && existingGame.name !== name) {
                        log.info(
                            `🔄 Game name changed for ${link}: "${existingGame.name}" to "${name}"`
                        );
                        const game = {
                            id: existingGame.id,
                            name,
                            link,
                            timestamp,
                        };
                        const [updatedGame, verified] = await details(
                            game,
                            browser
                        );

                        // Log updatedGame for debugging
                        log.debug(`Updated details for ${game.name}`, {
                            updatedGame,
                            verified,
                        });

                        // Update only name, direct, and magnet fields
                        const updatedEntry = {
                            ...existingGame,
                            name: updatedGame.name,
                            direct:
                                updatedGame.direct || existingGame.direct || {},
                            magnet:
                                updatedGame.magnet ||
                                existingGame.magnet ||
                                null,
                            lastChecked: new Date().toISOString(),
                        };

                        // Save updated game
                        await saveFile(updatedEntry, file, {
                            isSingleGame: true,
                        });
                        log.info(`✅ Updated game: ${updatedEntry.name}`);
                    } else {
                        log.debug(
                            `Game already exists and name unchanged: ${name} (${link})`
                        );
                    }
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
    const browser = await getPuppeteer(timeout);

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

// Fetch details for a specific game
async function fetchSpecificGame(browser, input) {
    try {
        log.info(`🔎 Fetching details for: ${input}`);

        let game = null;
        const existingGames = await loadFile(file);

        // Check if input is a URL
        const isUrl = input.match(/^https?:\/\//);
        if (isUrl) {
            // Navigate to the game page to extract the actual title
            const page = await browser.newPage();
            await configurePage(page);
            try {
                await page.goto(input, {
                    waitUntil: "networkidle2",
                    timeout: timeout,
                });

                game = await page.evaluate(() => {
                    const titleElement =
                        document.querySelector("h1.entry-title") ||
                        document.querySelector("h1") ||
                        document.querySelector(".entry-title > a");
                    const name = titleElement?.textContent.trim() || null;
                    return name ? { name, link: window.location.href } : null;
                });

                if (!game) {
                    // Fallback: Clean up the last URL segment
                    const urlName = input
                        .split("/")
                        .pop()
                        .replace(/-/g, " ")
                        .replace(/\.[^/.]+$/, "");
                    game = {
                        name:
                            urlName.charAt(0).toUpperCase() + urlName.slice(1),
                        link: input,
                    };
                    log.warn(
                        `⚠️ Could not extract title from page, using fallback name: ${game.name}`
                    );
                }

                await page.close();
            } catch (err) {
                await page.close();
                log.error(`Failed to fetch page for URL ${input}`, {
                    error: err.message,
                });
                return;
            }
        } else {
            // Search for game by name in existing games
            game = existingGames.find(
                (g) => g.name.toLowerCase() === input.toLowerCase()
            );
            if (!game) {
                log.warn(
                    `Game "${input}" not found in existing data. Searching on website...`
                );

                // Search on website
                const searchUrl = `${baseUrl}?s=${encodeURIComponent(input)}`;
                const page = await browser.newPage();
                await configurePage(page);
                try {
                    await page.goto(searchUrl, {
                        waitUntil: "networkidle2",
                        timeout: timeout,
                    });

                    game = await page.evaluate((input) => {
                        const link = Array.from(
                            document.querySelectorAll(
                                "article .entry-title > a"
                            )
                        ).find((a) =>
                            a.textContent
                                .toLowerCase()
                                .includes(input.toLowerCase())
                        );
                        return link
                            ? { name: link.textContent.trim(), link: link.href }
                            : null;
                    }, input);

                    await page.close();

                    if (!game) {
                        log.error(`Game ${input} not found on website`);
                        return;
                    }
                } catch (err) {
                    await page.close();
                    log.error(`Failed to search for game "${input}"`, {
                        error: err.message,
                    });
                    return;
                }
            }
        }

        // Validate game name
        if (!game.name || game.name.trim() === "") {
            log.error(`Invalid game name for input "${input}"`);
            return;
        }

        // Fetch details for the game
        const maxId =
            existingGames.length > 0
                ? Math.max(...existingGames.map((g) => g.id))
                : 0;
        const gameData = {
            id: maxId + 1,
            name: game.name,
            link: game.link,
        };

        log.info(`🔎 Processing game: ${game.link} (${game.name})`);
        const [updatedGame, verified] = await details(gameData, browser);

        // Ensure the original name is preserved unless updatedGame.name is valid
        const finalName =
            updatedGame.name && updatedGame.name.trim()
                ? updatedGame.name
                : gameData.name;

        // Check if updatedGame has valid data
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
                name: finalName,
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
                    updatedGame.lastChecked || new Date().toISOString(),
            };
            await saveFile(newGame, file, { isSingleGame: true });
            log.info(`✅ Saved game: ${newGame.name} (ID: ${newGame.id})`);
        } else {
            log.warn(`⚠️ Skipping save for ${finalName}: incomplete data`);
        }
    } catch (err) {
        log.error(`Failed to fetch game "${input}"`, { error: err.message });
    }
}

// Main execution
async function main() {
    const browser = await getPuppeteer(timeout);

    try {
        if (argv.fetch) {
            await fetchSpecificGame(browser, argv.fetch);
        } else if (argv.all) {
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
