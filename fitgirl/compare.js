// Compare script for FitGirl repacks
// This script compares the current game database with a complete list of games,
// updates the database with new games, and fetches details for each game using Puppeteer.
require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const { saveFile, loadFile, details } = require("../utils");

puppeteer.use(StealthPlugin());

const file = process.env.FILE;
const cacheFile = process.env.CACHE_FILE;
const tempFile = process.env.TEMP_FILE;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);

async function loadCache() {
    try {
        if (!fs.existsSync(cacheFile)) {
            log.warn(`${cacheFile} does not exist, creating empty file…`);
            const defaultCache = {
                pages: 0,
                lastChecked: new Date().toISOString(),
            };
            fs.writeFileSync(cacheFile, JSON.stringify(defaultCache, null, 2));
            return defaultCache;
        }
        const res = fs.readFileSync(cacheFile);
        const cache = JSON.parse(res);
        log.data(
            `Cache loaded. ${new Date(
                cache.lastChecked
            ).toLocaleString()} last checked.`
        );
        return cache;
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
        return { pages: 0, lastChecked: new Date().toISOString() };
    }
}

async function saveCache(cache) {
    try {
        const json = JSON.stringify(cache, null, 2);
        fs.writeFileSync(cacheFile, json);
        log.data(`✅ Saved cache on ${cacheFile}!`);
    } catch (err) {
        log.error(`⚠️ Failed to load ${cacheFile}. Error: ${err.message}`);
    }
}

async function loadComplete() {
    const completeFile = "complete.json";
    try {
        if (!fs.existsSync(completeFile)) {
            log.warn(`⚠️ loadComplete: ${completeFile} does not exist`);
            log.warn("💡 Hint: Run 'npm run fetch' to get the data.");
            return [];
        }
        const res = fs.readFileSync(completeFile);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.link);
        log.data(
            `✅ complete.json loaded correctly! It has ${filtered.length} games.`
        );
        return filtered;
    } catch (err) {
        log.error(`⚠️ Failed to load ${completeFile}. Error: ${err.message}`);
        return [];
    }
}

async function loadTemp() {
    try {
        if (!fs.existsSync(tempFile)) {
            fs.writeFileSync(tempFile, JSON.stringify([]));
            return [];
        }
        const res = fs.readFileSync(tempFile);
        const data = JSON.parse(res);
        return data;
    } catch (err) {
        log.error(`⚠️ Failed to load ${tempFile}. Error: ${err.message}`);
        return [];
    }
}

async function saveTemp(games) {
    try {
        if (!games || games.length === 0) {
            await deleteTemp();
            return;
        }
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(tempFile, json);
        log.data(`Checked games. Remaining ${games.length} games`);
    } catch (err) {
        log.error(`⚠️ Save ${tempFile} failed. Error: ${err.message}`);
    }
}

async function deleteTemp() {
    try {
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
            log.info(`Deleted ${tempFile}`);
        }
    } catch (err) {
        log.error(`⚠️ Failed to delete ${tempFile}. Error: ${err.message}`);
    }
}

async function checkGames(games) {
    const completeGames = await loadComplete();
    const existingGames = await loadFile(file);
    let newGamesCount = 0;
    let tempGames = await loadTemp();

    // Create a Set of normalized links from games.json
    const existingLinks = new Set(existingGames.map((game) => game.link));

    // Log the number of games that are in complete.json but not in games.json
    const uniqueToComplete = completeGames.filter(
        (game) => !existingLinks.has(game.link)
    ).length;
    log.data(`⚠️ ${uniqueToComplete} missing games.`);

    for (const completeGame of completeGames) {
        if (!existingLinks.has(completeGame.link)) {
            let newGame = {
                id: existingGames.length + 1,
                name: completeGame.name,
                link: completeGame.link,
                lastChecked: new Date().toISOString(),
            };
            log.info(`🔎 New game ${newGame.name} found from complete.json`);
            tempGames.push(newGame);
            newGamesCount++;
        } else {
            log.debug("Game already exists in games.json", {
                name: completeGame.name,
                link: completeGame.link,
            });
        }
    }

    if (newGamesCount > 0) {
        await saveTemp(tempGames);
        log.info(`Saved ${newGamesCount} new games to ${tempFile}`);
    }

    log.data(
        `${existingGames.length} in games.json. ${newGamesCount} new games added to temp.json, total in temp.json: ${tempGames.length}. You're missing ${uniqueToComplete} games.`
    );

    return { games: existingGames, tempGames };
}

