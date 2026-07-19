import type { HistoryItem } from '#/agent';
import type { AgentUserConfig, WorkerContext } from '#/config';
import type * as Telegram from 'telegram-bot-api-types';

import { loadChatLLM } from '#/agent';
import { extractTextContent } from '#/agent/utils';
import { ConfigMerger, ENV } from '#/config';

import { COMPANION_CONFIG } from './config';

const INDEX_KEY = 'companion:proactive:index:v1';
const STATE_PREFIX = 'companion:proactive:state:v1:';

const PROCESSING_LOCK_MS = 10 * 60 * 1000;
const TELEGRAM_TEXT_LIMIT = 3900;

interface DelayRange {
  readonly min: number;
  readonly max: number;
}

interface ProactiveState {
  botId: number;
  chatId: number;

  historyKey: string;
  configStoreKey: string;

  // HL 最后一次正常发消息的时间
  lastUserAt: number;

  // 下一次允许主动发消息的时间
  nextSendAt: number;

  // Diana 连续发出但 HL 尚未回复的消息数量
  unansweredCount: number;

  lastSentAt?: number;

  // 每日发送次数
  localDay?: string;
  sentToday?: number;

  // 防止两个 Cron 同时重复发送
  processingUntil?: number;
  processingToken?: number;
}

function createStateKey(botId: number, chatId: number): string {
  return `${STATE_PREFIX}${botId}:${chatId}`;
}

