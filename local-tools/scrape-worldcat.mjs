#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const WORLDCAT_BASE_URL = "https://search.worldcat.org";
const JINA_WORLDcat_PREFIX = "https://r.jina.ai/http://search.worldcat.org";
const HTTP_DELAY_MS = 2000;

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
  node local-tools/scrape-worldcat.mjs
  node local-tools/scrape-worldcat.mjs --limit 10
  node local-tools/scrape-worldcat.mjs --limit 10 --dry-run

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

function hasField(entryHtml, fieldName) {
  return new RegExp(`data-field="${fieldName}"`).test(entryHtml);
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

  return score;
}

function cleanAuthor(author) {
  if (!author) {
    return "";
  }

  const normalized = normalizeWhitespace(author);
  if (/^anonyme$/i.test(normalized)) {
    return "";
  }

  return normalized;
}

function normalizeSearchText(value) {
  let normalized = normalizeWhitespace(value)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/^\d{3,}(?:[-\s]\d+)+(?:\s*[-:]\s*)/u, "")
    .replace(/^\d+\.\s+/u, "")
    .replace(/\s*[\[\](){}]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  normalized = normalized.replace(/\s+-\s+/g, " - ");

  return normalized;
}

function buildWorldcatSearchUrl(title, author) {
  const cleanedAuthor = cleanAuthor(author);
  let cleanedTitle = normalizeSearchText(title);

  if (cleanedAuthor) {
    const escapedAuthor = cleanedAuthor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleanedTitle = cleanedTitle.replace(new RegExp(`\\s*-\\s*${escapedAuthor}$`, "i"), "").trim();
  }

  const query = normalizeWhitespace([cleanedTitle, cleanedAuthor].filter(Boolean).join(" "));
  const url = new URL("/search", WORLDCAT_BASE_URL);
  url.searchParams.set("q", query);
  return url.toString();
}

