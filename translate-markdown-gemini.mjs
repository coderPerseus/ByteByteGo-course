#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const API_KEY = process.env.GEMINI_APIKEY;
const API_BASE =
  (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
const MAX_CHARS = Number(process.env.TRANSLATE_MAX_CHARS || 4000);
const RETRY_LIMIT = Number(process.env.TRANSLATE_RETRY_LIMIT || 5);
const STATE_DIR_NAME = ".translation-state";
const argv = process.argv.slice(2);

if (!API_KEY) {
  console.error("GEMINI_APIKEY is not set.");
  process.exit(1);
}

const targetFiles = argv.length > 0 ? argv : await listMarkdownFiles(process.cwd());

if (targetFiles.length === 0) {
  console.log("No markdown files found.");
  process.exit(0);
}

const failures = [];

for (const file of targetFiles) {
  if (file.endsWith(".zh-CN.md")) {
    continue;
  }
  try {
    await translateFile(file);
  } catch (error) {
    failures.push({ file, error: error instanceof Error ? error.message : String(error) });
    console.error(`Failed ${file}: ${failures.at(-1).error}`);
  }
}

if (failures.length > 0) {
  console.error("\nTranslation finished with failures:");
  for (const failure of failures) {
    console.error(`- ${failure.file}: ${failure.error}`);
  }
  process.exit(1);
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".zh-CN.md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function translateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const outputPath = absolutePath.replace(/\.md$/i, ".zh-CN.md");
  const chunks = splitMarkdown(content, MAX_CHARS);
  const partialPath = `${outputPath}.part`;
  const statePath = path.join(path.dirname(absolutePath), STATE_DIR_NAME, `${path.basename(outputPath)}.json`);

  if (await fileExists(outputPath)) {
    console.log(`Skipping ${path.basename(outputPath)} because it already exists`);
    return;
  }

  await fs.mkdir(path.dirname(statePath), { recursive: true });

  let completedChunks = 0;
  const savedState = await readState(statePath);
  if (
    savedState &&
    savedState.sourceFile === path.basename(filePath) &&
    savedState.totalChunks === chunks.length &&
    (await fileExists(partialPath))
  ) {
    completedChunks = savedState.completedChunks;
  } else {
    await fs.writeFile(partialPath, "", "utf8");
    await writeState(statePath, {
      sourceFile: path.basename(filePath),
      outputFile: path.basename(outputPath),
      totalChunks: chunks.length,
      completedChunks: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  console.log(`Translating ${path.basename(filePath)} in ${chunks.length} chunk(s)...`);
  if (completedChunks > 0) {
    console.log(`  resuming from chunk ${completedChunks + 1}/${chunks.length}...`);
  }

  for (let i = completedChunks; i < chunks.length; i += 1) {
    console.log(`  requesting chunk ${i + 1}/${chunks.length}...`);
    const translated = await translateChunk({
      filePath: path.basename(filePath),
      chunk: chunks[i],
      index: i + 1,
      total: chunks.length,
    });
    await fs.appendFile(partialPath, ensureTrailingNewline(translated), "utf8");
    await writeState(statePath, {
      sourceFile: path.basename(filePath),
      outputFile: path.basename(outputPath),
      totalChunks: chunks.length,
      completedChunks: i + 1,
      updatedAt: new Date().toISOString(),
    });
    console.log(`  chunk ${i + 1}/${chunks.length} done`);
  }

  await fs.rename(partialPath, outputPath);
  await fs.rm(statePath, { force: true });
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

  const topSections = remaining.split(/\n(?=---\n\n## )/g);
  for (const section of topSections) {
    if (!section) {
      continue;
    }
    if (section.length <= maxChars) {
      parts.push(section);
      continue;
    }
    parts.push(...splitLargeSection(section, maxChars));
  }

  return parts;
}

function splitLargeSection(section, maxChars) {
  const lines = section.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    const strongBoundary = /^#{1,6}\s/.test(line) || /^---$/.test(line) || /^\*\s\*\s\*$/.test(line);
    const softBoundary = /^\|.*\|$/.test(line) || /^>\s/.test(line) || /^!\[/.test(line);

    if (current && next.length > maxChars && (strongBoundary || softBoundary)) {
      chunks.push(ensureTrailingNewline(current));
      current = line;
      continue;
    }

    if (current && next.length > maxChars) {
      chunks.push(ensureTrailingNewline(current));
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

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readState(statePath) {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeState(statePath, state) {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function translateChunk({ filePath, chunk, index, total }) {
  const url = `${API_BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  const systemPrompt = "你是一个资深的技术翻译官。";
  const userPrompt = [
    `文件名：${filePath}`,
    `分块：${index}/${total}`,
    "",
    "请将下面的 Markdown 从英文完整翻译成中文。",
    "要求：",
    "1. 只返回翻译后的 Markdown，不要额外解释。",
    "2. 保留 Markdown 结构、YAML frontmatter 的键名、代码块、行内代码、URL、图片链接和 HTML。",
    "3. 翻译标题、正文、列表、表格、引用、图注以及有意义的图片 alt 文本。",
    "4. 不要删减，不要总结，不要补充原文没有的信息。",
    "5. 面向中文软件工程师，术语要专业、自然、一致。",
    "",
    chunk,
  ].join("\n");

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
    let response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      }),
      });
      clearTimeout(timeout);
    } catch (error) {
      if (attempt === RETRY_LIMIT) {
        throw error;
      }
      await wait(attempt * 1500);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt === RETRY_LIMIT) {
        throw new Error(
          `Gemini API failed for ${filePath} chunk ${index}: ${response.status} ${errorText}`,
        );
      }
      await wait(attempt * 1500);
      continue;
    }

    const data = await response.json();
    const text = extractText(data);
    if (!text.trim()) {
      if (attempt === RETRY_LIMIT) {
        throw new Error(`Empty translation for ${filePath} chunk ${index}`);
      }
      await wait(attempt * 1500);
      continue;
    }
    return restoreLeadingSyntax(chunk, sanitizeModelWrapper(text));
  }

  throw new Error(`Failed to translate ${filePath} chunk ${index}`);
}

function extractText(data) {
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return "";
  }

  return candidates
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("");
}

function sanitizeModelWrapper(text) {
  let output = text;
  output = output.replace(/^```[a-zA-Z0-9_-]*\s*\n/, "");
  output = output.replace(/\n```[\t ]*$/i, "");
  return output;
}

function restoreLeadingSyntax(sourceChunk, translatedChunk) {
  let output = translatedChunk;
  if (sourceChunk.startsWith("---\n\n## ") && !output.startsWith("---\n")) {
    output = `---\n\n${output.replace(/^\n+/, "")}`;
  }
  return output;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
