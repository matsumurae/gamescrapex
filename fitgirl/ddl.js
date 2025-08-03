// This code was made to add the DDL links from FuckingFast and Datanodes to the FitGirl repacks database.
// It uses Puppeteer to scrape the FitGirl repacks site and extract direct download links.
// This was made because: the original code doesn't check already verified games, it doesn't retry on failure, and it doesn't save the direct links to the database.
require("dotenv").config();

const log = require("@vladmandic/pilogger");
const {
    configurePage,
    fetchHtml,
    saveFile,
    loadFile,
    getPuppeteer,
} = require("../utils");

// Configurable
const maxRetries = parseInt(process.env.MAX_RETRIES);
const timeout = parseInt(process.env.TIMEOUT);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const file = process.env.FILE;

async function fetchDirectLinks(game, browser, attempt = 1) {
    if (!game.verified || game.direct) return [game, false]; // Skip if not verified or already has direct links
    let page = null;
    try {
        page = await browser.newPage();
        await configurePage(page);
        const htmlContent = await fetchHtml(game.link, browser, attempt);
        if (!htmlContent) {
            log.warn("no content retrieved", {
                id: game.id,
                game: game.name,
                link: game.link,
            });
            await page.close();
            return [game, false];
        }

        await page.setContent(htmlContent);

        // Get direct links without modifying game directly
        const directLinks = await page.evaluate(() => {
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
            return directLinks || null;
        });

        // Create new game object with direct links
        const updatedGame = { ...game, direct: directLinks };

        log.data(
            `Fetched links for ${game.name}. DDL: ${JSON.stringify(
                directLinks
            )}`
        );

        if (!directLinks) {
            log.debug(`No direct links found for ${game.name}`);
        }

        await page.close();
        return [updatedGame, !!directLinks];
    } catch (err) {
        log.warn("fetchDirectLinks error", {
            id: game.id,
            game: game.name,
            error: err.message,
            attempt,
        });
        if (page) {
            try {
                await page.close();
            } catch (closeErr) {
                log.warn(`‼️ Error closing page. Error: ${closeErr.message}`);
            }
        }
        if (attempt < maxRetries) {
            log.info(
                `Retrying ${game.link} (attempt ${attempt + 1}/${maxRetries})`
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return fetchDirectLinks(game, browser, attempt + 1);
        }
        return [game, false];
    }
}

// Main function to update direct links
async function main() {
    // log.configure({ inspect: { breakLength: 500 } });
    // log.headerJson();

    const browser = await getPuppeteer(timeout);

    try {
        const games = await loadFile(file);
        let updatedCount = 0;
        for (let i = 0; i < games.length; i++) {
            const [game, updated] = await fetchDirectLinks(games[i], browser);
            games[i] = game;
            if (updated) {
                updatedCount++;
                await saveFile(games, file);
            }
        }
        log.data(
            `✅ Fetching complete! ${games.length} games updated, ${updatedCount} DDL links added.`
        );
        if (updatedCount === 0) {
            log.info("🎉 Congrats! No games needed direct link updates!");
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
} else {
    exports.load = load;
    exports.save = save;
    exports.fetchDirectLinks = fetchDirectLinks;
}