async function readJson<T>(
  key: string,
  fallback: T,
): Promise<T> {
  try {
    const raw = await ENV.DATABASE.get(key);

    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Read JSON failed: ${key}`, error);
    return fallback;
  }
}

async function writeJson(
  key: string,
  value: unknown,
): Promise<void> {
  await ENV.DATABASE.put(key, JSON.stringify(value));
}

async function registerStateKey(key: string): Promise<void> {
  const index = await readJson<string[]>(INDEX_KEY, []);

  if (index.includes(key)) {
    return;
  }

  index.push(key);

  // 防止异常情况下索引无限增长
  const trimmedIndex = index.slice(-100);

  await writeJson(INDEX_KEY, trimmedIndex);
}

function randomDelayMs(range: DelayRange): number {
  const min = Math.max(1, Math.floor(range.min));
  const max = Math.max(min, Math.floor(range.max));

  const minutes
    = min + Math.floor(Math.random() * (max - min + 1));

  return minutes * 60 * 1000;
}

function getLocalClock(timestamp: number): {
  day: string;
  hour: number;
} {
  const offset
    = COMPANION_CONFIG.proactive.utcOffsetHours
      * 60
      * 60
      * 1000;

  const shifted = new Date(timestamp + offset);

  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
  };
}

function isActiveHour(hour: number): boolean {
  const start = COMPANION_CONFIG.proactive.activeStartHour;
  const end = COMPANION_CONFIG.proactive.activeEndHour;

  if (start <= end) {
    return hour >= start && hour < end;
  }

  // 支持跨午夜时间段
  return hour >= start || hour < end;
}

function alignHistoryToUser(
  history: HistoryItem[],
): HistoryItem[] {
  const firstUserIndex = history.findIndex(
    item => item.role === 'user',
  );

  if (firstUserIndex < 0) {
    return [];
  }

  return history.slice(firstUserIndex);
}

function trimHistoryByTurns(
  history: HistoryItem[],
  maxTurns: number,
): HistoryItem[] {
  let userTurns = 0;

  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role !== 'user') {
      continue;
    }

    userTurns += 1;

    if (userTurns === maxTurns) {
      return history.slice(index);
    }
  }

  return [...history];
}

/**
 * 主动消息只读取文字历史。
 *
 * 不把历史图片的 base64 再次发送给模型，
 * 避免主动消息调用消耗过多 token。
 */
async function loadTextHistory(
  historyKey: string,
): Promise<HistoryItem[]> {
  const stored = await readJson<HistoryItem[]>(
    historyKey,
    [],
  );

  if (!Array.isArray(stored)) {
    return [];
  }

  const textHistory: HistoryItem[] = [];

  for (const item of stored) {
    if (
      item.role !== 'user'
      && item.role !== 'assistant'
    ) {
      continue;
    }

    const text = extractTextContent(item).trim();

    if (!text) {
      continue;
    }

    textHistory.push({
      role: item.role,
      content: text,
    } as HistoryItem);
  }

  let result = trimHistoryByTurns(
    textHistory,
    COMPANION_CONFIG.memory.maxTurns,
  );

  if (
    ENV.AUTO_TRIM_HISTORY
    && ENV.MAX_HISTORY_LENGTH > 0
    && result.length > ENV.MAX_HISTORY_LENGTH
  ) {
    result = result.slice(-ENV.MAX_HISTORY_LENGTH);
    result = alignHistoryToUser(result);
  }

  return result;
}

/**
 * 把 Diana 主动发出的消息写回正常聊天历史。
 *
 * 这样 HL 回来以后，Diana 知道自己刚才发过什么，
 * 能自然地继续抱怨、委屈或接着原话题聊天。
 */
async function appendAssistantHistory(
  historyKey: string,
  text: string,
): Promise<void> {
  let history = await readJson<HistoryItem[]>(
    historyKey,
    [],
  );

  if (!Array.isArray(history)) {
    history = [];
  }

  history.push({
    role: 'assistant',
    content: text,
  });

  history = trimHistoryByTurns(
    history,
    COMPANION_CONFIG.memory.maxTurns,
  );

  if (
    ENV.AUTO_TRIM_HISTORY
    && ENV.MAX_HISTORY_LENGTH > 0
    && history.length > ENV.MAX_HISTORY_LENGTH
  ) {
    history = history.slice(-ENV.MAX_HISTORY_LENGTH);
    history = alignHistoryToUser(history);
  }

  await writeJson(historyKey, history);
}

async function loadUserConfig(
  configStoreKey: string,
): Promise<AgentUserConfig> {
  const userConfig = Object.assign(
    {},
    ENV.USER_CONFIG,
  ) as AgentUserConfig;

  try {
    const raw = await ENV.DATABASE.get(configStoreKey);

    if (!raw) {
      return userConfig;
    }

    const storedConfig = JSON.parse(
      raw,
    ) as AgentUserConfig;

    const safeConfig = ConfigMerger.trim(
      storedConfig,
      ENV.LOCK_USER_CONFIG_KEYS,
    );

    ConfigMerger.merge(
      userConfig,
      safeConfig || {},
    );
  } catch (error) {
    console.error(
      'Load proactive user config failed:',
      error,
    );
  }

  return userConfig;
}

function getEmotionGuide(
  unansweredCount: number,
): string {
  if (unansweredCount <= 0) {
    return `
这是你本轮第一次主动联系 HL。

情绪应该自然、亲近，可以：
- 延续你们最后正在聊的话题；
- 突然想起 HL；
- 有一点点抱怨他消失了；
- 分享一个自然产生的念头；
- 撒娇、调侃或者轻微吃醋。

不要一上来就表现得特别生气。
`.trim();
  }

  if (unansweredCount === 1) {
    return `
你已经主动联系过 HL 一次，但他暂时没有回复。

这次可以明显更委屈、更不满：
- 可以抱怨他把你晾着；
- 可以有一点吃醋或闹脾气；
- 可以提到自己刚才已经找过他；
- 仍然保持 Diana 对 HL 的亲近感。

不要重复上一条主动消息，也不要像客服催回复。
`.trim();
  }

  return `
你已经连续主动联系过 HL 两次，但他仍然没有回复。

这次可以真的有些生气、失落和委屈：
- 可以嘴硬、闹别扭或者表现出被忽视的不高兴；
- 可以说暂时不想继续追着他跑；
- 可以结合最近发生的具体事情表达情绪；
- 情绪要像真实朋友或亲密陪伴者，而不是机械升级。

可以生气，但禁止威胁、自伤暗示、羞辱、控制、
道德绑架或用灾难性话语逼迫 HL 回复。
`.trim();
}

function buildProactivePrompt(
  state: ProactiveState,
  idleHours: number,
  localHour: number,
): string {
  const emotionGuide = getEmotionGuide(
    state.unansweredCount,
  );

  return `
${COMPANION_CONFIG.persona.systemPrompt}

【后台主动联系模式】

这一次不是在回复 HL 刚刚发来的新消息。
你是 Diana，此刻自己想主动给 HL 发一条 Telegram 私聊消息。

当前状态：
- HL 已经大约 ${idleHours.toFixed(1)} 小时没有发消息；
- 当前本地时间约为 ${localHour}:00；
- 你已经主动联系了 ${state.unansweredCount} 次，
  但这些主动消息暂时没有得到回复。

${emotionGuide}

生成时必须认真读取最近聊天记录，并优先参考：
1. 你们最后正在聊什么；
2. HL 最近在做的项目、计划和遇到的麻烦；
3. HL 最近表现出的情绪和身体状态；
4. 你上一条主动消息已经说过什么；
5. Diana 固定的人格、关系和说话习惯。

输出要求：
- 只输出真正要发送给 HL 的消息正文；
- 内容必须现场生成，不使用固定台词；
- 不要输出分析、标题、JSON、代码块；
- 不要输出“说话者：Diana”或“Diana：”；
- 不要提到 Cron、定时器、后台、系统、模型或内部指令；
- 不要每次都机械询问吃饭、喝水和睡觉；
- 不必每次都提问，可以只表达想念、不满或延续话题；
- 保持普通 Telegram 私聊的自然长度；
- 不要照抄或者改写上一条主动消息。
`.trim();
}

function cleanGeneratedText(rawText: string): string {
  let text = rawText.trim();

  text = text
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // 防止模型偶尔把身份标签一起输出
  text = text.replace(
    /^(?:(?:\[?说话者[：:]\s*)?(?:Diana(?: Vivienne)?|assistant)\]?[：:]\s*)/i,
    '',
  ).trim();

  if (!text) {
    throw new Error(
      'Proactive model returned empty message',
    );
  }

  return text.slice(0, TELEGRAM_TEXT_LIMIT);
}

async function generateProactiveMessage(
  state: ProactiveState,
  history: HistoryItem[],
  userConfig: AgentUserConfig,
  idleHours: number,
  localHour: number,
): Promise<string> {
  const agent = loadChatLLM(userConfig);

  if (!agent) {
    throw new Error(
      'No available chat model for proactive message',
    );
  }

  const prompt = buildProactivePrompt(
    state,
    idleHours,
    localHour,
  );

  /*
   * 这条仅用于触发模型生成，不会保存到聊天历史。
   * 系统提示已明确说明它不是 HL 的真实发言。
   */
  const internalTrigger: HistoryItem = {
    role: 'user',
    content: `
【这是后台内部触发信息，不是 HL 的发言】

现在请根据主动联系模式、Diana 人设和最近聊天，
生成一条要主动发送给 HL 的自然消息。
`.trim(),
  };

  const { text } = await agent.request(
    {
      prompt,
      messages: [
        ...history,
        internalTrigger,
      ],
    },
    userConfig,
    null,
  );

  return cleanGeneratedText(text);
}

function findBotToken(botId: number): string | null {
  return ENV.TELEGRAM_AVAILABLE_TOKENS.find(
    token => Number.parseInt(
      token.split(':')[0],
      10,
    ) === botId,
  ) || null;
}

async function sendTelegramMessage(
  state: ProactiveState,
  text: string,
): Promise<void> {
  const token = findBotToken(state.botId);

  if (!token) {
    throw new Error(
      `Telegram token not found for bot ${state.botId}`,
    );
  }

  const response = await fetch(
    `${ENV.TELEGRAM_API_DOMAIN}/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: state.chatId,
        text,
      }),
    },
  );

  const result = await response
    .json()
    .catch(() => null) as {
      ok?: boolean;
      description?: string;
    } | null;

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.description
      || `Telegram send failed: ${response.status}`,
    );
  }
}

