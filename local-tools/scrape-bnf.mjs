#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const BNF_BASE_URL = "https://catalogue.bnf.fr";

function parseArgs(argv) {
  const options = {
    file: path.join(cwd, "index.html"),
    limit: 10,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--file") {
      options.file = path.resolve(cwd, argv[index + 1]);
      index += 1;
      continue;
    }

    if (value === "--limit") {
      options.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }

    if (value === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (value === "--help" || value === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node local-tools/scrape-bnf.mjs
  node local-tools/scrape-bnf.mjs --limit 10
  node local-tools/scrape-bnf.mjs --limit 10 --dry-run

Options:
  --file      Fichier HTML a mettre a jour (defaut: index.html)
  --limit     Nombre maximal d'ouvrages a scrapper (defaut: 10)
  --dry-run   N'ecrit pas le fichier, affiche seulement le resultat
  --help      Affiche cette aide`);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractFieldInnerHtml(entryHtml, fieldName) {
  const pattern = new RegExp(`<div class="bibliographie-entry__value" data-field="${fieldName}">([\\s\\S]*?)<\\/div>`);
  const match = entryHtml.match(pattern);
  return match ? match[1] : "";
}

function extractAnyFieldInnerHtml(entryHtml, fieldName) {
  const pattern = new RegExp(`<([a-z0-9-]+)(?:\\s+[^>]*?)?data-field="${fieldName}"(?:\\s+[^>]*?)?>([\\s\\S]*?)<\\/\\1>`, "i");
  const match = entryHtml.match(pattern);
  return match ? match[2] : "";
}

function replaceFieldInnerHtml(entryHtml, fieldName, newInnerHtml) {
  const pattern = new RegExp(`(<div class="bibliographie-entry__value" data-field="${fieldName}">)([\\s\\S]*?)(<\\/div>)`);
  return entryHtml.replace(pattern, `$1${newInnerHtml}$3`);
}

function isSearchableTitle(title) {
  if (!title) {
    return false;
  }

  if (title.length < 5) {
    return false;
  }

  if (/^[-,./\\\s]+$/.test(title)) {
    return false;
  }

  if (/^-\//.test(title) || title.includes("DTD HTML")) {
    return false;
  }

  return /[\p{L}\p{N}]/u.test(title);
}

function scoreTitleCandidate(title) {
  let score = 0;

  if (/^[\p{L}\p{N}]/u.test(title)) {
    score += 5;
  }

  if (/^["'(\[]?[\p{L}\p{N}]/u.test(title)) {
    score += 3;
  }

  const wordCount = (title.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  score += Math.min(wordCount, 6);

  if (!/[.]{2,}|[-]{2,}/.test(title)) {
    score += 2;
  }

  if (!/^[^A-Za-zÀ-ÿ0-9]+/.test(title)) {
    score += 2;
  }

  if (title.length >= 12 && title.length <= 180) {
    score += 2;
  }

  if (/^\(?Disponible à la BNF\)?$/i.test(title)) {
    score -= 10;
  }

  return score;
}

function buildBnfSearchUrl(title) {
  const url = new URL("/rechercher.do", BNF_BASE_URL);
  url.searchParams.set("motRecherche", title);
  url.searchParams.set("critereRecherche", "0");
  url.searchParams.set("depart", "0");
  return url.toString();
}

function extractBnfNoticeLinks(searchHtml) {
  const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>/gi;
  const links = [];

  for (const match of searchHtml.matchAll(linkPattern)) {
    const href = decodeHtmlEntities(match[1]);

    try {
      const absoluteUrl = new URL(href, BNF_BASE_URL);
      if (
        absoluteUrl.hostname === "catalogue.bnf.fr" &&
        absoluteUrl.pathname.startsWith("/ark:/12148/")
      ) {
        links.push(absoluteUrl.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return [...new Set(links)];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "biblio-amhe-bnf-scraper/1.0",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Echec HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function buildLinksHtml(links) {
  if (links.length === 0) {
    return '<span class="bibliographie-empty">-</span>';
  }

  return links
    .map((link) => `<a href="${escapeHtml(link)}">catalogue.bnf.fr</a>`)
    .join(" | ");
}

function formatDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function collectEntries(html) {
  const matches = [...html.matchAll(/<article class="bibliographie-entry">[\s\S]*?<\/article>/g)];

  return matches.map((match, entryIndex) => {
    const entryHtml = match[0];
    const title = stripHtml(extractAnyFieldInnerHtml(entryHtml, "titre"));
    const lastScrapeDate = stripHtml(extractFieldInnerHtml(entryHtml, "date-scrapping-bnf"));

    return {
      entryIndex,
      title,
      lastScrapeDate,
      html: entryHtml,
      start: match.index ?? 0,
      end: (match.index ?? 0) + entryHtml.length,
    };
  });
}

async function scrapeEntry(entry, dateString) {
  const searchUrl = buildBnfSearchUrl(entry.title);
  const searchHtml = await fetchText(searchUrl);
  const links = extractBnfNoticeLinks(searchHtml);

  let updatedHtml = entry.html;
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "liens-bnf", buildLinksHtml(links));
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "date-scrapping-bnf", escapeHtml(dateString));

  return {
    ...entry,
    html: updatedHtml,
    searchUrl,
    links,
  };
}

function applyEntryUpdates(originalHtml, updates) {
  let updatedHtml = originalHtml;

  for (const update of updates) {
    updatedHtml =
      updatedHtml.slice(0, update.start) +
      update.html +
      updatedHtml.slice(update.end);
  }

  return updatedHtml;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("L'option --limit doit etre un entier superieur ou egal a 1.");
  }

  const sourceHtml = await readFile(options.file, "utf8");
  const dateString = formatDate();
  const entries = collectEntries(sourceHtml);
  const candidates = entries
    .filter((entry) => isSearchableTitle(entry.title))
    .filter((entry) => entry.lastScrapeDate !== dateString)
    .map((entry) => ({ ...entry, score: scoreTitleCandidate(entry.title) }))
    .sort((left, right) => right.score - left.score || left.entryIndex - right.entryIndex)
    .slice(0, options.limit);

  if (candidates.length === 0) {
    console.log("Aucun ouvrage exploitable trouve dans le fichier.");
    return;
  }

  const updates = [];

  for (const entry of candidates) {
    console.log(`Recherche BNF: ${entry.title}`);
    const updatedEntry = await scrapeEntry(entry, dateString);
    updates.push(updatedEntry);
    console.log(`  ${updatedEntry.links.length} lien(s) catalogue BNF`);
    if (updates.length < candidates.length) {
      console.log("  Pause de 2 secondes avant la prochaine requete BnF");
      await sleep(2000);
    }
  }

  const nextHtml = applyEntryUpdates(sourceHtml, [...updates].reverse());

  if (!options.dryRun) {
    await writeFile(options.file, nextHtml, "utf8");
  }

  console.log("");
  console.log(`Date de scrapping appliquee: ${dateString}`);
  console.log(`Ouvrages traites: ${updates.length}`);

  for (const update of updates) {
    console.log(`- ${normalizeWhitespace(update.title)} -> ${update.links.length} lien(s)`);
    console.log(`  Recherche: ${update.searchUrl}`);
    for (const link of update.links) {
      console.log(`  ${link}`);
    }
  }

  if (options.dryRun) {
    console.log("");
    console.log("Mode dry-run: index.html n'a pas ete modifie.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