async function processTempGames(games, browser) {
    let tempGames = await loadTemp();
    if (tempGames.length === 0) {
        log.info("No games to process in temp.json");
        await deleteTemp();
        return games;
    }

    log.info(`Processing ${tempGames.length} games from temp.json`);
    for (let i = 0; i < tempGames.length; i++) {
        log.info(`🔎 scraping details for ${tempGames[i].name}`);
        const [updatedGame, verified] = await details(tempGames[i], browser);
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
            lastChecked: updatedGame.lastChecked || new Date().toISOString(),
        };

        if (
            newGame.verified ||
            newGame.size > 0 ||
            newGame.magnet ||
            Object.keys(newGame.direct).length > 0
        ) {
            games.push(newGame);
            await saveFile(newGame, file, { isSingleGame: true });
            log.info(`${newGame.name} game saved.`, {
                link: newGame.link,
                size: newGame.size,
                date: newGame.date.toISOString(),
                tags: newGame.tags,
                creator: newGame.creator,
                magnet: newGame.magnet ? "present" : "absent",
                direct:
                    Object.keys(newGame.direct).length > 0
                        ? "present"
                        : "absent",
                verified: newGame.verified,
            });
        } else {
            log.warn("skipping save: incomplete game data", {
                name: newGame.name,
                link: newGame.link,
                verified: newGame.verified,
                size: newGame.size,
            });
        }

        tempGames.splice(i, 1);
        i--;
        await saveTemp(tempGames);
    }

    if (tempGames.length === 0) {
        await deleteTemp();
    }

    return games;
}

async function checkRedirectsAndClean(browser) {
    try {
        const games = await loadFile(file);
        const completeGames = await loadComplete();
        const completeLinks = new Set(completeGames.map((game) => game.link));
        const gamesLinks = new Set(games.map((game) => game.link));

        // Find games in games.json not in complete.json
        const uniqueToGames = games.filter(
            (game) => !completeLinks.has(game.link)
        );

        if (uniqueToGames.length === 0) {
            log.info("No games in games.json that are not in complete.json");
            return games;
        }

        log.info(`Checking ${uniqueToGames.length} games for redirects`);

        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on("request", (request) => {
            request.continue();
        });

        let updatedGames = [...games];
        for (const game of uniqueToGames) {
            try {
                log.info(`Checking URL for ${game.name}: ${game.link}`);
                const response = await page.goto(game.link, {
                    waitUntil: "domcontentloaded",
                    timeout: timeout,
                });

                const finalUrl = response.url();
                if (finalUrl !== game.link) {
                    log.info(
                        `Redirect detected for ${game.name}: ${game.link} -> ${finalUrl}`
                    );
                    if (gamesLinks.has(finalUrl)) {
                        log.info(
                            `Removing ${game.name} as ${finalUrl} already exists in games.json`
                        );
                        updatedGames = updatedGames.filter(
                            (g) => g.link !== game.link
                        );
                    }
                }
            } catch (err) {
                log.error(
                    `Failed to check URL for ${game.name}: ${err.message}`
                );
            }
        }

        await page.close();
        if (updatedGames.length !== games.length) {
            await saveFile(updatedGames, file);
            log.info(
                `Updated games.json, removed ${
                    games.length - updatedGames.length
                } redirected games`
            );
        } else {
            log.info("No games removed after redirect checks");
        }

        return updatedGames;
    } catch (err) {
        log.error(`⚠️ checkRedirectsAndClean failed. Error: ${err.message}`);
        return await loadFile(file);
    }
}

