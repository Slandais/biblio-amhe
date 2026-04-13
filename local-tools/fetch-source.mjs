#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();

function parseArgs(argv) {
  const options = {
    outDir: path.join(cwd, "local-data", "sources"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--url") {
      options.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--slug") {
      options.slug = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--out-dir") {
      options.outDir = path.resolve(cwd, argv[index + 1]);
      index += 1;
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
  npm run fetch:source -- --url "<url>"
  npm run fetch:source -- --url "<url>" --slug "<nom-de-dossier>"

Options:
  --url       URL a recuperer
  --slug      Nom de dossier de sortie
  --out-dir   Dossier parent de sortie (defaut: local-data/sources)
  --help      Affiche cette aide`);
}

function normalizeArchiveOrgUrl(inputUrl) {
  const url = new URL(inputUrl);

  if (
    url.hostname === "archive.org" &&
    url.pathname.startsWith("/stream/") &&
    url.pathname.endsWith("_djvu.txt")
  ) {
    url.pathname = url.pathname.replace("/stream/", "/download/");
  }

  return url.toString();
}

function buildSlug(input) {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "source";
}

function defaultSlugFromUrl(inputUrl) {
  const url = new URL(inputUrl);
  const filename = path.posix.basename(url.pathname) || url.hostname;
  return buildSlug(filename.replace(/\.[a-z0-9]+$/i, ""));
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function inferRawExtension(contentType, urlString) {
  if (contentType.includes("html")) {
    return "html";
  }

  const pathname = new URL(urlString).pathname.toLowerCase();
  const extension = path.posix.extname(pathname).replace(/^\./, "");
  return extension || "txt";
}

function inferExtractedText(rawText, contentType) {
  if (contentType.includes("html")) {
    return stripHtmlToText(rawText);
  }

  return rawText.replace(/\r\n/g, "\n").trim();
}

function buildPreview(text, maxLines = 12) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "biblio-amhe-local-tool/1.0",
      accept: "text/plain,text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Echec HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "text/plain";
  const buffer = Buffer.from(await response.arrayBuffer());
  const rawText = decodeResponseBody(buffer, contentType);

  return {
    finalUrl: response.url,
    contentType,
    rawText,
  };
}

function scoreDecodedText(text) {
  const mojibakeMatches = text.match(/[\u00C3\u00C2\u00E2\u20AC\u2122\u0153]/g) ?? [];
  const replacementMatches = text.match(/\uFFFD/g) ?? [];
  return mojibakeMatches.length + (replacementMatches.length * 3);
}

function decodeResponseBody(buffer, contentType) {
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  const declaredCharset = charsetMatch?.[1]?.trim().toLowerCase();

  const candidates = [];

  if (declaredCharset) {
    try {
      candidates.push(new TextDecoder(declaredCharset).decode(buffer));
    } catch {
      // Ignore unsupported charsets and continue with fallbacks.
    }
  }

  for (const fallback of ["utf-8", "windows-1252", "iso-8859-1"]) {
    try {
      candidates.push(new TextDecoder(fallback).decode(buffer));
    } catch {
      // Ignore unsupported charsets and continue.
    }
  }

  if (candidates.length === 0) {
    return buffer.toString("utf8");
  }

  return candidates
    .map((text) => ({ text, score: scoreDecodedText(text) }))
    .sort((left, right) => left.score - right.score)[0].text;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.url) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const normalizedUrl = normalizeArchiveOrgUrl(options.url);
  const slug = options.slug || defaultSlugFromUrl(normalizedUrl);
  const targetDir = path.join(options.outDir, slug);

  console.log(`Telechargement: ${options.url}`);
  if (normalizedUrl !== options.url) {
    console.log(`URL normalisee: ${normalizedUrl}`);
  }

  const fetched = await fetchText(normalizedUrl);
  const extractedText = inferExtractedText(fetched.rawText, fetched.contentType);
  const rawExtension = inferRawExtension(fetched.contentType, fetched.finalUrl);

  await mkdir(targetDir, { recursive: true });

  const metadata = {
    requestedUrl: options.url,
    normalizedUrl,
    finalUrl: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    contentType: fetched.contentType,
    rawFile: `raw.${rawExtension}`,
    extractedFile: "extracted.txt",
    preview: buildPreview(extractedText),
  };

  await writeFile(path.join(targetDir, `raw.${rawExtension}`), fetched.rawText, "utf8");
  await writeFile(path.join(targetDir, "extracted.txt"), `${extractedText}\n`, "utf8");
  await writeFile(path.join(targetDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  console.log(`Dossier cree: ${targetDir}`);
  console.log(`Fichier brut: raw.${rawExtension}`);
  console.log("Fichier exploitable: extracted.txt");
  console.log("\nApercu :\n");
  console.log(metadata.preview);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
