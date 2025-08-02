// This search games inside the JSON file
// It can be used to find a specific game or to show the newest/largest games
// Usage: node run find <search-term>
require("dotenv").config();

const process = require("process");
const log = require("@vladmandic/pilogger");
const { loadFile } = require("../utils");

const maxResults = 40;
const file = process.env.FILE;

async function main() {
    // log.configure({ inspect: { breakLength: 500 } });
    // log.headerJson();

    const games = (await loadFile(file)).map(
        ({ name, size, date, tags, link }) => ({
            name,
            size,
            date,
            tags: tags?.join(" ") || "",
            link,
        })
    );

    const searchTerm = process.argv[2]?.toLowerCase();
    if (searchTerm) {
        const found = games
            .filter(
                (game) =>
                    game.name?.toLowerCase().includes(searchTerm) ||
                    game.tags?.toLowerCase().includes(searchTerm)
            )
            .sort((a, b) => b.date - a.date)
            .slice(0, maxResults);
        log.data({ search: searchTerm, results: found });
    } else {
        const newest = games
            .sort((a, b) => b.date - a.date)
            .slice(0, maxResults);
        const largest = games
            .sort((a, b) => b.size - a.size)
            .slice(0, maxResults);
        log.data({ newest, largest });
    }
}

main().catch((error) => log.error("Main error:", error.message));