async function countItems() {
    try {
        const games = await loadFile(file);
        const gamesCount = games.length;
        const completeGames = await loadComplete();
        const completeCount = completeGames.length;
        const tempGames = await loadTemp();
        const tempCount = tempGames.length;
        const gamesLinks = new Set(games.map((game) => game.link));
        const completeLinks = new Set(completeGames.map((game) => game.link));

        // Check for duplicates in games.json
        const seenLinks = new Set();
        const duplicates = games.filter((game) => {
            if (seenLinks.has(game.link)) return true;
            seenLinks.add(game.link);
            return false;
        });
        if (duplicates.length > 0) {
            log.warn(
                `Found ${duplicates.length} duplicates in games.json`,
                duplicates
            );
        }

        // Find games in games.json not in complete.json
        const uniqueToGames = games.filter(
            (game) => !completeLinks.has(game.link)
        );
        if (uniqueToGames.length > 0) {
            log.info(
                `Found ${uniqueToGames.length} games in games.json not in complete.json`,
                uniqueToGames
            );
        } else {
            log.info(
                `No games found in games.json that are not in complete.json`
            );
        }

        // Find games in complete.json not in games.json
        const uniqueToComplete = completeGames.filter(
            (game) => !gamesLinks.has(game.link)
        );

        log.data(
            `🔥 ${gamesCount} on games.json (${seenLinks.size} unique) and ${
                games.filter((g) => g.verified).length
            } verified.`
        );
        log.data(`✨ ${completeCount} on complete.json`);
        log.data(`📝 ${tempCount} on temp.json`);
        log.data(
            `⚠️ ${uniqueToComplete.length} missing games:`,
            uniqueToComplete
        );

        return {
            gamesCount,
            completeCount,
            tempCount,
            uniqueToComplete: uniqueToComplete.length,
            uniqueToGames: uniqueToGames.length,
        };
    } catch (err) {
        log.error(`⚠️ Count items failed. Error: ${err.message}`);
        return {
            gamesCount: 0,
            completeCount: 0,
            tempCount: 0,
            uniqueToComplete: 0,
            uniqueToGames: 0,
        };
    }
}

async function main() {
    // Validate environment variables
    if (!file || !maxRetries || !retryDelay || !timeout) {
        log.error("Missing required environment variables", {
            FILE: file,
            MAX_RETRIES: maxRetries,
            RETRY_DELAY: retryDelay,
            TIMEOUT: timeout,
        });
        process.exit(1);
    }

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

    try {
        let games = await loadFile(file);
        log.info(`Loaded ${games.length} games from ${file}`);
        const cache = await loadCache();

        // Check for redirects and clean games.json
        games = await checkRedirectsAndClean(browser);
        log.info(
            `After redirect check, ${games.length} games remain in games.json`
        );

        let tempGames = await loadTemp();
        let finalGames;

        if (tempGames.length === 0) {
            log.info("‼️ No temp.json found or empty, running update...");
            const { games: updatedGames, tempGames: updatedTempGames } =
                await checkGames(games);
            log.info(`Update completed. 🔎 Found ${updatedTempGames.length}`);
            finalGames = await processTempGames(updatedGames, browser);
        } else {
            log.info(`🪄  temp.json found with games, processing directly...`);
            finalGames = await processTempGames(games, browser);
        }

        cache.lastChecked = new Date().toISOString();
        await saveCache(cache);
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.includes("--count-items")) {
        countItems().then(() => process.exit());
    } else {
        main();
    }
} else {
    exports.loadCache = loadCache;
    exports.saveCache = saveCache;
    exports.countItems = countItems;
    exports.loadTemp = loadTemp;
    exports.saveTemp = saveTemp;
    exports.deleteTemp = deleteTemp;
    exports.processTempGames = processTempGames;
    exports.checkRedirectsAndClean = checkRedirectsAndClean;
}
