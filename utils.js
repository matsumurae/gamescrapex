const log = require("@vladmandic/pilogger");
const fs = require("fs");

const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);

// Configure page with common settings
async function configurePage(page) {
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    );

    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
    });

    await page.setViewport({ width: 1366, height: 768 });

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
            get: () => false,
        });

        Object.defineProperty(navigator, "language", {
            get: () => "en-US",
        });
        Object.defineProperty(navigator, "languages", {
            get: () => ["en-US", "en"],
        });

        Object.defineProperty(navigator, "plugins", {
            get: () => [1, 2, 3, 4, 5],
        });

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter) {
            if (parameter === 37445) return "Intel";
            if (parameter === 37446) return "Intel Iris OpenGL Engine";
            return getParameter.call(this, parameter);
        };

        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === "notifications"
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);
    });
}

// Fetch HTML content of a URI using Puppeteer with retries
async function fetchHtml(uri, browser, attempt = 1) {
    let page = null;
    try {
        page = await browser.newPage();
        await configurePage(page);
        await page.goto(uri, { waitUntil: "networkidle2", timeout });
        const html = await page.content();
        await page.close();
        return html;
    } catch (err) {
        if (
            err.message.includes("Navigation timeout") ||
            err.message.includes("net::ERR_CONNECTION_REFUSED") ||
            err.message.includes("net::ERR_CONNECTION_RESET")
        ) {
            log.warn(
                `Navigation attempt failed for ${uri}. Error: ${err.message}`
            );
            if (attempt === maxRetries) {
                log.error(`All retries failed for ${uri}`);
                if (page) {
                    await page.close();
                }
                return "";
            }
            log.info(`Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`, {
                uri,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return fetchHtml(uri, browser, attempt + 1);
        } else {
            if (page) {
                await page.close();
            }
            throw err;
        }
    }
}

// Load game database from JSON
async function loadFile(file, logMessage = null) {
    try {
        if (!fs.existsSync(file)) {
            log.warn(`${file} does not exist, creating empty file…`);
            fs.writeFileSync(file, JSON.stringify([]));
            return [];
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.id);
        const today = new Date().toISOString().split("T")[0];
        let notChecked = 0;

        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
            if (game.lastChecked && game.lastChecked.split("T")[0] !== today) {
                notChecked++;
            }
        }

        log.data(`🌀 Loading JSON, wait a sec…`);
        return filtered;
    } catch (err) {
        log.error(`⚠️  Failed to load ${file}. Error: ${err.message}`);
        return [];
    }
}

// Save game database to JSON
async function saveFile(data, file, options = {}) {
    try {
        const { logMessage, isSingleGame = false } = options;
        let games = [];

        if (isSingleGame) {
            if (fs.existsSync(file)) {
                const existingData = fs.readFileSync(file, "utf8");
                games = JSON.parse(existingData);
            }

            if (!games.find((g) => g.link === data.link)) {
                games.push(data);
                fs.writeFileSync(file, JSON.stringify(games, null, 2));
                log.info(`🔥 Saved ${data.name} to ${file}`);
            } else {
                log.debug(`‼️ ${data.name} game already exists. Skipping…`);
                return;
            }
        } else {
            // Deduplicate by link
            const seenLinks = new Set();
            games = data.filter((game) => {
                if (!seenLinks.has(game.link)) {
                    seenLinks.add(game.link);
                    return true;
                }
                log.debug(
                    `‼️ Duplicate game ${game.name} with link ${game.link} skipped`
                );
                return false;
            });

            fs.writeFileSync(file, JSON.stringify(games, null, 2));

            const today = new Date().toISOString().split("T")[0];
            const notChecked = games.filter(
                (g) => !g.lastChecked || g.lastChecked.split("T")[0] !== today
            ).length;

            const defaultLogMessage = `✅ Saved ${file}. ${games.length} games, ${notChecked} not checked today`;
            const finalLogMessage = logMessage || defaultLogMessage;

            log.data(
                finalLogMessage,
                logMessage
                    ? {}
                    : {
                          ddlLinks: games.filter(
                              (g) =>
                                  g.direct && Object.keys(g.direct).length > 0
                          ).length,
                      }
            );
        }
    } catch (err) {
        log.error(`⚠️ Save file ${file} failed. Error: ${err.message}`);
    }
}

async function loadCache(file) {
    try {
        if (!fs.existsSync(file)) {
            log.warn(`${file} does not exist, creating empty file…`);
            const defaultCache = {
                pages: 0,
                lastChecked: new Date().toISOString(),
            };
            fs.writeFileSync(file, JSON.stringify(defaultCache, null, 2));
            return defaultCache;
        }
        const res = fs.readFileSync(file);
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

async function saveCache(data, file) {
    try {
        const json = JSON.stringify(data, null, 2);
        fs.writeFileSync(file, json);
        log.data(`✅ Saved cache on ${file}!`);
    } catch (err) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
    }
}

// Load progress from JSON
async function loadProgress(file) {
    try {
        if (!fs.existsSync(file)) {
            log.warn(
                "loadProgress: progress file does not exist, starting from 1"
            );
            const defaultProgress = {
                lastCheckedIndex: 1,
            };
            fs.writeFileSync(file, JSON.stringify(defaultProgress, null, 2));
            return defaultProgress;
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        log.data(
            `🌀 Loading progress… Last checked was ${data.lastCheckedIndex}`
        );
        return data;
    } catch (err) {
        log.error(`⚠️ Failed to load ${progressFile}. Error: ${err.message}`);
        return { lastCheckedIndex: 0 };
    }
}

// Save progress to JSON
async function saveProgress(file, index) {
    try {
        const json = JSON.stringify({ lastCheckedIndex: index }, null, 2);
        fs.writeFileSync(file, json);
        log.data(`✅ Saving progress. Last check: ${index}`);
    } catch (err) {
        log.error(`⚠️ Save progress ${file} failed. Error: ${err.message}`);
    }
}

async function loadTemp(file, createIfMissing = true) {
    try {
        if (!fs.existsSync(file)) {
            if (createIfMissing) {
                fs.writeFileSync(file, JSON.stringify([]));
                log.info(`${file} created with empty array`);
            } else {
                log.warn(`${file} does not exist, returning empty array`);
            }
            return [];
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        return data;
    } catch (err) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
        return [];
    }
}

async function saveTemp(games, file) {
    try {
        if (!games || games.length === 0) {
            await deleteTemp();
            return;
        }
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(file, json);
        log.data(`Checked games. Remaining ${games.length} games`);
    } catch (err) {
        log.error(`⚠️ Save temp ${file} failed. Error: ${err.message}`);
    }
}

async function deleteTemp(file) {
    try {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            log.info(`Deleted ${file}`);
        }
    } catch (err) {
        log.error(`⚠️ Failed to delete ${file}. Error: ${err.message}`);
    }
}

module.exports = {
    configurePage,
    fetchHtml,
    loadFile,
    saveFile,
    saveCache,
    loadCache,
    loadProgress,
    saveProgress,
    saveTemp,
    loadTemp,
    deleteTemp,
};
