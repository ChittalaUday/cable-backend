import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

interface CommentEntry {
  pos: number;
  end: number;
  text: string;
}

function isPragma(commentText: string): boolean {
  return /^\/\/\s*(?:@ts-|eslint-)/.test(commentText) || /^\/\*\s*eslint/.test(commentText);
}

function collectCommentRanges(sf: ts.SourceFile, content: string): CommentEntry[] {
  const comments: CommentEntry[] = [];
  const seen = new Set<number>();

  function addComment(c: ts.CommentRange | undefined) {
    if (c !== undefined && !seen.has(c.pos)) {
      seen.add(c.pos);
      const text = content.slice(c.pos, c.end);
      if (!isPragma(text)) {
        comments.push({ pos: c.pos, end: c.end, text });
      }
    }
  }

  function visit(node: ts.Node) {
    const leading = ts.getLeadingCommentRanges(content, node.getFullStart()) ?? [];
    for (const c of leading) {
      addComment(c);
    }

    const trailing = ts.getTrailingCommentRanges(content, node.getEnd()) ?? [];
    for (const c of trailing) {
      addComment(c);
    }

    node.getChildren(sf).forEach(visit);
  }

  visit(sf);
  return comments.sort((a, b) => a.pos - b.pos);
}

function removeCommentFromText(currentText: string, comment: CommentEntry): string {
  const { pos, end } = comment;
  const lineStart = currentText.lastIndexOf('\n', pos - 1) + 1;
  const isLeadingWhitespaceOnly = currentText.slice(lineStart, pos).trim() === '';
  const after = currentText.slice(end);
  const newlineMatch = after.match(/^[ \t]*\r?\n/);

  if (isLeadingWhitespaceOnly && newlineMatch !== null) {
    return currentText.slice(0, lineStart) + currentText.slice(end + newlineMatch[0].length);
  }

  if (isLeadingWhitespaceOnly && after.length === 0) {
    return currentText.slice(0, lineStart);
  }

  const lineBefore = currentText.slice(lineStart, pos);
  const trailingSpaceMatch = lineBefore.match(/[ \t]+$/);
  const actualPos = trailingSpaceMatch !== null ? pos - trailingSpaceMatch[0].length : pos;

  const charBefore = actualPos > 0 ? currentText.charAt(actualPos - 1) : '';
  const charAfter = currentText.charAt(end);
  const needsSpace = /[\w$]/.test(charBefore) && /[\w$]/.test(charAfter);

  return currentText.slice(0, actualPos) + (needsSpace ? ' ' : '') + currentText.slice(end);
}

export function stripCommentsFromSource(content: string, filePath = 'file.ts'): string {
  const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const comments = collectCommentRanges(sf, content);
  if (comments.length === 0) {
    return content;
  }

  let result = content;
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment !== undefined) {
      result = removeCommentFromText(result, comment);
    }
  }

  return result.replace(/\n{3,}/g, '\n\n');
}

function walkDir(dir: string, fileList: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules'
        || entry.name === 'dist'
        || entry.name === '.git'
        || entry.name === 'migrations'
      ) {
        continue;
      }
      walkDir(fullPath, fileList);
    }
    else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function main() {
  const targetArg = process.argv[2] ?? 'src';
  const targetPath = path.resolve(process.cwd(), targetArg);

  if (!fs.existsSync(targetPath)) {
    console.error(`Target path does not exist: ${targetPath}`);
    process.exit(1);
  }

  const files = fs.statSync(targetPath).isDirectory() ? walkDir(targetPath) : [targetPath];
  let modifiedCount = 0;

  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8');
    const cleaned = stripCommentsFromSource(original, file);

    if (cleaned !== original) {
      fs.writeFileSync(file, cleaned, 'utf8');
      modifiedCount++;
    }
  }

  console.warn(`Processed ${files.length} files. Modified ${modifiedCount} files.`);
}

const isDirectExecution = process.argv[1] !== undefined
  && (process.argv[1].endsWith('strip-comments.ts') || process.argv[1].endsWith('strip-comments.js'));

if (isDirectExecution) {
  main();
}
