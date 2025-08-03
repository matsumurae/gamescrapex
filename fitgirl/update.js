// Check if dates changed on website and update magnet and DDL links
require("dotenv").config();

const log = require("@vladmandic/pilogger");
const {
    fetchHtml,
    loadFile,
    saveFile,
    loadProgress,
    saveProgress,
    getPuppeteer,
} = require("../utils");

const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const progressFile = "progress.json";
const file = process.env.FILE;

async function checkTimestampsAgainstWebsite(
    fix = false,
    attempt = 1,
    startIndex = null
) {
    const games = await loadFile(file);
    const progress = await loadProgress(progressFile);
    let startFrom =
        startIndex !== null ? startIndex : progress.lastCheckedIndex;
    if (startFrom >= games.length) {
        log.info("No games left to check, resetting progress", {
            startFrom,
            totalGames: games.length,
        });
        startFrom = 0;
        await saveProgress(progressFile, 0);
    }

    let mismatchCount = 0;
    let invalidJsonDateCount = 0;
    let noWebsiteDateCount = 0;
    let fixedCount = 0;
    let matchCount = 0;
    let dataChangesCount = 0;
    let skippedCount = 0;
    const today = new Date().toISOString().split("T")[0];

    const browser = await getPuppeteer(timeout);

    try {
        for (let i = startFrom; i < games.length; i++) {
            const game = games[i];

            if (game.lastChecked && game.lastChecked.split("T")[0] === today) {
                skippedCount++;
                await saveProgress(progressFile, i + 1);
                continue;
            }

            const jsonDate = game.date ? new Date(game.date) : null;

            if (!jsonDate || isNaN(jsonDate.getTime())) {
                log.warn(`invalid JSON date on ${game.name}`);
                invalidJsonDateCount++;
            }

            let page = null;
            try {
                page = await browser.newPage();
                const htmlContent = await fetchHtml(game.link, browser);
                if (!htmlContent) {
                    log.warn("no content retrieved", {
                        id: game.id,
                        game: game.name,
                        link: game.link,
                    });
                    noWebsiteDateCount++;
                    await saveProgress(progressFile, i + 1);
                    continue;
                }

                await page.setContent(htmlContent);

                const websiteDate = await page.evaluate(() => {
                    const dateEl = document.querySelector("time.entry-date");
                    return dateEl && dateEl.getAttribute("datetime")
                        ? dateEl.getAttribute("datetime")
                        : null;
                });

                if (!websiteDate) {
                    log.warn(`no date found on website for ${game.name}`);
                    noWebsiteDateCount++;
                    if (page) await page.close();
                    await saveProgress(progressFile, i + 1);
                    continue;
                }

                const parsedWebsiteDate = new Date(websiteDate);
                if (isNaN(parsedWebsiteDate.getTime())) {
                    log.warn("invalid website date", {
                        id: game.id,
                        game: game.name,
                        websiteDate,
                    });
                    noWebsiteDateCount++;
                    if (page) await page.close();
                    await saveProgress(progressFile, i + 1);
                    continue;
                }

                const jsonDateStr = jsonDate
                    ? jsonDate.toISOString().split(".")[0]
                    : null;
                const websiteDateStr = parsedWebsiteDate
                    .toISOString()
                    .split(".")[0];
                let dataChanges = null;

                if (jsonDateStr !== websiteDateStr) {
                    log.warn("date mismatch", {
                        id: game.id,
                        game: game.name,
                        jsonDate: game.date,
                        websiteDate,
                    });
                    mismatchCount++;

                    games[i] = {
                        ...game,
                        date: parsedWebsiteDate,
                        lastChecked: new Date().toISOString(),
                    };
                    fixedCount++;
                    log.info(
                        `${game.name} updated. ${parsedWebsiteDate} new date.`
                    );
                    await saveFile(games, file);

                    const websiteData = await page.evaluate(() => {
                        const directLinks = {};
                        const magnet =
                            Array.from(
                                document.querySelectorAll("a[href^='magnet:']")
                            ).map((a) => a.href)[0] || null;

                        const ddl = Array.from(
                            document.querySelectorAll("h3")
                        ).find((el) =>
                            el.textContent.includes(
                                "Download Mirrors (Direct Links)"
                            )
                        );
                        if (ddl) {
                            const ULElement =
                                Array.from(ddl.parentElement.children).find(
                                    (el) => el.tagName === "UL" && el !== ddl
                                ) || null;
                            if (ULElement) {
                                const items = ULElement.querySelectorAll("li");
                                for (const item of items) {
                                    const text = item.textContent.toLowerCase();
                                    let host = null;
                                    if (text.includes("datanodes"))
                                        host = "datanodes";
                                    else if (text.includes("fuckingfast"))
                                        host = "fuckingfast";
                                    if (host) {
                                        directLinks[host] =
                                            directLinks[host] || [];
                                        const spoilerContent =
                                            item.querySelector(
                                                ".su-spoiler-content"
                                            );
                                        if (spoilerContent) {
                                            const spoilerLinks = Array.from(
                                                spoilerContent.querySelectorAll(
                                                    "a"
                                                )
                                            ).map((a) => a.href);
                                            directLinks[host].push(
                                                ...spoilerLinks
                                            );
                                        }
                                    }
                                }
                            }
                        }

                        return { magnet, direct: directLinks };
                    });

                    dataChanges = {};
                    if (game.magnet !== websiteData.magnet) {
                        dataChanges.magnet = {
                            json: game.magnet,
                            website: websiteData.magnet,
                        };
                    }
                    if (
                        JSON.stringify(game.direct || {}) !==
                        JSON.stringify(websiteData.direct)
                    ) {
                        dataChanges.direct = {
                            json: game.direct || {},
                            website: websiteData.direct,
                        };
                    }

                    if (Object.keys(dataChanges).length > 0) {
                        dataChangesCount++;
                        log.warn("game data changed", {
                            id: game.id,
                            game: game.name,
                            changes: dataChanges,
                        });
                        games[i] = {
                            ...games[i],
                            magnet: websiteData.magnet,
                            direct: websiteData.direct,
                        };
                        log.info(`${game.name} updated. New data:`, {
                            magnet: websiteData.magnet,
                            direct: websiteData.direct,
                        });
                        await saveFile(games, file);
                    }

                    if (fix) {
                        log.info(`${game.name} fixed`);
                    }
                } else {
                    log.debug("date match", {
                        id: game.id,
                        game: game.name,
                        date: game.date,
                    });
                    games[i] = {
                        ...game,
                        lastChecked: new Date().toISOString(),
                    };
                    await saveFile(games, file);
                    matchCount++;
                }

                if (page) await page.close();
                await saveProgress(progressFile, i + 1);
            } catch (err) {
                log.warn("error processing website", {
                    id: game.id,
                    game: game.name,
                    error: err.message,
                    attempt,
                });
                if (page) {
                    try {
                        await page.close();
                    } catch (closeErr) {
                        log.warn(
                            `‼️ Error closing page. Error: ${closeErr.message}`
                        );
                    }
                }
                if (attempt < maxRetries) {
                    log.info(
                        `Retrying ${game.link} (attempt ${
                            attempt + 1
                        }/${maxRetries})`
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );
                    return await checkTimestampsAgainstWebsite(
                        fix,
                        attempt + 1,
                        i
                    );
                }
                await saveProgress(progressFile, i + 1);
                continue;
            }
        }

        await saveProgress(progressFile, 0);
        log.info("All games processed, progress reset", {
            totalGames: games.length,
        });

        log.data(
            `From ${games.length}: ${mismatchCount} were wrong. ${invalidJsonDateCount} had invalid JSON date. ${noWebsiteDateCount} doesn't have date on website. ${fixedCount} were fixed. ${skippedCount} were skipped.`
        );

        return {
            total: games.length,
            matched: matchCount,
            mismatched: mismatchCount,
            invalidJson: invalidJsonDateCount,
            noWebsite: noWebsiteDateCount,
            fixed: fixedCount,
            dataChanges: dataChangesCount,
            skipped: skippedCount,
            startedFromIndex: startFrom,
        };
    } finally {
        await browser.close();
    }
}

