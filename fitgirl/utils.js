const log = require("@vladmandic/pilogger");

const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);

const { configurePage } = require("../utils");

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
    details,
};
