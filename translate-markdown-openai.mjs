#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1";
const API_KEY = process.env.OPENAI_API_KEY;
const API_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MAX_CHARS = Number(process.env.TRANSLATE_MAX_CHARS || 12000);
const RETRY_LIMIT = Number(process.env.TRANSLATE_RETRY_LIMIT || 5);
const argv = process.argv.slice(2);

if (!API_KEY) {
  console.error("OPENAI_API_KEY is not set.");
  process.exit(1);
}

const targetFiles = argv.length > 0 ? argv : (await listMarkdownFiles(process.cwd()));

if (targetFiles.length === 0) {
  console.log("No markdown files found.");
  process.exit(0);
}

for (const file of targetFiles) {
  if (file.endsWith(".zh-CN.md")) {
    continue;
  }
  await translateFile(file);
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function translateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const outputPath = absolutePath.replace(/\.md$/i, ".zh-CN.md");

  const chunks = splitMarkdown(content, MAX_CHARS);
  const translatedChunks = [];

  console.log(`Translating ${path.basename(filePath)} in ${chunks.length} chunk(s)...`);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const translated = await translateChunk({
      filePath: path.basename(filePath),
      chunk,
      index: i + 1,
      total: chunks.length,
    });
    translatedChunks.push(translated);
    console.log(`  chunk ${i + 1}/${chunks.length} done`);
  }

  await fs.writeFile(outputPath, translatedChunks.join(""), "utf8");
  console.log(`Wrote ${path.basename(outputPath)}`);
}

function splitMarkdown(content, maxChars) {
  const normalized = content.replace(/\r\n/g, "\n");
  const parts = [];

  const frontmatterMatch = normalized.match(/^---\n[\s\S]*?\n---\n*/);
  let remaining = normalized;

  if (frontmatterMatch) {
    parts.push(frontmatterMatch[0]);
    remaining = normalized.slice(frontmatterMatch[0].length);
  }

  const lessonSections = remaining.split(/\n(?=---\n\n## )/g);
  for (const section of lessonSections) {
    if (section.length <= maxChars) {
      parts.push(section);
      continue;
    }
    parts.push(...splitLargeSection(section, maxChars));
  }

  return parts.filter(Boolean);
}

function splitLargeSection(section, maxChars) {
  const lines = section.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    const isBoundary = /^#{1,6}\s|^---$|^\*\s\*\s\*$|^\|.*\|$/.test(line);

    if (current && next.length > maxChars && isBoundary) {
      chunks.push(current.endsWith("\n") ? current : `${current}\n`);
      current = line;
      continue;
    }

    if (current && next.length > maxChars) {
      chunks.push(current.endsWith("\n") ? current : `${current}\n`);
      current = line;
      continue;
    }

    current = next;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function translateChunk({ filePath, chunk, index, total }) {
  const system = [
    "You are a senior technical translator.",
    "Translate Markdown from English to Simplified Chinese.",
    "Return only translated Markdown.",
    "Preserve Markdown structure, YAML keys, code fences, inline code, URLs, HTML, and image URLs.",
    "Translate natural language text, titles, headings, lists, tables, captions, and meaningful alt text.",
    "Do not omit content. Do not summarize. Do not add commentary.",
    "Keep terminology accurate and consistent for Chinese software engineers.",
  ].join(" ");

  const user = [
    `File: ${filePath}`,
    `Chunk: ${index}/${total}`,
    "",
    "Translate the following Markdown exactly once into polished Simplified Chinese:",
    "",
    chunk,
  ].join("\n");

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
    const response = await fetch(`${API_BASE}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: system }] },
          { role: "user", content: [{ type: "input_text", text: user }] },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt === RETRY_LIMIT) {
        throw new Error(`OpenAI API failed for ${filePath} chunk ${index}: ${response.status} ${errorText}`);
      }
      await wait(attempt * 1500);
      continue;
    }

    const data = await response.json();
    const text = extractOutputText(data);
    if (!text.trim()) {
      if (attempt === RETRY_LIMIT) {
        throw new Error(`Empty translation for ${filePath} chunk ${index}`);
      }
      await wait(attempt * 1500);
      continue;
    }
    return text;
  }

  throw new Error(`Failed to translate ${filePath} chunk ${index}`);
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }

  if (!Array.isArray(data.output)) {
    return "";
  }

  return data.output
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text || "")
    .join("");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
