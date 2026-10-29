import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ROOT, DEFAULT_MAX_CONCURRENT_SESSIONS } from './config.ts';

const ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.npmrc', '.node-version', 'README.md', 'PRD.md', 'VERIFICATION.md', 'LICENSE'];
const SOURCE_DIRS = ['src', 'scripts', 'tests', 'docs', '.github'];
const EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.json', '.md', '.yml', '.yaml', '.txt']);
const BLOCKED_NAMES = new Set(['node_modules', '.crowl', '.data', '.git', '.cache', '.env', '.env.example', '.DS_Store', 'coverage']);

export const BLANK_PROJECT_ENV = `# Создайте отдельного бота через @BotFather для этого проекта.
TELEGRAM_BOT_TOKEN=
TELEGRAM_USER_ID=

DEFAULT_PROVIDER=codex
DEFAULT_PERMISSION_MODE=full
VOICE_ENABLED=true
MAX_CONCURRENT_SESSIONS=${DEFAULT_MAX_CONCURRENT_SESSIONS}
CLAUDE_BIN=
CODEX_BIN=
WHISPER_BIN=
WHISPER_MODEL_PATH=
FFMPEG_BIN=
`;

export interface ProjectInstall {
  project: string;
  root: string;
  fileCount: number;
  nextSteps: string[];
}

const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function manifest(source: string): string[] {
  const files: string[] = [];
  const visit = (relative: string, required = false): void => {
    const absolute = join(source, relative);
    if (!existsSync(absolute)) {
      if (required) throw new Error(`В исходниках Crowl отсутствует ${relative}.`);
      return;
    }
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error(`Установка не копирует символические ссылки: ${relative}`);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (BLOCKED_NAMES.has(name) || name.startsWith('.') || name.endsWith('.log')) continue;
        visit(join(relative, name));
      }
    } else if (info.isFile()) {
      if (ROOT_FILES.includes(relative) || EXTENSIONS.has(extname(relative))) files.push(relative);
    }
  };
  for (const name of ROOT_FILES) visit(name, name === 'package.json');
  for (const name of SOURCE_DIRS) visit(name, name === 'src');
  for (const required of ['src/main.ts', 'src/config.ts']) {
    if (!files.includes(required)) throw new Error(`В исходниках Crowl отсутствует ${required}.`);
  }
  return files;
}

/** Install a fresh, credential-free Crowl copy without modifying host project files. */
export function installProject(projectPath: string, sourceRoot = ROOT): ProjectInstall {
  if (!isAbsolute(projectPath)) throw new Error('Укажите абсолютный путь существующего проекта.');
  const source = realpathSync(sourceRoot);
  const project = realpathSync(projectPath);
  if (!statSync(project).isDirectory()) throw new Error('Путь проекта должен указывать на папку.');
  if (basename(project) === '.crowl') throw new Error('Укажите папку самого проекта, а не его .crowl.');
  const destination = join(project, '.crowl');
  // lstat catches dangling symlinks too; never overwrite an existing instance.
  try { lstatSync(destination); throw new Error('В проекте уже есть .crowl. Его код, настройки и история оставлены без изменений.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Build before creating staging, including when the target lives under source.
  const files = manifest(source);
  const staging = mkdtempSync(join(project, '.crowl-install-'));
  let reserved: { dev: number; ino: number } | undefined;
  try {
    for (const relative of files) {
      const target = join(staging, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(source, relative), target);
    }
    writeFileSync(join(staging, '.env.example'), BLANK_PROJECT_ENV, { mode: 0o600 });
    writeFileSync(join(staging, '.env'), BLANK_PROJECT_ENV, { mode: 0o600 });
    // Reserve exclusively: even an empty existing .crowl must not be replaced.
    mkdirSync(destination, { mode: 0o755 });
    reserved = statSync(destination);
    renameSync(staging, destination);
    reserved = undefined;
    chmodSync(join(destination, '.env'), 0o600);
    return {
      project, root: destination, fileCount: files.length + 2,
      nextSteps: [
        `cd ${quote(destination)}`,
        'open -e .env',
        '# Заполните отдельный TELEGRAM_BOT_TOKEN; отправьте своему боту /start.',
        'npm run telegram:id',
        '# Запишите свой TELEGRAM_USER_ID в .env.',
        'npm run doctor',
        'npm start',
        '# После проверки остановите foreground через Ctrl+C и включите фон:',
        'npm run service:install',
      ],
    };
  } catch (error) {
    if (reserved) {
      try {
        const current = statSync(destination);
        if (current.dev === reserved.dev && current.ino === reserved.ino && readdirSync(destination).length === 0) rmSync(destination, { recursive: true });
      } catch { /* retain anything we cannot establish as our empty reservation */ }
    }
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function projectInstallSummary(result: ProjectInstall): string {
  return `Crowl установлен в ${result.root}\nФайлов: ${result.fileCount}. Секреты и история исходного экземпляра не перенесены.\n\n${result.nextSteps.join('\n')}\n\nДля каждого проекта нужен отдельный токен бота. Код рабочего проекта не менялся.`;
}
