import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Config, Provider, PermissionMode } from './config.ts';
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './config.ts';
import type { Store, Job } from './storage.ts';
import type { Update, Messenger } from './telegram.ts';
import { authorized, STOP_ACTION, INFO_ACTION, OPTIONS_ACTION } from './telegram.ts';
import type { Agent, AgentMetrics } from './providers/types.ts';
import { Interrupted, Uncertain } from './providers/types.ts';
import { errorText } from './process.ts';
import { InputBroker } from './input-broker.ts';
import { selectRunnableJobs } from './scheduler.ts';
import { transcribe } from './voice.ts';
import { formatMetrics, gitBranch } from './metrics.ts';

const HELP = '/options — меню действий\n/new — новая сессия\n/close — закрыть сессию и выбрать агента\n/sessions — сохранённые сессии\n/rename имя — переименовать\n/clear — пустой контекст, история сохранится\n/info или /status — проект, ветка, модель, usage и контекст\n/permissions — разрешения\n/stop — остановить и поставить очередь на паузу\n/queue — очередь и продолжение\n/help — справка\n\nБыстрые кнопки: ⏹ Стоп · ℹ️ Информация · ⚙️ Опции.\nНапишите задачу текстом или голосом. Ответ на вопрос агента: Reply на его сообщение.';
export type AgentFactory = (provider: Provider) => Agent;
type ActiveRun = { job: Job; abort: AbortController; agent?: Agent; promise: Promise<void>; progress?: string; progressId?: number; lastProgress: number; editing: boolean; progressTask?: Promise<void>; finishing: boolean; lastProgressText?: string };