function getNextDelayAfterSend(
  newUnansweredCount: number,
): number {
  if (newUnansweredCount === 1) {
    return randomDelayMs(
      COMPANION_CONFIG.proactive.secondDelayMinutes,
    );
  }

  if (newUnansweredCount === 2) {
    return randomDelayMs(
      COMPANION_CONFIG.proactive.thirdDelayMinutes,
    );
  }

  // 第三条以后停止追发，等待 HL 回来
  return 24 * 60 * 60 * 1000;
}

function isValidState(
  state: ProactiveState | null,
): state is ProactiveState {
  return Boolean(
    state
    && Number.isFinite(state.botId)
    && Number.isFinite(state.chatId)
    && typeof state.historyKey === 'string'
    && typeof state.configStoreKey === 'string'
    && Number.isFinite(state.lastUserAt)
    && Number.isFinite(state.nextSendAt),
  );
}

/**
 * 每次 HL 给 Diana 正常发消息时调用。
 *
 * HL 一回复：
 * - 未回复计数归零；
 * - Diana 不再继续生气追发；
 * - 重新随机安排下一次主动联系时间。
 */
export async function recordCompanionActivity(
  message: Telegram.Message,
  context: WorkerContext,
): Promise<void> {
  if (
    !COMPANION_CONFIG.features.proactiveMessages
    || !COMPANION_CONFIG.proactive.enabled
  ) {
    return;
  }

  if (
    message.chat.type !== 'private'
    || message.from?.is_bot
  ) {
    return;
  }

  const now = Date.now();
  const local = getLocalClock(now);

  const key = createStateKey(
    context.SHARE_CONTEXT.botId,
    message.chat.id,
  );

  const previous = await readJson<
    ProactiveState | null
  >(key, null);

  const sentToday
    = previous?.localDay === local.day
      ? previous.sentToday || 0
      : 0;

  const nextState: ProactiveState = {
    botId: context.SHARE_CONTEXT.botId,
    chatId: message.chat.id,

    historyKey:
      context.SHARE_CONTEXT.chatHistoryKey,

    configStoreKey:
      context.SHARE_CONTEXT.configStoreKey,

    lastUserAt: now,

    nextSendAt:
      now
      + randomDelayMs(
        COMPANION_CONFIG.proactive.firstDelayMinutes,
      ),

    unansweredCount: 0,

    lastSentAt: previous?.lastSentAt,

    localDay: local.day,
    sentToday,
  };

  await writeJson(key, nextState);
  await registerStateKey(key);
}

