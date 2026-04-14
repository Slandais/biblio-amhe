#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const cwd = process.cwd();
const INDEX_PATH = path.join(cwd, "index.html");
const THIMM_PATH = path.join(cwd, "thimm-bibliography.txt");
const MODIFIED_DATE = "2026-04-14";

function decodeHtmlEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function stripHtml(value) {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeKey(value) {
  return stripHtml(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^[\s'"`“”‘’\-–—.()]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sortText(value) {
  return normalizeKey(value).replace(/^[\s\-–—.()]+/, "");
}

function parseExistingRows(html) {
  const tbodyMatch = html.match(
    /(<table id="bibliographie">[\s\S]*?<tbody>)([\s\S]*?)(<\/tbody>)/,
  );

  if (!tbodyMatch) {
    throw new Error("Impossible de trouver le tableau bibliographie.");
  }

  const [, prefix, tbodyInner, suffix] = tbodyMatch;
  const rowMatches = [...tbodyInner.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];

  const rows = rowMatches
    .map((match) => {
      const rowHtml = match[1];
      const cells = [...rowHtml.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(
        (cellMatch) => cellMatch[1],
      );

      if (cells.length === 0) {
        return null;
      }

      return {
        cells,
        titleText: stripHtml(cells[0] ?? ""),
        coteText: stripHtml(cells[4] ?? ""),
        authorText: stripHtml(cells[1] ?? ""),
        key: normalizeKey(`${cells[0] ?? ""}|${cells[1] ?? ""}|${cells[4] ?? ""}`),
      };
    })
    .filter(Boolean);

  return { prefix, suffix, rows };
}

function extractThimmEntries(text) {
  const lines = text.split(/\r?\n/);
  const filtered = [];
  let currentPage = null;

  for (const line of lines) {
    const pageMatch = line.match(/^-- (\d+) of 277 --$/);
    if (pageMatch) {
      currentPage = Number(pageMatch[1]);
      continue;
    }

    if (currentPage === null || currentPage < 16 || currentPage > 186) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      filtered.push("");
      continue;
    }

    if (
      trimmed === "Bibliography of the Art of Fence," ||
      trimmed === "Duelling, &c." ||
      trimmed.startsWith("Bibliography of the Art of Fence") ||
      trimmed.startsWith("THIHM, Bibliography of the Art of Fence") ||
      trimmed.startsWith("[Note. Authors’ names") ||
      /^THIHM\b/i.test(trimmed)
    ) {
      continue;
    }

    filtered.push(trimmed);
  }

  const isStart = (line) =>
    /—/.test(line) &&
    /^[-A-ZÀ-ÖØ-Ý]/.test(line) &&
    !/^\d/.test(line) &&
    !/^\[/.test(line);

  const entries = [];
  let current = [];

  for (const line of filtered) {
    if (isStart(line)) {
      if (current.length) {
        entries.push(current);
      }
      current = [line];
      continue;
    }

    if (current.length) {
      current.push(line);
    }
  }

  if (current.length) {
    entries.push(current);
  }

  return entries
    .map((entryLines) => {
      const firstLine = entryLines[0] ?? "";
      const rest = entryLines.slice(1).filter(Boolean);
      const body = rest.join(" ").replace(/\s+/g, " ").trim();
      const headTail = firstLine
        .split("—")
        .slice(1)
        .join("—")
        .replace(/\s+/g, " ")
        .trim();
      const titleText = [headTail, body]
        .filter((part) => part && !/^\d{3,4}\.?$/.test(part))
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/^[,.;:\s]+/, "")
        .trim() || stripHtml(firstLine);
      const yearMatches = titleText.match(/\b(1[5-9]\d{2}|20\d{2})\b/g) || [];
      if (titleText.length > 500 || (titleText.length > 250 && yearMatches.length > 3)) {
        return null;
      }

      const yearText = yearMatches[0] || "";

      let authorText = "";
      if (/^[-]{5,}/.test(firstLine)) {
        authorText = "Anonyme";
      } else {
        const dashParts = firstLine.split("—").map((part) => part.trim());
        if (dashParts.length >= 2) {
          const left = dashParts[0];
          const right = dashParts[1];
          if (left && !/^[A-Z]\s*(?:\.\s*)?$/.test(left.replace(/\s+/g, ""))) {
            authorText = left;
          } else if (right && !/^\d{3,4}$/.test(right)) {
            authorText = right.replace(/\s*\.\s*\d{4}.*/, "").trim();
          } else {
            authorText = left || right || "Anonyme";
          }
        } else {
          authorText = "Anonyme";
        }
      }

      if (!authorText) {
        authorText = "Anonyme";
      }

      const title = titleText;
      const cells = [
        escapeHtml(title),
        escapeHtml(authorText),
        "",
        escapeHtml(yearText),
        "",
        "",
        "",
        "MANQUANTE",
        "Importé depuis la bibliographie de Thimm (1891).",
        "",
        MODIFIED_DATE,
      ];

      return {
        cells,
        titleText: stripHtml(title),
        coteText: "",
        authorText: stripHtml(authorText),
        key: normalizeKey(`${title}|${authorText}|`),
      };
    })
    .filter((entry) => entry && (entry.titleText || entry.authorText));
}

function renderRows(rows) {
  return rows
    .map(
      (row) =>
        `    <tr>\n${row.cells.map((cell) => `      <td>${cell}</td>`).join("\n")}\n    </tr>`,
    )
    .join("\n");
}

function sortRows(rows) {
  const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });

  return [...rows].sort((left, right) => {
    const leftTitle = sortText(left.titleText || left.coteText || left.authorText || "");
    const rightTitle = sortText(right.titleText || right.coteText || right.authorText || "");

    const byTitle = collator.compare(leftTitle, rightTitle);
    if (byTitle !== 0) {
      return byTitle;
    }

    return collator.compare(left.coteText || "", right.coteText || "");
  });
}

async function main() {
  const [indexHtml, thimmText] = await Promise.all([
    readFile(INDEX_PATH, "utf8"),
    readFile(THIMM_PATH, "utf8"),
  ]);

  const existing = parseExistingRows(indexHtml);
  const thimmRows = extractThimmEntries(thimmText);

  const merged = [];
  const seen = new Set();

  for (const row of [...existing.rows, ...thimmRows]) {
    if (seen.has(row.key)) {
      continue;
    }
    seen.add(row.key);
    merged.push(row);
  }

  const sorted = sortRows(merged);
  const renderedRows = renderRows(sorted);

  const updatedHtml = indexHtml.replace(
    /(<table id="bibliographie">[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/,
    `$1\n${renderedRows}\n  $2`,
  );

  await writeFile(INDEX_PATH, updatedHtml, "utf8");

  console.log(`Rows existing: ${existing.rows.length}`);
  console.log(`Rows imported from Thimm: ${thimmRows.length}`);
  console.log(`Rows merged total: ${sorted.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