function buildJinaSearchUrl(searchUrl) {
  const parsedUrl = new URL(searchUrl);
  return `${JINA_WORLDcat_PREFIX}${parsedUrl.pathname}${parsedUrl.search}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "biblio-amhe-worldcat-scraper/1.0",
      accept: "text/plain,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Echec HTTP ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function extractWorldcatLinks(renderedText) {
  const links = [];
  const pattern = /\]\((https:\/\/search\.worldcat\.org\/title\/[^\s)]+)\)/g;

  for (const match of renderedText.matchAll(pattern)) {
    links.push(match[1]);
  }

  return [...new Set(links)];
}

function isRateLimitedResponse(renderedText) {
  const normalized = renderedText.toLowerCase();
  return (
    normalized.includes("error 1015") ||
    normalized.includes("rate limited") ||
    normalized.includes("target url returned error 429") ||
    normalized.includes("cloudflare to restrict access")
  );
}

function buildLinksHtml(links) {
  if (links.length === 0) {
    return '<span class="bibliographie-empty">-</span>';
  }

  return links
    .map((link) => `<a href="${escapeHtml(link)}">search.worldcat.org</a>`)
    .join(" | ");
}

function createMetaFieldHtml(label, fieldName, innerHtml, links = false) {
  return `<div class="bibliographie-entry__meta${links ? " bibliographie-entry__meta--links" : " "}"><span class="bibliographie-entry__label">${label}</span><div class="bibliographie-entry__value" data-field="${fieldName}">${innerHtml}</div></div>`;
}

function ensureWorldcatFields(entryHtml) {
  const linksMetaHtml = createMetaFieldHtml("Liens WorldCat", "liens-worldcat", '<span class="bibliographie-empty">-</span>', true);
  const dateMetaHtml = createMetaFieldHtml("Date dernier scrapping WorldCat", "date-scrapping-worldcat", '<span class="bibliographie-empty">-</span>');

  if (!hasField(entryHtml, "liens-worldcat") && !hasField(entryHtml, "date-scrapping-worldcat")) {
    if (hasField(entryHtml, "date-scrapping-bnf")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta "><span class="bibliographie-entry__label">Date dernier scrapping catalogue BNF<\/span><div class="bibliographie-entry__value" data-field="date-scrapping-bnf">[\s\S]*?<\/div><\/div>)/,
        `$1${linksMetaHtml}${dateMetaHtml}`
      );
    }

    if (hasField(entryHtml, "numerisation")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta "><span class="bibliographie-entry__label">Numerisation<\/span>)/,
        `${linksMetaHtml}${dateMetaHtml}$1`
      );
    }
  }

  if (!hasField(entryHtml, "liens-worldcat")) {
    if (hasField(entryHtml, "date-scrapping-worldcat")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta "><span class="bibliographie-entry__label">Date dernier scrapping WorldCat<\/span>)/,
        `${linksMetaHtml}$1`
      );
    }

    if (hasField(entryHtml, "date-scrapping-bnf")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta "><span class="bibliographie-entry__label">Date dernier scrapping catalogue BNF<\/span><div class="bibliographie-entry__value" data-field="date-scrapping-bnf">[\s\S]*?<\/div><\/div>)/,
        `$1${linksMetaHtml}`
      );
    }
  }

  if (!hasField(entryHtml, "date-scrapping-worldcat")) {
    if (hasField(entryHtml, "liens-worldcat")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta bibliographie-entry__meta--links"><span class="bibliographie-entry__label">Liens WorldCat<\/span><div class="bibliographie-entry__value" data-field="liens-worldcat">[\s\S]*?<\/div><\/div>)/,
        `$1${dateMetaHtml}`
      );
    }

    if (hasField(entryHtml, "numerisation")) {
      return entryHtml.replace(
        /(<div class="bibliographie-entry__meta "><span class="bibliographie-entry__label">Numerisation<\/span>)/,
        `${dateMetaHtml}$1`
      );
    }
  }

  return entryHtml;
}

function formatDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function collectEntries(html) {
  const matches = [...html.matchAll(/<article class="bibliographie-entry">[\s\S]*?<\/article>/g)];

  return matches.map((match, entryIndex) => {
    const entryHtml = match[0];
    const title = stripHtml(extractAnyFieldInnerHtml(entryHtml, "titre"));
    const author = stripHtml(extractFieldInnerHtml(entryHtml, "auteur"));
    const lastScrapeDate = stripHtml(extractFieldInnerHtml(entryHtml, "date-scrapping-worldcat"));

    return {
      entryIndex,
      title,
      author,
      lastScrapeDate,
      html: entryHtml,
      start: match.index ?? 0,
      end: (match.index ?? 0) + entryHtml.length,
    };
  });
}

async function scrapeEntry(entry, dateString) {
  const searchUrl = buildWorldcatSearchUrl(entry.title, entry.author);
  const jinaUrl = buildJinaSearchUrl(searchUrl);
  const renderedText = await fetchText(jinaUrl);
  const links = extractWorldcatLinks(renderedText);
  const blocked = isRateLimitedResponse(renderedText);

  let updatedHtml = ensureWorldcatFields(entry.html);
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "liens-worldcat", buildLinksHtml(links));
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "date-scrapping-worldcat", escapeHtml(dateString));

  return {
    ...entry,
    html: updatedHtml,
    searchUrl,
    jinaUrl,
    links,
    blocked,
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
    console.log(`Recherche WorldCat: ${entry.title}`);
    const updatedEntry = await scrapeEntry(entry, dateString);
    updates.push(updatedEntry);
    if (updatedEntry.blocked) {
      console.log("  Reponse WorldCat bloquee par Cloudflare (aucun lien exploitable extrait)");
    } else {
      console.log(`  ${updatedEntry.links.length} lien(s) WorldCat`);
    }
    if (updates.length < candidates.length) {
      console.log("  Pause de 2 secondes avant la prochaine requete WorldCat");
      await sleep(HTTP_DELAY_MS);
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
    if (update.blocked) {
      console.log(`- ${normalizeWhitespace(update.title)} -> bloque par Cloudflare`);
    } else {
      console.log(`- ${normalizeWhitespace(update.title)} -> ${update.links.length} lien(s)`);
    }
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
