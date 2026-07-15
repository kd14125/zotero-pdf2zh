// Terminal output contains real ESC/C1 control codes by definition.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /(?:\u001b[@-_]|[\u0080-\u009f])[0-?]*[ -/]*[@-~]/g;
const MAIN_PROGRESS = /\btranslate\s+[^a-z()\r\n]*?(\d+)\/(\d+)\b/i;
const STEP_PROGRESS = /(.+?)\(\d+\/\d+\)\s+.*?(\d+)\/(\d+)/;
const TQDM_PROGRESS = /\|\s*(\d+)\/(\d+)\s+\[/;

const AUTHORIZATION_PATTERN = /authorization\s*:\s*(?:bearer\s+)?[^\s,;]+/gi;
const SECRET_PATTERN = /(api[_ -]?key|token|secret|password)(\s*[:=]\s*|\s+)([^\s,;]+)/gi;

export function cleanTerminalText(value: string): string {
  return value.replace(ANSI_ESCAPE, "").replace(/\r/g, "\n");
}

export function redactLog(value: string, homePath = ""): string {
  let result = cleanTerminalText(value)
    .replace(AUTHORIZATION_PATTERN, "Authorization: <redacted>")
    .replace(SECRET_PATTERN, "$1$2<redacted>");
  if (homePath) result = result.replaceAll(homePath, "%USERPROFILE%");
  return result.trim();
}

export function parseProgress(value: string): {
  percent?: number;
  stage?: string;
  message?: string;
} {
  const clean = cleanTerminalText(value);
  const main = MAIN_PROGRESS.exec(clean) || TQDM_PROGRESS.exec(clean);
  if (main) {
    const current = Number(main[1]);
    const total = Number(main[2]);
    if (total > 0) {
      return {
        percent: Math.min(99, Math.floor((current / total) * 100)),
        stage: "翻译正文",
        message: `translate ${current}/${total}`,
      };
    }
  }
  const step = STEP_PROGRESS.exec(clean);
  if (step) return { stage: step[1].trim(), message: step[1].trim() };
  const lastLine = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return lastLine ? { message: lastLine.slice(0, 180) } : {};
}
