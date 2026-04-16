#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const BOOKS2EBOOKS_BASE_URL = "https://search.books2ebooks.eu";
const BOOKS2EBOOKS_VUFIND_BASE_URL = "https://search.books2ebooks.eu/vufind";

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
  node local-tools/scrape-books2ebooks.mjs
  node local-tools/scrape-books2ebooks.mjs --limit 10
  node local-tools/scrape-books2ebooks.mjs --limit 10 --dry-run

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

  return score;
}

function buildBooks2ebooksSearchUrl(title) {
  const url = new URL("/vufind/Search/Results", BOOKS2EBOOKS_BASE_URL);
  url.searchParams.set("lookfor", title);
  url.searchParams.set("type", "AllFields");
  return url.toString();
}

function extractBooks2ebooksRecordLinks(searchHtml) {
  const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>/gi;
  const links = [];

  for (const match of searchHtml.matchAll(linkPattern)) {
    const href = decodeHtmlEntities(match[1]);

    try {
      const absoluteUrl = new URL(href, BOOKS2EBOOKS_VUFIND_BASE_URL);
      if (
        absoluteUrl.hostname === "search.books2ebooks.eu" &&
        absoluteUrl.pathname.startsWith("/vufind/Record/")
      ) {
        absoluteUrl.hash = "";
        links.push(absoluteUrl.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return [...new Set(links)];
}

function extractBooks2ebooksResultCount(searchHtml, links) {
  const text = stripHtml(searchHtml);
  const patterns = [
    /([0-9]+)\s+results?\b/i,
    /([0-9]+)\s+records?\b/i,
    /results?\s+[0-9]+\s*-\s*[0-9]+\s+of\s+([0-9]+)/i,
    /\bof\s+([0-9]+)\s+results?\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  if (/no results/i.test(text)) {
    return 0;
  }

  return links.length;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "biblio-amhe-books2ebooks-scraper/1.0",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Echec HTTP ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  if (/Powered by splitbrain'?s botcheck/i.test(html) || /Are you Human\?/i.test(html)) {
    throw new Error("Books2ebooks a renvoye une page anti-bot, scrapping impossible automatiquement pour cette requete.");
  }

  return html;
}

function buildLinksHtml(links) {
  if (links.length === 0) {
    return '<span class="bibliographie-empty">-</span>';
  }

  return links
    .map((link) => `<a href="${escapeHtml(link)}">search.books2ebooks.eu</a>`)
    .join(" | ");
}

function buildResultHtml(resultCount) {
  return escapeHtml(`${resultCount} resultat${resultCount > 1 ? "s" : ""}`);
}

function formatDate(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function buildMetaFieldHtml({ label, field, valueHtml, links = false }) {
  return `<div class="bibliographie-entry__meta${links ? " bibliographie-entry__meta--links" : ""}"><span class="bibliographie-entry__label">${escapeHtml(label)}</span><div class="bibliographie-entry__value" data-field="${escapeHtml(field)}">${valueHtml}</div></div>`;
}

function ensureBooks2ebooksFields(entryHtml) {
  let updatedHtml = entryHtml;
  const numerisationPattern = /(<div class="bibliographie-entry__meta "\><span class="bibliographie-entry__label">Numerisation<\/span>)/;
  const secondaryLineEnd = /(<\/div>\s*<\/article>)$/;

  const linksField = 'data-field="liens-books2ebooks"';
  const resultField = 'data-field="resultat-books2ebooks"';
  const dateField = 'data-field="date-scrapping-books2ebooks"';

  if (updatedHtml.includes(linksField) && updatedHtml.includes(resultField) && updatedHtml.includes(dateField)) {
    return updatedHtml;
  }

  const linksMetaHtml = buildMetaFieldHtml({
    label: "Liens Books2ebooks",
    field: "liens-books2ebooks",
    valueHtml: '<span class="bibliographie-empty">-</span>',
    links: true,
  });
  const resultMetaHtml = buildMetaFieldHtml({
    label: "Resultats Books2ebooks",
    field: "resultat-books2ebooks",
    valueHtml: '<span class="bibliographie-empty">-</span>',
  });
  const dateMetaHtml = buildMetaFieldHtml({
    label: "Date dernier scrapping Books2ebooks",
    field: "date-scrapping-books2ebooks",
    valueHtml: '<span class="bibliographie-empty">-</span>',
  });

  if (!updatedHtml.includes(linksField)) {
    updatedHtml = numerisationPattern.test(updatedHtml)
      ? updatedHtml.replace(numerisationPattern, `${linksMetaHtml}$1`)
      : updatedHtml.replace(secondaryLineEnd, `${linksMetaHtml}$1`);
  }

  if (!updatedHtml.includes(resultField)) {
    updatedHtml = numerisationPattern.test(updatedHtml)
      ? updatedHtml.replace(numerisationPattern, `${resultMetaHtml}$1`)
      : updatedHtml.replace(secondaryLineEnd, `${resultMetaHtml}$1`);
  }

  if (!updatedHtml.includes(dateField)) {
    updatedHtml = numerisationPattern.test(updatedHtml)
      ? updatedHtml.replace(numerisationPattern, `${dateMetaHtml}$1`)
      : updatedHtml.replace(secondaryLineEnd, `${dateMetaHtml}$1`);
  }

  return updatedHtml;
}

function collectEntries(html) {
  const matches = [...html.matchAll(/<article class="bibliographie-entry">[\s\S]*?<\/article>/g)];

  return matches.map((match, entryIndex) => {
    const entryHtml = match[0];
    const title = stripHtml(extractAnyFieldInnerHtml(entryHtml, "titre"));
    const lastScrapeDate = stripHtml(extractFieldInnerHtml(entryHtml, "date-scrapping-books2ebooks"));

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
  const searchUrl = buildBooks2ebooksSearchUrl(entry.title);
  const searchHtml = await fetchText(searchUrl);
  const links = extractBooks2ebooksRecordLinks(searchHtml);
  const resultCount = extractBooks2ebooksResultCount(searchHtml, links);

  let updatedHtml = ensureBooks2ebooksFields(entry.html);
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "liens-books2ebooks", buildLinksHtml(links));
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "resultat-books2ebooks", buildResultHtml(resultCount));
  updatedHtml = replaceFieldInnerHtml(updatedHtml, "date-scrapping-books2ebooks", escapeHtml(dateString));

  return {
    ...entry,
    html: updatedHtml,
    searchUrl,
    links,
    resultCount,
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
    console.log(`Recherche Books2ebooks: ${entry.title}`);
    const updatedEntry = await scrapeEntry(entry, dateString);
    updates.push(updatedEntry);
    console.log(`  ${updatedEntry.resultCount} resultat(s), ${updatedEntry.links.length} lien(s) retenu(s)`);
    if (updates.length < candidates.length) {
      console.log("  Pause de 2 secondes avant la prochaine requete Books2ebooks");
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
    console.log(`- ${normalizeWhitespace(update.title)} -> ${update.resultCount} resultat(s), ${update.links.length} lien(s)`);
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