export class Engine {
  readonly config: Config; readonly store: Store;
  #factory: AgentFactory; #messenger: Messenger;
  #inputs: InputBroker;
  #runs = new Map<string, ActiveRun>();
  #stopping = false; #lastProgressDispatch = 0;
  #lastTypingDispatch = -Infinity; #typingTask?: Promise<void>;
  #informationTasks = new Set<Promise<void>>();
  #closingTasks = new Map<string, Promise<void>>();
  available = new Set<Provider>();
  fatal?: Error;
  constructor(config: Config, store: Store, messenger: Messenger, factory: AgentFactory) {
    this.config = config; this.store = store; this.#messenger = messenger; this.#factory = factory;
    this.#inputs = new InputBroker(store, { onFatal: error => { this.fatal ??= error; }, getFatal: () => this.fatal });
  }
  get active(): boolean { return this.#runs.size > 0; }
  get activeCount(): number { return this.#runs.size; }
  private currentRun(): ActiveRun | undefined { const id = this.store.session()?.id; return id ? this.#runs.get(id) : undefined; }
  get chat(): number | undefined { const value = this.store.get('chat'); return value ? Number(value) : undefined; }
  status(): string {
    const session = this.store.session();
    return `${basename(this.config.project)} · Mac Mini\nПроект: ${this.config.project}\nАгент: ${session?.provider ?? 'не выбран'}\nСессия: ${session?.name ?? '—'}\nID: ${session?.id ?? '—'}\nРазрешения: ${session?.mode ?? this.config.mode}\nПрименено: ${session?.applied ?? 'ожидает запуска CLI'}\nСостояние: ${this.currentRun() ? this.store.job(this.currentRun()!.job.id)?.state : 'ожидает сообщения'}\nОчередь: ${this.store.session() ? this.store.queue(this.store.session()!.id).length : 0}${this.store.paused ? ' · ПАУЗА' : ''}`;
  }
  async information(): Promise<string> {
    const session = this.store.session();
    const metrics: AgentMetrics = session ? JSON.parse(this.store.get(`metrics:${session.id}`) ?? '{}') : {};
    const state = this.currentRun() ? 'выполняется задача' : this.store.paused ? 'очередь на паузе' : 'ожидает сообщения';
    const queue = session ? this.store.queue(session.id).length : 0;
    const branch = await gitBranch(this.config.project);
    return [
      `Проект: ${basename(this.config.project)}`, `Папка: ${this.config.project}`, `Ветка: ${branch}`,
      `Агент: ${session?.provider ?? 'не выбран'}`, ...formatMetrics(metrics),
      `Разрешения: ${session?.mode ?? this.config.mode}`, `Состояние: ${state}`, `В очереди: ${queue}`, `Работающих сессий: ${this.activeCount}`,
      `Недоставленных сообщений: ${this.store.failedOutputCount()}`,
    ].join('\n');
  }
  private sendInformation(): void {
    const task = this.information().then(text => { if (!this.#stopping) this.store.outgoing(text); }).catch(() => {
      if (!this.#stopping) this.store.outgoing('Не удалось собрать информацию о проекте.');
    }).finally(() => this.#informationTasks.delete(task));
    this.#informationTasks.add(task);
  }
  drainInbox(): void {
    for (let i = 0; i < 100; i++) {
      const item = this.store.pendingInput(); if (!item) break;
      const update = JSON.parse(item.payload) as Update;
      const effects: (() => void)[] = [];
      try {
        this.store.tx(() => {
          if (authorized(update, this.config.owner, this.chat)) this.route(update, effects);
          this.store.handled(item.update_id);
        });
        for (const effect of effects) effect();
      } catch (error) {
        this.store.tx(() => { this.store.outgoing(errorText(error)); this.store.handled(item.update_id); });
      }
    }
  }
  private idle(sessionId = this.store.session()?.id): void { if (sessionId && (this.#runs.has(sessionId) || this.store.busy(sessionId))) throw new Error('В этой сессии есть активные или ожидающие задачи. Остановите её или измените режим после завершения.'); }
  private chooser(): void {
    const nonce = randomUUID().slice(0, 8); this.store.set('chooser', nonce);
    const rows = [...this.available].sort((a, b) => Number(b === this.config.provider) - Number(a === this.config.provider)).map(provider => [{ text: provider === 'claude' ? 'Claude' : 'Codex', callback_data: `new:${provider}:${nonce}` }]);
    this.store.outgoing(rows.length ? 'Выберите агента для новой сессии:' : 'Агенты не найдены. Установите/авторизуйте Claude или Codex, затем перезапустите Crowl.', { inline_keyboard: rows });
  }
  private queueMenu(): void {
    const nonce = randomUUID().slice(0, 8); this.store.set('queue_menu', nonce);
    this.store.set('queue_session', this.store.session()?.id ?? '');
    this.store.outgoing(`Очередь: ${this.store.session() ? this.store.queue(this.store.session()!.id).length : 0}. ${this.store.paused ? 'На паузе.' : 'Работает.'}\n${(this.store.session() ? this.store.queue(this.store.session()!.id) : []).map((j, i) => `${i + 1}. ${j.id} · ${j.voice && !j.text ? 'голос' : (j.text ?? '').slice(0, 60)}`).join('\n')}`, { inline_keyboard: [[{ text: 'Продолжить', callback_data: `queue:resume:${nonce}` }, { text: 'Очистить', callback_data: `queue:drop:${nonce}` }]] });
  }
  private optionsMenu(): void {
    const nonce = randomUUID().slice(0, 8);
    this.store.set('options_menu', nonce);
    this.store.set('options_session', this.store.session()?.id ?? '');
    const button = (text: string, action: string) => ({ text, callback_data: `option:${action}:${nonce}` });
    this.store.outgoing('Опции', { inline_keyboard: [
      [button('Новая сессия', 'new'), button('Закрыть сессию', 'close')],
      [button('Продолжить сессию', 'sessions')],
      [button('Переименовать', 'rename'), button('Чистый контекст', 'clear')],
      [button('Разрешения', 'permissions'), button('Очередь', 'queue')],
      [button('Справка', 'help')],
    ] });
  }
  private route(update: Update, effects: (() => void)[]): void {
    const callback = update.callback_query;
    if (callback) {
      effects.push(() => { void this.#messenger.answerCallback(callback.id).catch(() => {}); });
      this.callback(callback.data ?? '', effects, update); return;
    }
    const message = update.message!;
    if (!this.chat) {
      if (message.text?.split(/\s/)[0] !== '/start') { this.store.set('chat', String(message.chat.id)); this.store.outgoing('Для начала отправьте /start.'); return; }
      this.store.set('chat', String(message.chat.id));
    }
    const incoming = message.text?.trim();
    const text = incoming === STOP_ACTION ? '/stop' : incoming === INFO_ACTION ? '/info' : incoming === OPTIONS_ACTION ? '/options' : incoming;
    if (text?.startsWith('/')) {
      const [raw, ...args] = text.split(/\s+/); const command = raw.split('@')[0];
      switch (command) {
        case '/start': if (this.store.session()) this.store.outgoing(this.status()); else this.chooser(); break;
        case '/help': this.store.outgoing(HELP); break;
        case '/options': this.optionsMenu(); break;
        case '/status':
        case '/info': effects.push(() => this.sendInformation()); break;
        case '/new': this.chooser(); break;
        case '/close': {
          const session = this.store.session();
          this.store.set('rename_session', '');
          this.store.set('active_session', ''); this.store.set('chooser', ''); this.store.set('queue_menu', '');
          if (session) {
            this.store.cancelQueued(session.id, 'Сессия закрыта владельцем');
            this.store.setPaused(session.id, false);
            effects.push(() => this.closeActiveSession(session.id));
          }
          this.chooser();
          break;
        }
        case '/clear': {
          const previous = this.store.session(); if (!previous) { this.chooser(); break; }
          this.store.set('rename_session', '');
          const session = this.store.createSession(previous.provider, previous.mode); this.store.outgoing(`Чистая сессия ${session.id}. Старый контекст сохранён в /sessions.`); break;
        }
        case '/rename': {
          const session = this.store.session(); if (!session) throw new Error('Сначала /new.');
          const name = args.join(' '); if (!name || name.length > 80) throw new Error('/rename: имя длиной 1–80 символов.');
          this.store.renameSession(session.id, name); this.store.set('rename_session', ''); this.store.outgoing(`Название: ${name}`); break;
        }
        case '/sessions': this.sessionMenu(0); break;
        case '/permissions': {
          const session = this.store.session(); if (!session) throw new Error('Сначала /new.');
          this.store.outgoing(`Запрошено: ${session.mode}\nПрименено: ${session.applied ?? 'ещё не запускалось'}\nFull: без обычных подтверждений. Ask: запросы владельцу, политика провайдера сохраняется.`, { inline_keyboard: [[{ text: 'Full access', callback_data: `mode:${session.id}:full` }, { text: 'Ask', callback_data: `mode:${session.id}:ask` }]] }); break;
        }
        case '/stop': {
          const session = this.store.session();
          if (!session) { this.store.outgoing('Сначала выберите сессию: /sessions.'); break; }
          this.store.setPaused(session.id, true);
          this.store.outgoing('Останавливаю выбранную сессию. Её очередь на паузе: /queue. Другие сессии продолжают работу.');
          effects.push(() => this.#runs.get(session.id)?.abort.abort()); break;
        }
        case '/queue': this.queueMenu(); break;
        default: this.store.outgoing('Неизвестная команда. /help');
      }
      return;
    }
    if (text && message.reply_to_message) {
      const request = this.store.pendingRequestForMessage(message.reply_to_message.message_id);
      if (request) {
        if (request.kind !== 'question') throw new Error('На запрос разрешения отвечайте его кнопками.');
        const waiter = this.#inputs.lookup(request.id);
        if (!waiter) throw new Error('Вопрос устарел.');
        this.store.answerRequest(request.id);
        effects.push(() => this.#inputs.answer(request.id, { answers: { [waiter.questionId ?? '0']: text } })); return;
      }
      const old = this.store.requestForMessage(message.reply_to_message.message_id);
      if (old) throw new Error('Этот вопрос уже закрыт. Новый запрос отправьте без Reply.');
    }
    if (message.voice && message.reply_to_message && this.store.requestForMessage(message.reply_to_message.message_id)) throw new Error('На вопрос или запрос разрешения ответьте текстом либо его кнопками.');
    const replySessionId = message.reply_to_message ? this.store.sessionForMessage(message.reply_to_message.message_id) : undefined;
    const renameSession = this.store.get('rename_session');
    if (renameSession && !replySessionId) {
      const session = this.store.session();
      if (!session || session.id !== renameSession) { this.store.set('rename_session', ''); this.store.outgoing('Сессия изменилась. Откройте «Опции → Переименовать» заново.'); return; }
      if (!text || text.length > 80) throw new Error('Введите новое имя текстом: от 1 до 80 символов.');
      this.store.renameSession(session.id, text);
      this.store.set('rename_session', ''); this.store.outgoing(`Название: ${text}`); return;
    }
    if (message.reply_to_message && !replySessionId) throw new Error('Сессия этого сообщения неизвестна. Выберите нужную сессию и отправьте сообщение без Reply.');
    if (!text && !message.voice) { this.store.outgoing('Отправьте текст или голосовое сообщение.'); return; }
    const session = replySessionId ? this.store.session(replySessionId) : this.store.session(); if (!session) { this.chooser(); return; }
    if (this.#closingTasks.has(session.id)) throw new Error('Эта сессия ещё закрывается. Дождитесь завершения остановки.');
    if (!this.available.has(session.provider)) throw new Error(`${session.provider} недоступен. Проверьте npm run doctor.`);
    if (message.voice && (message.voice.duration > 300 || (message.voice.file_size ?? 0) > 20_000_000)) throw new Error('Голосовое: максимум 5 минут и 20 MB.');
    this.store.enqueue(update.update_id, session, text ?? null, message.voice ?? null, message.message_id);
    if (this.store.pausedFor(session.id)) this.store.outgoing('Очередь этой сессии на паузе — /sessions → /queue.', undefined, undefined, undefined, message.message_id);
  }
  private sessionMenu(page: number): void {
    const sessions = this.store.sessions(page);
    const rows = sessions.map(s => [{ text: `${s.id === this.store.session()?.id ? '→ ' : ''}${this.#runs.has(s.id) ? '▶ ' : this.store.queue(s.id).length ? '◷ ' : ''}${s.provider} · ${s.name}`.slice(0, 60), callback_data: `session:${s.id}` }]);
    const nav = [];
    if (page > 0) nav.push({ text: '←', callback_data: `page:${page - 1}` });
    if (this.store.sessions(page + 1).length) nav.push({ text: '→', callback_data: `page:${page + 1}` });
    if (nav.length) rows.push(nav);
    this.store.outgoing(sessions.length ? `Сессии · страница ${page + 1}` : 'Сессий пока нет: /new.', { inline_keyboard: rows });
  }
  private callback(data: string, effects: (() => void)[], update: Update): void {
    const [action, value, detail] = data.split(':');
    if (action === 'option') {
      if (detail !== this.store.get('options_menu') || (this.store.session()?.id ?? '') !== this.store.get('options_session')) throw new Error('Меню устарело. Нажмите «Опции» заново.');
      if (value === 'rename') {
        const session = this.store.session(); if (!session) throw new Error('Сначала создайте или продолжите сессию.');
        this.store.set('rename_session', session.id);
        const nonce = randomUUID().slice(0, 8); this.store.set('rename_prompt', nonce);
        this.store.outgoing('Введите новое имя сессии следующим текстовым сообщением.', { inline_keyboard: [[{ text: 'Отмена', callback_data: `rename:cancel:${nonce}` }]] }); return;
      }
      if (!['new', 'close', 'sessions', 'clear', 'permissions', 'queue', 'help'].includes(value)) throw new Error('Неизвестная опция.');
      const callback = update.callback_query!;
      this.route({ update_id: update.update_id, message: { ...callback.message!, from: callback.from, text: `/${value}`, reply_to_message: undefined } }, effects); return;
    }
    if (action === 'rename' && value === 'cancel') {
      if (!this.store.get('rename_session') || detail !== this.store.get('rename_prompt')) throw new Error('Переименование уже закрыто.');
      this.store.set('rename_session', ''); this.store.outgoing('Переименование отменено.'); return;
    }
    if (action === 'reply') {
      const request = this.store.request(value); const waiter = this.#inputs.lookup(value);
      if (!request || request.state !== 'pending' || !waiter || waiter.kind !== 'permission' || !['yes', 'no'].includes(detail)) throw new Error('Запрос устарел или уже обработан.');
      this.store.answerRequest(value);
      effects.push(() => this.#inputs.answer(value, { allow: detail === 'yes' })); return;
    }
    if (action === 'page') { const page = Number(value); if (!Number.isInteger(page) || page < 0 || page > 10_000) throw new Error('Некорректная страница.'); this.sessionMenu(page); return; }
    if (action === 'queue') {
      if (detail !== this.store.get('queue_menu') || (this.store.session()?.id ?? '') !== this.store.get('queue_session')) throw new Error('Меню очереди устарело: /queue.');
      if (value === 'resume') { if (this.currentRun()) throw new Error('Дождитесь остановки задачи этой сессии.'); this.store.paused = false; this.store.outgoing('Очередь продолжена.'); }
      else if (value === 'drop') { this.store.cancelQueued(this.store.session()?.id ?? '', 'Удалено из очереди владельцем'); this.store.outgoing('Ожидающие задачи удалены. Состояние паузы сохранено.'); }
      else throw new Error('Неизвестное действие.');
      this.store.set('queue_menu', ''); return;
    }
    if (action === 'new') {
      if (detail !== this.store.get('chooser') || !this.available.has(value as Provider)) throw new Error('Выбор агента устарел или агент недоступен. /new');
      if (!this.store.session()) this.store.paused = false;
      this.store.set('rename_session', '');
      const session = this.store.createSession(value as Provider, this.config.mode); this.store.set('chooser', ''); this.store.outgoing(`Сессия ${session.id} · ${value}. Напишите задачу.`); return;
    }
    if (action === 'session') {
      if (!this.store.session(value)) throw new Error('Сессия не найдена.');
      this.store.set('rename_session', '');
      if (this.#closingTasks.has(value)) throw new Error('Эта сессия ещё закрывается. Выберите другую.');
      this.store.set('active_session', value);
      if (!this.store.queue(value).length) this.store.setPaused(value, false);
      this.store.outgoing(this.status()); return;
    }
    if (action === 'mode') {
      this.idle();
      const session = this.store.session();
      if (!session || session.id !== value || !['full', 'ask'].includes(detail)) throw new Error('Меню разрешений устарело. /permissions');
      this.store.setSessionMode(session.id, detail as PermissionMode);
      this.store.outgoing(`Запрошен режим ${detail}. Будет проверен и применён при следующем запуске CLI; сейчас процесс агента не работает.`); return;
    }
    throw new Error('Неизвестная или устаревшая кнопка.');
  }
  private closeActiveSession(sessionId: string): void {
    const active = this.#runs.get(sessionId);
    if (!active || this.#closingTasks.has(sessionId)) return;
    active.abort.abort();
    const task = active.promise.finally(() => this.#closingTasks.delete(sessionId));
    this.#closingTasks.set(sessionId, task);
  }
  kick(): void {
    if (this.#stopping) return;
    this.#inputs.poll();
    if (this.fatal) return;
    const ready = selectRunnableJobs(this.store.queue(), new Set(this.#runs.keys()), new Set(this.#closingTasks.keys()),
      id => this.store.pausedFor(id), this.config.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS);
    for (const job of ready) {
      const active: ActiveRun = { job, abort: new AbortController(), promise: Promise.resolve(), lastProgress: 0, editing: false, finishing: false };
      this.#runs.set(job.session_id, active);
      active.promise = this.execute(job, active.abort.signal, active).catch(error => {
        this.#stopping = true;
        this.fatal = error instanceof Error ? error : new Error(errorText(error));
      }).finally(() => { if (this.#runs.get(job.session_id) === active) this.#runs.delete(job.session_id); });
    }
  }
  private async execute(job: Job, signal: AbortSignal, active: ActiveRun): Promise<void> {
    let agent: Agent | undefined;
    try {
      this.store.state(job.id, 'preparing');
      let prompt = job.text;
      if (job.voice && !prompt) {
        active.progress = 'Расшифровываю…';
        prompt = await transcribe(this.config, this.#messenger, JSON.parse(job.voice), signal);
        if (signal.aborted) throw new Interrupted();
        this.store.setJobText(job.id, prompt!);
        active.progress = 'Обрабатываю запрос…';
      }
      if (signal.aborted) throw new Interrupted();
      const session = this.store.session(job.session_id); if (!session) throw new Error('Сессия задания отсутствует.');
      agent = this.#factory(session.provider); active.agent = agent;
      this.store.state(job.id, 'running');
      const result = await agent.run({ cwd: this.config.project, mode: session.mode, nativeId: session.native_id, prompt: prompt!, signal, callbacks: {
        nativeId: id => this.store.setNativeSessionId(session.id, id),
        applied: description => this.store.setApplied(session.id, description),
        progress: text => { active.progress = text; },
        input: (request, cancellation) => this.#inputs.ask(job.id, request, cancellation ? AbortSignal.any([signal, cancellation]) : signal),
        metrics: snapshot => {
          const key = `metrics:${session.id}`;
          const previous = JSON.parse(this.store.get(key) ?? '{}');
          if (snapshot.model && previous.model && snapshot.model !== previous.model) {
            delete previous.contextTokens; delete previous.contextWindow;
          }
          const fields = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined));
          this.store.set(key, JSON.stringify({ ...previous, ...fields }));
        },
      } });
      if (signal.aborted) throw new Interrupted();
      active.finishing = true; await active.progressTask;
      this.store.tx(() => { this.store.state(job.id, 'completed', result); this.store.event(job.id, 'run.completed', { provider: session.provider }); this.store.outgoing(result, undefined, undefined, active.progressId, job.origin_message_id ?? undefined); });
    } catch (error) {
      active.finishing = true; await active.progressTask;
      const state = signal.aborted || error instanceof Interrupted ? 'interrupted' : error instanceof Uncertain ? 'unknown' : 'failed';
      this.store.tx(() => {
        this.store.state(job.id, state, errorText(error));
        this.store.event(job.id, `run.${state}`, {});
        if (state === 'unknown' || state === 'interrupted') this.store.setPaused(job.session_id, true);
        this.store.outgoing(errorText(error), undefined, undefined, active.progressId, job.origin_message_id ?? undefined);
      });
    } finally {
      this.#inputs.rejectForJob(job.id);
      await agent?.close().catch(() => {});
    }
  }
  progress(): Promise<void> {
    if (!this.chat || Date.now() - this.#lastProgressDispatch < 2000) return Promise.resolve();
    const active = [...this.#runs.values()].filter(run => run.progress && !run.editing && !run.finishing && run.progress !== run.lastProgressText && Date.now() - run.lastProgress >= 2000).sort((a, b) => a.lastProgress - b.lastProgress)[0];
    if (!active) return Promise.resolve();
    active.editing = true; active.lastProgress = Date.now(); this.#lastProgressDispatch = Date.now();
    const text = active.progress!.slice(0, 3900), stage = active.progress, chat = this.chat;
    active.progressTask = (async () => {
      try {
        if (active.progressId) await this.#messenger.edit(chat, active.progressId, text);
        else {
          active.progressId = await this.#messenger.send(chat, text, null);
          this.store.bindMessage(active.progressId, active.job.session_id);
        }
        active.lastProgressText = stage;
        this.#lastTypingDispatch = -Infinity;
        this.store.event(active.job.id, 'progress.delivered', { messageId: active.progressId, characters: text.length });
      } catch (error) {
        // Keep UI failures diagnosable without storing model text or credentials.
        try { this.store.event(active.job.id, 'progress.failed', { error: errorText(error).replace(/\d+:[A-Za-z0-9_-]{20,}/g, '[TOKEN]').slice(0, 500) }); } catch { /* progress never determines task outcome */ }
      }
      finally { active.editing = false; }
    })();
    return active.progressTask;
  }
  typing(): Promise<void> {
    const chat = this.chat;
    if (this.#stopping || !chat || this.#typingTask || Date.now() - this.#lastTypingDispatch < 4000) return Promise.resolve();
    const thinking = [...this.#runs.values()].some(run => !run.finishing && !run.abort.signal.aborted && this.store.job(run.job.id)?.state !== 'waiting_input');
    if (!thinking) return Promise.resolve();
    this.#lastTypingDispatch = Date.now();
    this.#typingTask = this.#messenger.typing(chat).catch(() => { /* UI hint must never fail a task. */ }).finally(() => { this.#typingTask = undefined; });
    return this.#typingTask;
  }
  async stop(): Promise<void> {
    this.#stopping = true;
    const runs = [...this.#runs.values()];
    // Process cancellation must not depend on a healthy/full/writable SQLite DB.
    for (const run of runs) run.abort.abort();
    const sessions = new Set(runs.map(run => run.job.session_id));
    try { for (const job of this.store.queue()) sessions.add(job.session_id); } catch (error) { this.fatal ??= new Error(errorText(error)); }
    for (const id of sessions) { try { this.store.setPaused(id, true); } catch (error) { this.fatal ??= new Error(errorText(error)); } }
    await Promise.allSettled(runs.map(run => run.promise));
    await Promise.allSettled(this.#closingTasks.values());
    await Promise.allSettled(this.#informationTasks);
  }
  async settle(): Promise<void> {
    await Promise.all([...this.#runs.values()].map(run => run.promise));
    await Promise.all(this.#closingTasks.values());
  }
}