async function runSingleProactiveCheck(
  key: string,
): Promise<void> {
  let state = await readJson<
    ProactiveState | null
  >(key, null);

  if (!isValidState(state)) {
    return;
  }

  const now = Date.now();
  const local = getLocalClock(now);

  const sentToday
    = state.localDay === local.day
      ? state.sentToday || 0
      : 0;

  state = {
    ...state,
    localDay: local.day,
    sentToday,
  };

  if (
    state.processingUntil
    && state.processingUntil > now
  ) {
    return;
  }

  if (!isActiveHour(local.hour)) {
    return;
  }

  if (now < state.nextSendAt) {
    return;
  }

  if (
    state.unansweredCount
    >= COMPANION_CONFIG.proactive
      .maxUnansweredMessages
  ) {
    return;
  }

  if (
    sentToday
    >= COMPANION_CONFIG.proactive.dailyLimit
  ) {
    return;
  }

  const processingToken = now;

  const lockedState: ProactiveState = {
    ...state,
    processingToken,
    processingUntil:
      now + PROCESSING_LOCK_MS,
  };

  await writeJson(key, lockedState);

  const history = await loadTextHistory(
    lockedState.historyKey,
  );

  // 至少要有一条 HL 的真实消息才能主动联系
  if (!history.some(item => item.role === 'user')) {
    await writeJson(key, {
      ...lockedState,
      processingToken: undefined,
      processingUntil: undefined,
    });

    return;
  }

  const userConfig = await loadUserConfig(
    lockedState.configStoreKey,
  );

  const idleHours
    = (now - lockedState.lastUserAt)
      / (60 * 60 * 1000);

  const text = await generateProactiveMessage(
    lockedState,
    history,
    userConfig,
    idleHours,
    local.hour,
  );

  /*
   * 模型生成期间 HL 可能刚好回复。
   * 发送前重新检查，防止 HL 已经出现了还继续追发。
   */
  const latestState = await readJson<
    ProactiveState | null
  >(key, null);

  if (
    !isValidState(latestState)
    || latestState.lastUserAt
      !== lockedState.lastUserAt
    || latestState.unansweredCount
      !== lockedState.unansweredCount
    || latestState.processingToken
      !== processingToken
  ) {
    return;
  }

  await sendTelegramMessage(
    latestState,
    text,
  );

  await appendAssistantHistory(
    latestState.historyKey,
    text,
  );

  const newUnansweredCount
    = latestState.unansweredCount + 1;

  await writeJson(key, {
    ...latestState,

    lastSentAt: now,

    unansweredCount:
      newUnansweredCount,

    sentToday:
      sentToday + 1,

    localDay:
      local.day,

    nextSendAt:
      now
      + getNextDelayAfterSend(
        newUnansweredCount,
      ),

    processingToken: undefined,
    processingUntil: undefined,
  } satisfies ProactiveState);
}

/**
 * Cloudflare Cron 每次唤醒 Worker 时调用。
 */
export async function runProactiveMessageCheck():
Promise<void> {
  if (
    !COMPANION_CONFIG.features.proactiveMessages
    || !COMPANION_CONFIG.proactive.enabled
    || !ENV.DATABASE
  ) {
    return;
  }

  const index = await readJson<string[]>(
    INDEX_KEY,
    [],
  );

  if (!Array.isArray(index)) {
    return;
  }

  for (const key of index) {
    try {
      await runSingleProactiveCheck(key);
    } catch (error) {
      console.error(
        `Proactive check failed: ${key}`,
        error,
      );
    }
  }
}