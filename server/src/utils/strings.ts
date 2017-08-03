import { FormattingOptions } from 'vscode-languageserver-types';

export function getWordAtText(text: string, offset: number, wordDefinition: RegExp): { start: number, length: number } {
  let lineStart = offset;
  while (lineStart > 0 && !isNewlineCharacter(text.charCodeAt(lineStart - 1))) {
    lineStart--;
  }
  const offsetInLine = offset - lineStart;
  const lineText = text.substr(lineStart);

  // make a copy of the regex as to not keep the state
  const flags = wordDefinition.ignoreCase ? 'gi' : 'g';
  wordDefinition = new RegExp(wordDefinition.source, flags);

  let match = wordDefinition.exec(lineText);
  while (match && match.index + match[0].length < offsetInLine) {
    match = wordDefinition.exec(lineText);
  }
  if (match && match.index <= offsetInLine) {
    return { start: match.index + lineStart, length: match[0].length };
  }

  return { start: offset, length: 0 };
}

export function removeQuotes(str: string) {
  return str.replace(/["']/g, '');
}


const CR = '\r'.charCodeAt(0);
const NL = '\n'.charCodeAt(0);
function isNewlineCharacter(charCode: number) {
  return charCode === CR || charCode === NL;
}


const nonEmptyLineRE = /^(?!$)/mg;
/**
 *  wrap text in section tags like <template>, <style>
 *  add leading and trailing newline and optional indentation
 */
export function wrapSection(text: string, needIndent: boolean, options: FormattingOptions): string {
  if (needIndent) {
    const initialIndent = generateIndent(options);
    text = text.replace(nonEmptyLineRE, initialIndent);
  }
  return '\n' + text + '\n';
}

function generateIndent(options: FormattingOptions) {
  if (options.insertSpaces) {
    return ' '.repeat(options.tabSize);
  } else {
    return '\t';
  }
}
