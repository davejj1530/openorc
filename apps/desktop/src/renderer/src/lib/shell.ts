/**
 * Enough of the shell to read a command the way a person would: where one command ends and the next begins, what a
 * heredoc feeds in, and what each word says once its quotes are gone. Nothing here runs anything, and whatever it
 * cannot follow stays together as written.
 */

export interface ShellStep {
  /** The command as written, without a heredoc's operator or body. */
  text: string;
  /** What a heredoc fed the command. */
  input: string | null;
}

export interface ShellToken {
  /** A word without its quotes, or an operator as written. */
  value: string;
  operator: boolean;
  start: number;
  end: number;
}

/** One step read for what it runs: its words, what its output flows into, and where it goes instead of the terminal. */
export interface CommandLine {
  /** The first command's words, unquoted, without its redirections. */
  words: string[];
  /** The commands its output flows into, or that run when it fails, by name: `| head -5` is ["head"]. */
  next: string[];
  /** The file `>` or `>>` sends its output to. */
  output: { path: string; append: boolean } | null;
}

type Kind = "newline" | "space" | "quoted" | "heredoc" | "separator" | "pipe" | "param" | "open" | "close" | "redirect" | "word";

/** Tried in order at each position; the first that matches says what comes next. */
const LEXICON: [Kind, RegExp][] = [
  ["newline", /\n/y],
  ["space", /[ \t\r]+/y],
  ["quoted", /'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|`(?:[^`\\]|\\[\s\S])*`?|\\[\s\S]?/y],
  ["heredoc", /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w.-]*))[ \t]*/y],
  ["separator", /&&|;;?/y],
  ["pipe", /\|\|?|&(?!>)/y],
  ["param", /\$\{/y],
  ["open", /\$?\(|\{/y],
  ["close", /[)}]/y],
  ["redirect", /[<>&]+/y],
  ["word", /(?:[^\s'"`\\;&|(){}<>$]|\$(?![({]))+/y],
];
/** A word can start after these, so a `#` there begins a comment. */
const BREAKS = new Set<Kind>(["space", "pipe", "open", "redirect"]);
/** A command starts after these. */
const STARTS = new Set<Kind>(["pipe", "open"]);
const OPENERS = new Set(["if", "for", "while", "until", "case", "select"]);
const CLOSERS = new Set(["fi", "done", "esac"]);
/** Words a command follows: `then echo`, `do rm`, `! grep`. */
const LEADERS = new Set(["then", "do", "else", "elif", "!", "time", "if", "while", "until"]);

interface Heredoc {
  delimiter: string;
  /** `<<-` lets the body and its delimiter be indented with tabs. */
  strip: boolean;
  step: ShellStep;
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end < 0 ? text.length : end;
}

class StepReader {
  private readonly steps: ShellStep[] = [];
  private step: ShellStep = { text: "", input: null };
  private heredocs: Heredoc[] = [];
  /** Open `(`, `$(`, `{` and `${`. */
  private brackets = 0;
  /** Open `if`, `for`, `while` and `case`. */
  private blocks = 0;
  /** The next word begins a command, so a keyword there opens or closes a block. */
  private commandStart = true;
  /** The next character begins a word, so a `#` there starts a comment. */
  private wordStart = true;
  private at = 0;

  constructor(private readonly source: string) {}

  read(): ShellStep[] {
    while (this.at < this.source.length) this.next();
    this.finish();
    return this.steps;
  }

  private next() {
    if (this.wordStart && this.source[this.at] === "#") return this.comment();
    for (const [kind, pattern] of LEXICON) {
      pattern.lastIndex = this.at;
      const token = pattern.exec(this.source);
      if (!token) continue;
      this.at += token[0].length;
      return this.take(kind, token);
    }
    this.step.text += this.source[this.at++];
  }

  private take(kind: Kind, token: RegExpExecArray) {
    switch (kind) {
      case "newline":
        this.readHeredocs();
        return this.split("\n");
      case "heredoc":
        // The operator is how the body got in; the body itself is kept apart, so the line reads without it.
        this.heredocs.push({ delimiter: token[2] ?? token[3] ?? token[4] ?? "", strip: token[1] === "-", step: this.step });
        return;
      case "separator":
        return this.split(token[0]);
      case "word":
        this.keyword(token[0]);
        break;
      case "param":
      case "open":
        this.brackets++;
        break;
      case "close":
        this.brackets = Math.max(0, this.brackets - 1);
        break;
    }
    this.step.text += token[0];
    this.wordStart = BREAKS.has(kind);
    if (kind !== "space" && kind !== "word") this.commandStart = STARTS.has(kind);
  }

  private keyword(word: string) {
    if (!this.commandStart) return;
    if (OPENERS.has(word)) this.blocks++;
    if (CLOSERS.has(word)) this.blocks = Math.max(0, this.blocks - 1);
    this.commandStart = LEADERS.has(word);
  }

  /** `;`, `&&` or a line break ends a step, unless a bracket or a block is still open. */
  private split(separator: string) {
    if (this.brackets || this.blocks) this.step.text += separator;
    else this.finish();
    this.commandStart = true;
    this.wordStart = true;
  }

  private comment() {
    const end = lineEnd(this.source, this.at);
    this.step.text += this.source.slice(this.at, end);
    this.at = end;
  }

  /** The bodies of the heredocs opened on the line just ended: the lines after it, up to each one's delimiter. */
  private readHeredocs() {
    for (const heredoc of this.heredocs) {
      const lines: string[] = [];
      while (this.at < this.source.length) {
        const end = lineEnd(this.source, this.at);
        const raw = this.source.slice(this.at, end);
        const line = heredoc.strip ? raw.replace(/^\t+/, "") : raw;
        this.at = end + 1;
        if (line === heredoc.delimiter) break;
        lines.push(line);
      }
      heredoc.step.input = heredoc.step.input === null ? lines.join("\n") : `${heredoc.step.input}\n${lines.join("\n")}`;
    }
    this.heredocs = [];
  }

  private finish() {
    this.step.text = this.step.text.trim();
    if (this.step.text) this.steps.push(this.step);
    this.step = { text: "", input: null };
  }
}

/** The commands a script runs in order, split where the shell would run them one after another. */
export function shellSteps(command: string): ShellStep[] {
  return new StepReader(command).read();
}

const OPERATOR = /&&|\|\||;;|<<<|<<-?|>>|>&|<&|&>>?|\|&|[|&;<>()]/y;
const SINGLE = /'[^']*'?/y;
const DOUBLE = /"(?:[^"\\]|\\[\s\S])*"?/y;
const PLAIN = /[^\s'"\\`$|&;<>()]+|\$/y;

function quoteEnd(text: string, at: number): number {
  const pattern = text[at] === "'" ? SINGLE : DOUBLE;
  pattern.lastIndex = at;
  return at + (pattern.exec(text)?.[0].length ?? 1);
}

/** Single quotes keep everything; in double quotes a backslash escapes `"`, `\`, `$` and backtick. */
function unquoted(raw: string): string {
  const inner = raw.slice(1, raw.length > 1 && raw.endsWith(raw[0]!) ? -1 : undefined);
  return raw[0] === "'" ? inner : inner.replace(/\\([\\"$`])|\\\n/g, "$1");
}

/** Where a `$(…)`, `${…}` or backtick run that opens at `at` closes, past the quotes and brackets inside it. */
function substitutionEnd(text: string, at: number): number {
  if (text[at] === "`") {
    const close = text.indexOf("`", at + 1);
    return close < 0 ? text.length : close + 1;
  }
  let depth = 0;
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index]!;
    if (char === "'" || char === '"') index = quoteEnd(text, index) - 1;
    else if (char === "(" || char === "{") depth++;
    else if ((char === ")" || char === "}") && --depth === 0) return index + 1;
  }
  return text.length;
}

/** The piece of a word at `at`: a quoted run, an escaped character, a substitution kept whole, or plain characters. */
function wordPart(text: string, at: number): { value: string; end: number } {
  const char = text[at];
  if (char === "'" || char === '"') {
    const end = quoteEnd(text, at);
    return { value: unquoted(text.slice(at, end)), end };
  }
  if (char === "\\") return { value: text[at + 1] === "\n" ? "" : (text[at + 1] ?? ""), end: at + 2 };
  if (char === "`" || text.startsWith("$(", at) || text.startsWith("${", at)) {
    const end = substitutionEnd(text, at);
    return { value: text.slice(at, end), end };
  }
  PLAIN.lastIndex = at;
  const run = PLAIN.exec(text)?.[0] ?? char ?? "";
  return { value: run, end: at + Math.max(run.length, 1) };
}

class TokenReader {
  private readonly tokens: ShellToken[] = [];
  private word: ShellToken | null = null;
  private at = 0;

  constructor(private readonly text: string) {}

  read(): ShellToken[] {
    while (this.at < this.text.length) this.next();
    this.flush();
    return this.tokens;
  }

  private next() {
    const char = this.text[this.at]!;
    if (/\s/.test(char)) {
      this.flush();
      this.at++;
    } else if (!this.word && char === "#") {
      this.at = lineEnd(this.text, this.at);
    } else if (!this.operator()) {
      const part = wordPart(this.text, this.at);
      this.word = { value: (this.word?.value ?? "") + part.value, operator: false, start: this.word?.start ?? this.at, end: part.end };
      this.at = part.end;
    }
  }

  /** An operator here, if there is one. `2>` and `2>&1` keep the descriptor written against them. */
  private operator(): boolean {
    OPERATOR.lastIndex = this.at;
    const operator = OPERATOR.exec(this.text)?.[0];
    if (!operator) return false;
    const descriptor = this.word && /^\d+$/.test(this.word.value) && /^[<>]/.test(operator) ? this.word : null;
    if (!descriptor) this.flush();
    this.tokens.push({ value: (descriptor?.value ?? "") + operator, operator: true, start: descriptor?.start ?? this.at, end: this.at + operator.length });
    this.word = null;
    this.at += operator.length;
    return true;
  }

  private flush() {
    if (this.word) this.tokens.push(this.word);
    this.word = null;
  }
}

/** A command's words and operators: quotes resolved, `$(…)` kept whole inside its word, comments dropped. */
export function shellTokens(text: string): ShellToken[] {
  return new TokenReader(text).read();
}

const PIPES = /^(\||\|\||\|&)$/;
const CONTROL = /^(&&|;|;;|&|\(|\))$/;
const STDOUT = /^(1?>>?|&>>?)$/;

/** One command's words with its redirections taken out, keeping where it sends its output. */
function simpleCommand(tokens: ShellToken[]): Omit<CommandLine, "next"> {
  const words: string[] = [];
  let output: CommandLine["output"] = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.operator) {
      words.push(token.value);
      continue;
    }
    // A redirection's file is not one of the command's words.
    const target = tokens[index + 1]?.operator === false ? tokens[++index]!.value : null;
    if (target !== null && STDOUT.test(token.value)) output = { path: target, append: token.value.endsWith(">>") };
  }
  return { words, output };
}

/** What a step runs first, what that output flows into, and where it goes instead of the terminal. */
export function commandLine(text: string): CommandLine {
  const segments: ShellToken[][] = [[]];
  for (const token of shellTokens(text)) {
    if (token.operator && CONTROL.test(token.value)) break;
    if (token.operator && PIPES.test(token.value)) segments.push([]);
    else segments[segments.length - 1]!.push(token);
  }
  const [first = [], ...rest] = segments;
  return { ...simpleCommand(first), next: rest.map((segment) => simpleCommand(segment).words[0] ?? "") };
}

/** The script inside a `zsh -lc '…'` wrapper, unquoted, as Codex sends it; any other command as it is. */
export function unwrapShell(command: string): string {
  const script = command.replace(/^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh) -l?c /, "");
  const tokens = shellTokens(script);
  const only = tokens.length === 1 && !tokens[0]!.operator ? tokens[0]!.value : null;
  // One quoted word holding a whole command is that command; a bare word is already itself.
  return only !== null && /\s/.test(only) ? only : script;
}
