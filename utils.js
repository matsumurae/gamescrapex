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
    // Optional: Emulate a real browser viewport
    await page.setViewport({ width: 1366, height: 768 });
    // Optional: Disable WebGL and other features that might trigger detection
    await page.evaluateOnNewDocument(() => {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (parameter) {
            if (parameter === 37445) return "Intel";
            if (parameter === 37446) return "Intel Iris OpenGL Engine";
            return getParameter(parameter);
        };
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
        log.error(`⚠️ Save ${file} failed. Error: ${err.message}`);
    }
}

// Fetch detailed game information from a game's page
async function details(game, browser) {
    let page = null;

    try {
        page = await browser.newPage();
        await configurePage(page);

        // Retry navigation on timeout or specific errors
        let attempt = 1;
        while (attempt <= maxRetries) {
            try {
                await page.goto(game.link, {
                    waitUntil: "domcontentloaded",
                    timeout,
                });
                break;
            } catch (err) {
                if (
                    err.message.includes("Navigation timeout") ||
                    err.message.includes("net::ERR_CONNECTION_REFUSED") ||
                    err.message.includes("net::ERR_CONNECTION_RESET")
                ) {
                    log.warn(
                        `Navigation attempt failed for ${game.name}. Error: ${err.message}`
                    );
                    if (attempt === maxRetries) {
                        log.error(`All retries failed for ${game.name}`);
                        await page.close();
                        return [game, false];
                    }
                    log.info(
                        `Retrying ${game.name} (attempt ${
                            attempt + 1
                        }/${maxRetries})`
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );
                    attempt++;
                } else {
                    throw err;
                }
            }
        }

        const date = await page.evaluate(() => {
            const dateEl = document.querySelector("time.entry-date");
            return dateEl?.getAttribute("datetime") || null;
        });
        game.date = date ? new Date(date) : new Date();

        const contentText = await page.evaluate(() => {
            const content = document.querySelector(
                ".entry-content, .post-content, article, .content"
            );
            return content
                ? content.textContent.replace(/\n+/g, "\n").split("\n")
                : [];
        });
        if (!contentText.length) {
            log.warn("details: no content found", {
                id: game.id,
                game: game.name,
            });
            await page.close();
            return [game, false];
        }

        for (const line of contentText) {
            if (line.match(/genres|tags/i))
                game.tags = line
                    .replace(/.*:/, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/compan(y|ies)/i))
                game.creator = line
                    .replace(/.*compan(y|ies).*?:/i, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/original size/i))
                game.original = line.replace(/.*original size.*?:/i, "").trim();
            if (line.match(/repack size/i))
                game.packed = line
                    .replace(/.*repack size.*?:/i, "")
                    .replace(/\[.*\]/, "")
                    .trim();
        }

        const packed = game.packed
            ? Number(
                  game.packed.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] || 0
              )
            : 0;
        const original = game.original
            ? Number(
                  game.original.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] ||
                      0
              )
            : 0;
        game.size = Math.max(packed, original);
        if (game?.size > 0 && game.original?.includes("MB")) game.size /= 1024;

        game.direct = await page.evaluate(() => {
            const directLinks = {};
            const ddl = Array.from(document.querySelectorAll("h3")).find((el) =>
                el.textContent.includes("Download Mirrors (Direct Links)")
            );
            if (ddl) {
                const ul =
                    Array.from(ddl.parentElement.children).find(
                        (el) => el.tagName === "UL" && el !== ddl
                    ) || null;
                if (ul) {
                    const items = ul.querySelectorAll("li");
                    for (const item of items) {
                        const text = item.textContent.toLowerCase();
                        let host = null;
                        if (text.includes("datanodes")) {
                            host = "datanodes";
                        } else if (text.includes("fuckingfast")) {
                            host = "fuckingfast";
                        }
                        if (host) {
                            directLinks[host] = directLinks[host] || [];
                            const spoilerContent = item.querySelector(
                                ".su-spoiler-content"
                            );
                            if (spoilerContent) {
                                const spoilerLinks = Array.from(
                                    spoilerContent.querySelectorAll("a")
                                ).map((a) => a.href);
                                directLinks[host].push(...spoilerLinks);
                            }
                        }
                    }
                }
            }
            return directLinks;
        });

        const magnet = await page.evaluate(() => {
            const href = document.querySelector('a[href*="magnet"]');
            return href ? href.getAttribute("href") : null;
        });
        if (magnet) game.magnet = magnet;

        // Set verified to true only if both magnet and size > 0 exist
        game.verified = !!(game.magnet && game.size > 0);
        game.lastChecked = new Date().toISOString();

        log.data(`${game.name} added.`, {
            link: game.link,
            size: game.size,
            direct: game.direct,
            magnet: game.magnet,
        });

        await page.close();
        return [game, game.verified];
    } catch (err) {
        log.warn("details error", {
            id: game.id,
            game: game.name,
            error: err.message,
        });
        if (page) await page.close();
        return [game, false];
    }
}

module.exports = {
    configurePage,
    fetchHtml,
    loadFile,
    saveFile,
    details,
};