async function main() {
    // log.configure({ inspect: { breakLength: 500 } });
    // log.headerJson();

    // Check timestamps and game data against website
    const timestampResults = await checkTimestampsAgainstWebsite(false); // Set to true to fix additional data if needed
    if (timestampResults.mismatched > 0 || timestampResults.invalidJson > 0) {
        log.info(
            "Timestamp or data issues detected. Run with fix=true or --fix for additional fixes."
        );
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let startIndex = null;
    const indexArg = args.find((arg) => arg.startsWith("--start-index="));
    if (indexArg) {
        startIndex = parseInt(indexArg.split("=")[1], 10);
        if (isNaN(startIndex) || startIndex < 0) {
            log.error("Invalid --start-index value, starting from 0");
            startIndex = null;
        }
    }

    if (args.includes("--check-timestamps")) {
        checkTimestampsAgainstWebsite(
            args.includes("--fix"),
            1,
            startIndex
        ).then(() => process.exit());
    } else {
        main();
    }
} else {
    exports.loadFile = loadFile;
    exports.saveFile = saveFile;
    exports.loadProgress = loadProgress;
    exports.saveProgress = saveProgress;
    exports.checkTimestampsAgainstWebsite = checkTimestampsAgainstWebsite;
    exports.fetchHtml = fetchHtml;
}
