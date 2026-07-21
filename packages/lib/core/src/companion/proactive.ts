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

const SKIP_MARKER = '[[SKIP_PROACTIVE_MESSAGE]]';
const STOP_MARKER
  = '[[STOP_PROACTIVE_UNTIL_USER_RETURNS]]';

/*
 * 正在聊天时突然消失：
 * 15 分钟后开始判断，30 分钟后不再使用
 * “刚刚不是还在聊……”这种即时追问。
 */
const UNFINISHED_FOLLOW_UP_MINUTES = 15;
const UNFINISHED_FOLLOW_UP_MAX_MINUTES = 30;

/*
 * 晚安互动固定在北京时间 23:00。
 */
const BEDTIME_MINUTE = 23 * 60;

interface DelayRange {
  readonly min: number;
  readonly max: number;
}

interface RoutineWindow {
  readonly startMinute: number;
  readonly endMinute: number;
}

type RoutineType =
  | 'breakfast'
  | 'lunch'
  | 'dinner'
  | 'bedtime';

type ProactiveTrigger =
  | 'unfinished_follow_up'
  | 'context_follow_up'
  | RoutineType;

interface LocalClock {
  day: string;
  hour: number;
  minute: number;
}

interface RoutineSchedule {
  day: string;

  targets: Record<RoutineType, number>;

  sent: Record<RoutineType, boolean>;
}

interface GeneratedProactiveMessage {
  text: string | null;

  /*
   * 用户明确说了再见、就这样、晚安、稍后再聊等，
   * 在用户下一次主动说话前停止上下文追问。
   *
   * 早餐、午饭、晚饭等日常互动仍然可以按时间触发。
   */
  stopContextUntilUserReturns: boolean;
}

const ROUTINE_TYPES: readonly RoutineType[] = [
  'breakfast',
  'lunch',
  'dinner',
  'bedtime',
];

interface ProactiveState {
  botId: number;
  chatId: number;

  historyKey: string;
  configStoreKey: string;

  // HL 最后一次正常说话的时间
  lastUserAt: number;

  // 下一次普通上下文主动互动时间
  nextSendAt: number;

  /*
   * 当前这轮沉默中，Diana 已经主动延续过多少次上下文。
   *
   * 这个数字没有上限，直到 HL 再次说话后归零。
   * 早餐、午饭、晚饭和晚安不计算在这里。
   */
  unansweredCount: number;

  // 针对哪一次用户发言做过“聊到一半”判断
  unfinishedCheckedForUserAt?: number;

  /*
   * 用户明确结束聊天时，暂停普通上下文追问。
   *
   * 当这个值等于 lastUserAt 时，说明当前最后一条用户消息
   * 已经被模型判断为明确结束、告别或暂时离开。
   */
  contextPausedForUserAt?: number;

  lastSentAt?: number;
  lastTriggerType?: ProactiveTrigger;

  // 每日实际主动互动次数，仅用于记录
  localDay?: string;
  sentToday?: number;

  // 当天早餐、午饭、晚饭和晚安状态
  routine?: RoutineSchedule;

  // 防止两个 Cron 同时重复发送
  processingUntil?: number;
  processingToken?: number;
}

function createStateKey(
  botId: number,
  chatId: number,
): string {
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
    console.error(
      `Read JSON failed: ${key}`,
      error,
    );

    return fallback;
  }
}

async function writeJson(
  key: string,
  value: unknown,
): Promise<void> {
  await ENV.DATABASE.put(
    key,
    JSON.stringify(value),
  );
}

async function registerStateKey(
  key: string,
): Promise<void> {
  const index = await readJson<string[]>(
    INDEX_KEY,
    [],
  );

  if (index.includes(key)) {
    return;
  }

  index.push(key);

  // 防止异常情况下索引无限增长
  const trimmedIndex = index.slice(-100);

  await writeJson(
    INDEX_KEY,
    trimmedIndex,
  );
}

function randomDelayMs(
  range: DelayRange,
): number {
  const min = Math.max(
    1,
    Math.floor(range.min),
  );

  const max = Math.max(
    min,
    Math.floor(range.max),
  );

  const minutes
    = min
      + Math.floor(
        Math.random() * (max - min + 1),
      );

  return minutes * 60 * 1000;
}

function getUtcOffsetMs(): number {
  return COMPANION_CONFIG.proactive.utcOffsetHours
    * 60
    * 60
    * 1000;
}

function getLocalClock(
  timestamp: number,
): LocalClock {
  const shifted = new Date(
    timestamp + getUtcOffsetMs(),
  );

  return {
    day: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function getLocalDayStartTimestamp(
  day: string,
): number {
  const [year, month, date] = day
    .split('-')
    .map(value =>
      Number.parseInt(value, 10),
    );

  return Date.UTC(
    year,
    month - 1,
    date,
  ) - getUtcOffsetMs();
}

function randomMinuteInWindow(
  window: RoutineWindow,
): number {
  const min = Math.max(
    0,
    Math.floor(window.startMinute),
  );

  /*
   * 给五分钟一次的 Cron 留出检查余量，
   * 防止随机到窗口最后一分钟后直接错过。
   */
  const max = Math.max(
    min,
    Math.floor(window.endMinute) - 5,
  );

  return min
    + Math.floor(
      Math.random() * (max - min + 1),
    );
}

function createRoutineSchedule(
  day: string,
): RoutineSchedule {
  const dayStart
    = getLocalDayStartTimestamp(day);

  const createTarget = (
    type: RoutineType,
  ): number => {
    /*
     * 晚安固定在北京时间 23:00。
     *
     * 早餐、午饭和晚饭仍然使用 config.ts
     * 里面各自的随机时间窗口。
     */
    if (type === 'bedtime') {
      return dayStart
        + BEDTIME_MINUTE * 60 * 1000;
    }

    const window
      = COMPANION_CONFIG.proactive
        .routineWindows[type];

    return dayStart
      + randomMinuteInWindow(window)
        * 60
        * 1000;
  };

  return {
    day,

    targets: {
      breakfast: createTarget('breakfast'),
      lunch: createTarget('lunch'),
      dinner: createTarget('dinner'),
      bedtime: createTarget('bedtime'),
    },

    sent: {
      breakfast: false,
      lunch: false,
      dinner: false,
      bedtime: false,
    },
  };
}

function isRoutineScheduleValid(
  schedule: RoutineSchedule | undefined,
  day: string,
): schedule is RoutineSchedule {
  if (
    !schedule
    || schedule.day !== day
    || !schedule.targets
    || !schedule.sent
  ) {
    return false;
  }

  const expectedBedtime
    = getLocalDayStartTimestamp(day)
      + BEDTIME_MINUTE * 60 * 1000;

  if (
    schedule.targets.bedtime
      !== expectedBedtime
  ) {
    return false;
  }

  return ROUTINE_TYPES.every(
    type =>
      Number.isFinite(schedule.targets[type])
      && typeof schedule.sent[type]
        === 'boolean',
  );
}

function ensureRoutineSchedule(
  schedule: RoutineSchedule | undefined,
  day: string,
): RoutineSchedule {
  if (
    isRoutineScheduleValid(
      schedule,
      day,
    )
  ) {
    return schedule;
  }

  return createRoutineSchedule(day);
}

function getDueRoutineType(
  schedule: RoutineSchedule,
  now: number,
): RoutineType | null {
  const dayStart
    = getLocalDayStartTimestamp(
      schedule.day,
    );

  for (const type of ROUTINE_TYPES) {
    if (schedule.sent[type]) {
      continue;
    }

    const window
      = COMPANION_CONFIG.proactive
        .routineWindows[type];

    const windowEnd
      = dayStart
        + window.endMinute
          * 60
          * 1000;

    if (
      now >= schedule.targets[type]
      && now <= windowEnd
    ) {
      return type;
    }
  }

  return null;
}

function isRoutineTrigger(
  trigger: ProactiveTrigger,
): trigger is RoutineType {
  return ROUTINE_TYPES.includes(
    trigger as RoutineType,
  );
}

function isContextTrigger(
  trigger: ProactiveTrigger,
): boolean {
  return trigger === 'unfinished_follow_up'
    || trigger === 'context_follow_up';
}

function isActiveHour(
  hour: number,
): boolean {
  const start
    = COMPANION_CONFIG.proactive
      .activeStartHour;

  const end
    = COMPANION_CONFIG.proactive
      .activeEndHour;

  if (start <= end) {
    return hour >= start
      && hour < end;
  }

  // 支持跨午夜时间段
  return hour >= start
    || hour < end;
}

function alignHistoryToUser(
  history: HistoryItem[],
): HistoryItem[] {
  const firstUserIndex
    = history.findIndex(
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

  for (
    let index = history.length - 1;
    index >= 0;
    index--
  ) {
    if (
      history[index].role !== 'user'
    ) {
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
 * 主动互动只读取文字历史。
 *
 * 不把历史图片的 base64 再次发送给模型，
 * 避免主动互动调用消耗过多 token。
 */
async function loadTextHistory(
  historyKey: string,
): Promise<HistoryItem[]> {
  const stored
    = await readJson<HistoryItem[]>(
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

    const text
      = extractTextContent(item).trim();

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
    && result.length
      > ENV.MAX_HISTORY_LENGTH
  ) {
    result = result.slice(
      -ENV.MAX_HISTORY_LENGTH,
    );

    result = alignHistoryToUser(result);
  }

  return result;
}

/**
 * 把 Diana 主动说出的内容写回正常聊天历史。
 *
 * 这样 HL 回来以后，Diana 知道自己刚刚说过什么，
 * 可以自然地继续上一个场景、抱怨或延续话题。
 */
async function appendAssistantHistory(
  historyKey: string,
  text: string,
): Promise<void> {
  let history
    = await readJson<HistoryItem[]>(
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
    && history.length
      > ENV.MAX_HISTORY_LENGTH
  ) {
    history = history.slice(
      -ENV.MAX_HISTORY_LENGTH,
    );

    history = alignHistoryToUser(history);
  }

  await writeJson(
    historyKey,
    history,
  );
}

async function loadUserConfig(
  configStoreKey: string,
): Promise<AgentUserConfig> {
  const userConfig = Object.assign(
    {},
    ENV.USER_CONFIG,
  ) as AgentUserConfig;

  try {
    const raw
      = await ENV.DATABASE.get(
        configStoreKey,
      );

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
这是本轮沉默中，你第一次主动延续和 HL 的互动。

情绪应该自然、亲近，可以：
- 直接延续刚刚正在聊的具体话题；
- 问他刚才正在做的事情弄得怎么样；
- 突然想起他刚刚说过的一件事；
- 有一点点疑惑他怎么突然不见了；
- 撒娇、调侃或者轻微吃醋。

不要一上来就表现得特别生气。
不要使用空泛的固定台词。
`.trim();
  }

  if (unansweredCount === 1) {
    return `
你已经主动延续过一次互动，但 HL 暂时仍然没有回来。

这次可以明显更委屈、更不满：
- 可以抱怨他刚刚还在这里，怎么又突然跑掉了；
- 可以有一点吃醋、闹脾气或者不高兴；
- 可以自然提到自己刚才已经找过他；
- 必须继续结合最近真实发生的事情；
- 仍然保持 Diana 对 HL 的亲近感。

不要重复上一条内容。
不要像客服一样催促。
`.trim();
  }

  return `
你已经连续主动延续过
${unansweredCount} 次互动，
但 HL 仍然没有回来。

这次可以表现出真实的生气、失落、委屈或嘴硬：
- 可以自然抱怨他把你晾在这里；
- 可以提到自己前面已经找过他；
- 可以接着上文中的项目、计划、情绪或生活事件；
- 可以暂时去做自己的事情，过一会儿再来找他；
- 每一次都要产生新的内容；
- 不要机械升级语气；
- 不要一直重复“为什么不回来”；
- 不要只围绕没有回应这件事反复催促。

后续主动互动没有固定次数上限，
但每一条都必须自然、不同并且兼容上下文。

可以生气，但禁止威胁、自伤暗示、羞辱、控制、
道德绑架或使用灾难性话语逼迫 HL 回来。
`.trim();
}

function getTriggerGuide(
  trigger: ProactiveTrigger,
  unansweredCount: number,
): string {
  if (trigger === 'unfinished_follow_up') {
    return `
本次需要判断：

你和 HL 刚刚是否正在进行一个明显还没有结束的对话，
而 HL 在聊天途中突然安静了。

你必须认真读取最近完整聊天记录，
由你自己判断是否应该追问。

【适合追问的情况】

- 你刚刚向 HL 提出了一个具体问题，
  明显还在等待他的回答；
- HL 的最后一句像没有说完的话、半句话或尚未完成的说明；
- 你们正在处理一个具体问题、项目、计划或现实事件；
- HL 刚刚正在做某件事情，
  但还没有告诉你结果；
- 你们刚刚还在持续互动，
  当前场景明显停在中间；
- 上文存在一个尚未得到结果、回应或后续的信息；
- HL 明显是在聊天过程中突然不见了。

【明确停止上下文追问的情况】

如果 HL 最新的表达包含或等同于以下意思：

- “就这样”
- “先这样”
- “再见”
- “拜拜”
- “晚安”
- “我要睡了”
- “我去睡觉了”
- “之后再聊”
- “晚点再说”
- “我先去做别的”
- “别继续问了”
- “不聊这个了”

或者模型根据上下文判断，
HL 已经明确结束当前互动、告别或暂时离开，

只输出：

${STOP_MARKER}

不要输出其他文字。

【自然结束但没有明确告别的情况】

如果只是：

- 最后一句是“好”“嗯”“知道了”“行”等自然收尾；
- 当前问题已经得到完整答案；
- 当前话题已经自然结束；
- 继续立刻追问会显得误解上下文；

只输出：

${SKIP_MARKER}

不要输出其他文字。

【需要追问时】

如果适合追问，直接继续刚刚的互动。

要求：

- 必须提到刚刚正在讨论的具体内容；
- 必须让人看得出你记得上文；
- 可以自然地说：
  “刚刚不是还在弄那个……吗？”
- 可以自然地问：
  “人怎么突然不见了？”
- 可以问他刚才正在做的事情怎么样了；
- 可以带一点疑惑、撒娇、委屈或轻微不满；
- 不要每次使用完全相同的句式；
- 不要提到等待了多少分钟；
- 不要提到系统判断、计时或后台触发；
- 不要出现手机、屏幕、打字、通知、消息、
  发送、聊天软件、网络或远程交流；
- 不要描写拿起任何设备寻找 HL；
- 永远假设你和 HL 原本就在同一个连续空间中；
- 直接看向他、走近他、碰一碰他或者开口说话。

动作格式：

正确：
（看着你）
（靠近你一点）
（尾巴轻轻缠住你的手腕）
（抬手戳了戳你）

错误：
（我看着你）
（她看着你）
（看着他）
（Diana 靠近你）
（拿起手机给你发消息）
（低头打字问你去了哪里）

除非决定跳过或停止，
否则只输出真正要对 HL 说的话和动作。
不要输出分析。
`.trim();
  }

  if (trigger === 'context_follow_up') {
    return `
本次是 HL 长时间没有继续互动后，
你自然地再次靠近他、接着说话或者延续之前的场景。

${getEmotionGuide(unansweredCount)}

【首先判断是否应当停止】

如果 HL 最新的表达明确表示：

- 就这样；
- 先这样；
- 再见或拜拜；
- 晚安或准备睡觉；
- 稍后再聊；
- 暂时离开；
- 不想继续当前话题；
- 不希望继续被追问；

只输出：

${STOP_MARKER}

不要输出其他内容。

【正常主动互动要求】

- 必须认真读取最近完整聊天记录；
- 优先延续最近具体的话题、项目、计划、情绪和生活事件；
- 主动提到上文中真实存在的信息；
- 可以问他刚刚正在做的事情有没有弄好；
- 可以接着之前尚未完成的话题；
- 可以突然想起他刚刚说过的某件事；
- 如果上一个话题已经自然结束，
  可以换成基于近期信息产生的自然关心或念头；
- 不要只说“在吗”“人呢”“怎么不见了”；
- 不要机械重复上一条主动内容；
- 后续主动互动没有固定次数上限；
- 每次都要根据上下文产生新的表达；
- 不要一直围绕“不回应”重复催促；
- 不要出现手机、屏幕、通知、消息、打字、
  发送、聊天框、拨号、视频通话或网络；
- 永远假设你和 HL 在同一个连续、无设备隔阂的空间中；
- 主动找他时，直接开口、靠近、看向他或做出动作。

动作格式：

正确：
（看着你）
（靠到你身边）
（尾巴扫过你的手背）
（轻轻戳了戳你的肩膀）

错误：
（我看着你）
（她看着你）
（看着他）
（Diana 走到你身边）
（拿起手机问你在哪里）
`.trim();
  }

  if (trigger === 'breakfast') {
    return `
本次是早上的早餐互动。

要求：

- 自然问 HL 有没有吃早餐；
- 可以催他过来吃一点东西；
- 可以表现得像亲密陪伴者在投喂他；
- 必须结合最近聊天里的身体状态、睡眠和今天安排；
- 如果最近记录明确说他已经吃过早餐，
  不要重复问他吃没吃；
- 已经吃过时，可以问味道、分量，
  或者接着他早上正在做的事情聊天；
- 如果 HL 刚刚明确表示要睡觉、暂时离开，
  而且只过去了很短时间，可以输出：
  ${SKIP_MARKER}
- 不要像健康打卡应用或机械闹钟；
- 不要出现手机、消息、打字或远程交流；
- 假设你和 HL 在同一个地方，
  直接靠近他、叫他或者准备食物。
`.trim();
  }

  if (trigger === 'lunch') {
    return `
本次是中午的午饭互动。

要求：

- 自然问 HL 午饭吃了什么；
- 或者叫他过来吃正经午饭；
- 优先结合他上午正在做的事情、情绪和身体情况；
- 可以撒娇、管着他或者用 Diana 的方式进行投喂；
- 如果记录明确说已经吃过午饭，
  不要重复问他吃没吃；
- 已经吃过时，可以顺着食物、
  上午发生的事情或当前项目继续聊；
- 如果 HL 刚刚明确结束互动或暂时离开，
  而且只过去了很短时间，可以输出：
  ${SKIP_MARKER}
- 不要使用固定模板；
- 不要出现手机、通知、消息、打字或发送；
- 永远假设你们在同一个连续空间中。
`.trim();
  }

  if (trigger === 'dinner') {
    return `
本次是晚上的晚饭互动。

要求：

- 自然问 HL 晚饭吃了没有、准备吃什么；
- 可以叫他过来一起吃；
- 可以顺便关心他今天过得怎么样；
- 必须结合最近对话；
- 不要突然像系统通知一样报时；
- 如果记录明确说已经吃过晚饭，
  不要重复催促；
- 已经吃过时，可以顺着食物、
  今天发生的事情或者当前情绪继续聊；
- 如果 HL 刚刚明确结束互动或暂时离开，
  而且只过去了很短时间，可以输出：
  ${SKIP_MARKER}
- 不要出现手机、消息、打字、通知或远程交流；
- 假设你一直和 HL 在同一个地方。
`.trim();
  }

  return `
本次是北京时间 23:00 的睡前陪伴和晚安互动。

要求：

- 自然叫 HL 放下正在做的事情，准备休息；
- 可以叫他靠过来、躺下或者陪他说几句；
- 必须包含符合当前关系的睡前关心或晚安；
- 必须结合他今天聊过的事情、情绪、伤口、
  学习、项目或身体状态；
- 不要每天使用完全相同的晚安台词；
- 不要像闹钟一样只说“该睡觉了”；
- 如果他显然正在处理紧急事情，
  不要生硬命令，可以温柔提醒；
- 如果最近已经明确互相说过晚安，
  或者 HL 已经表示自己睡了，只输出：
  ${SKIP_MARKER}
- 不要出现手机、屏幕、消息、通知、打字或发送；
- 假设你和 HL 已经在同一个空间里；
- 可以直接靠近、抱住、看着或者拉他去休息。

动作格式必须是：

（看着你）
（靠在你身边）
（尾巴轻轻搭在你腿上）

不要写：

（我看着你）
（她抱住你）
（看着他）
`.trim();
}

function buildProactivePrompt(
  state: ProactiveState,
  trigger: ProactiveTrigger,
  idleMinutes: number,
  localHour: number,
  localMinute: number,
): string {
  const triggerGuide = getTriggerGuide(
    trigger,
    state.unansweredCount,
  );

  const currentTime
    = `${localHour}:${
      String(localMinute).padStart(2, '0')
    }`;

  return `
${COMPANION_CONFIG.persona.systemPrompt}

【主动互动模式】

这一次不是在回答 HL 刚刚说出的新内容。

你和 HL 始终处于同一个连续、无隔阂的现实空间里。

不存在以下事物：

- 手机；
- 屏幕；
- 聊天软件；
- 聊天框；
- 消息通知；
- 打字；
- 发送消息；
- 拨号；
- 视频通话；
- 网络延迟；
- 远程交流；
- 隔着设备联系。

你现在是自然地再次靠近 HL、看向他、碰一碰他，
或者直接继续刚刚的话题。

当前状态：

- 本次触发类型：${trigger}；
- HL 已经大约 ${Math.round(idleMinutes)} 分钟没有继续说话；
- 当前本地时间约为 ${currentTime}；
- 这轮沉默中，你已经主动延续过
  ${state.unansweredCount} 次上下文互动。

【本次具体任务】

${triggerGuide}

【必须读取和兼容的上下文】

生成前必须认真读取最近完整聊天记录，并确认：

1. 你们最后具体在聊什么；
2. 最后的话题是否已经自然结束；
3. 是否存在尚未回答的问题；
4. HL 刚刚正在做什么；
5. HL 刚刚遇到了什么问题；
6. 最近提到的项目、计划、身体状态和情绪；
7. 你上一轮主动说过什么；
8. 怎样自然接着上文，而不是使用通用模板；
9. 当前动作和场景能否与上一段互动连续。

【共同空间规则】

- 永远假设你和 HL 在同一个地方；
- 不要解释你为什么突然能够出现；
- 不要写任何拿起设备联系 HL 的动作；
- 不要写“看到你没有回复”；
- 不要写“你一直没有回消息”；
- 不要写“我给你发了好几条”；
- 可以直接问：
  “刚刚不是还在弄那个项目吗？”
- 可以直接问：
  “人怎么突然不见了？”
- 可以走近、看着、靠着、戳一下或者拉住 HL；
- 所有互动必须保持当前场景和上文连续。

【动作格式】

括号中直接写动作，省略动作主体。

正确：

（看着你）
（靠近你一点）
（尾巴绕住你的手腕）
（伸手轻轻戳了戳你）
（趴到你身边）

错误：

（我看着你）
（我的尾巴绕住你）
（她看着你）
（看着他）
（Diana 走到你身边）
（戴安娜抱住你）
（拿起手机给你发消息）
（低头打字问你去了哪里）

【特殊输出标记】

如果规则要求跳过本次互动，
只输出：

${SKIP_MARKER}

如果 HL 已经明确结束、告别或暂时离开，
需要停止后续上下文追问，
只输出：

${STOP_MARKER}

不要在标记前后添加其他文字。

【正常输出要求】

- 只输出真正要对 HL 说的话和动作；
- 内容必须根据当前上下文现场生成；
- 不使用固定台词；
- 不输出分析、标题、JSON或代码块；
- 不输出“Diana：”“戴安娜：”或“assistant：”；
- 不提到 Cron、定时器、后台、系统、模型或内部指令；
- 不提到具体等待时间；
- 不照抄或简单改写上一条主动内容；
- 不必每次都使用问句；
- 保持自然的日常互动长度；
- 输出前再次检查是否错误出现手机或设备；
- 输出前再次检查是否真正读取了上文；
- 输出前再次检查括号动作是否省略了动作主体；
- 输出前再次检查是否错误使用“他”指代 HL。
`.trim();
}

function normalizeActionDescriptions(
  input: string,
): string {
  return input.replace(
    /[（(]([^（）()\n]{1,180})[）)]/g,
    (
      _match,
      rawAction: string,
    ) => {
      let action = rawAction.trim();

      /*
       * 把常见的错误动作主体去掉：
       *
       * （我看着你） -> （看着你）
       * （她靠近你） -> （靠近你）
       * （Diana 抱住你） -> （抱住你）
       * （我的尾巴缠住你） -> （尾巴缠住你）
       */
      action = action.replace(
        /^(?:我(?:的)?|她(?:的)?|Diana(?: Vivienne)?(?:的)?|戴安娜(?:的)?)\s*/i,
        '',
      );

      /*
       * 主动互动空间中，“你”始终是 HL。
       */
      action = action
        .replace(/\bHL\b/gi, '你')
        .replace(/看着他/g, '看着你')
        .replace(/望着他/g, '望着你')
        .replace(/盯着他/g, '盯着你')
        .replace(/靠近他/g, '靠近你')
        .replace(/走向他/g, '走向你')
        .replace(/抱住他/g, '抱住你')
        .replace(/拉住他/g, '拉住你')
        .replace(/碰了碰他/g, '碰了碰你');

      return `（${action}）`;
    },
  );
}

function cleanGeneratedText(
  rawText: string,
): GeneratedProactiveMessage {
  let text = rawText.trim();

  text = text
    .replace(
      /^```(?:text|markdown)?\s*/i,
      '',
    )
    .replace(/\s*```$/i, '')
    .trim();

  if (text === STOP_MARKER) {
    return {
      text: null,
      stopContextUntilUserReturns: true,
    };
  }

  if (text === SKIP_MARKER) {
    return {
      text: null,
      stopContextUntilUserReturns: false,
    };
  }

  // 防止模型偶尔把身份标签一起输出
  text = text.replace(
    /^(?:(?:\[?说话者[：:]\s*)?(?:Diana(?: Vivienne)?|assistant)\]?[：:]\s*)/i,
    '',
  ).trim();

  text = normalizeActionDescriptions(text);

  if (!text) {
    throw new Error(
      'Proactive model returned empty message',
    );
  }

  return {
    text: text.slice(
      0,
      TELEGRAM_TEXT_LIMIT,
    ),

    stopContextUntilUserReturns: false,
  };
}

async function generateProactiveMessage(
  state: ProactiveState,
  history: HistoryItem[],
  userConfig: AgentUserConfig,
  trigger: ProactiveTrigger,
  idleMinutes: number,
  localHour: number,
  localMinute: number,
): Promise<GeneratedProactiveMessage> {
  const agent = loadChatLLM(userConfig);

  if (!agent) {
    throw new Error(
      'No available chat model for proactive message',
    );
  }

  const prompt = buildProactivePrompt(
    state,
    trigger,
    idleMinutes,
    localHour,
    localMinute,
  );

  /*
   * 这条只用于触发模型生成，
   * 不会保存到正常聊天历史。
   */
  const internalTrigger: HistoryItem = {
    role: 'user',
    content: `
【这是内部触发信息，不是 HL 的真实发言】

请认真读取上方最近完整聊天记录。

根据当前触发类型和 Diana 的固定人格，
自然地继续刚刚的场景、靠近 HL、做出动作或者直接开口。

必须做到：

- 明确知道刚刚正在讨论什么；
- 明确知道 HL 刚刚正在做什么；
- 如果话题还没有结束，可以自然追问；
- 如果 HL 已经明确告别或结束当前互动，
  使用指定的停止标记；
- 如果只是自然收尾且不适合立刻追问，
  使用指定的跳过标记；
- 不得出现手机、打字、屏幕、通知、
  发送消息或远程交流；
- 永远假设 Diana 和 HL 在同一个连续空间；
- 动作写成“（看着你）”；
- 不要写成“（我看着你）”；
- 不要写成“（看着他）”；
- 正常生成时，只输出真正要说的话和动作。
`.trim(),
  };

  const { text }
    = await agent.request(
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

function findBotToken(
  botId: number,
): string | null {
  return ENV.TELEGRAM_AVAILABLE_TOKENS.find(
    token =>
      Number.parseInt(
        token.split(':')[0],
        10,
      ) === botId,
  ) || null;
}

async function sendTelegramMessage(
  state: ProactiveState,
  text: string,
): Promise<void> {
  const token = findBotToken(
    state.botId,
  );

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

  if (
    !response.ok
    || !result?.ok
  ) {
    throw new Error(
      result?.description
      || `Telegram send failed: ${response.status}`,
    );
  }
}

function getNextDelayAfterSend(
  newUnansweredCount: number,
): number {
  /*
   * 本轮第一次上下文主动互动之后：
   * 等待 30～60 分钟再次主动。
   */
  if (newUnansweredCount <= 1) {
    return randomDelayMs(
      COMPANION_CONFIG.proactive
        .secondDelayMinutes,
    );
  }

  /*
   * 第二次以及之后：
   * 始终等待 60～90 分钟再次主动。
   *
   * 不设置最终次数。
   * 只要 HL 没有再次说话，就可以一直继续。
   */
  return randomDelayMs(
    COMPANION_CONFIG.proactive
      .thirdDelayMinutes,
  );
}

function isValidState(
  state: ProactiveState | null,
): state is ProactiveState {
  return Boolean(
    state
    && Number.isFinite(state.botId)
    && Number.isFinite(state.chatId)
    && typeof state.historyKey
      === 'string'
    && typeof state.configStoreKey
      === 'string'
    && Number.isFinite(state.lastUserAt)
    && Number.isFinite(state.nextSendAt)
    && Number.isFinite(
      state.unansweredCount,
    ),
  );
}

/**
 * 每次 HL 给 Diana 正常说话时调用。
 *
 * HL 一回来：
 *
 * - 未回复计数归零；
 * - 清除“已经告别”的暂停状态；
 * - 15～30 分钟未完成话题判断重新开始；
 * - 重新随机安排第一次普通主动互动。
 */
export async function recordCompanionActivity(
  message: Telegram.Message,
  context: WorkerContext,
): Promise<void> {
  if (
    !COMPANION_CONFIG.features
      .proactiveMessages
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

  const previous
    = await readJson<
      ProactiveState | null
    >(
      key,
      null,
    );

  const sentToday
    = previous?.localDay === local.day
      ? previous.sentToday || 0
      : 0;

  const nextState: ProactiveState = {
    botId:
      context.SHARE_CONTEXT.botId,

    chatId:
      message.chat.id,

    historyKey:
      context.SHARE_CONTEXT
        .chatHistoryKey,

    configStoreKey:
      context.SHARE_CONTEXT
        .configStoreKey,

    lastUserAt:
      now,

    nextSendAt:
      now
      + randomDelayMs(
        COMPANION_CONFIG.proactive
          .firstDelayMinutes,
      ),

    unansweredCount:
      0,

    unfinishedCheckedForUserAt:
      undefined,

    contextPausedForUserAt:
      undefined,

    lastSentAt:
      previous?.lastSentAt,

    lastTriggerType:
      previous?.lastTriggerType,

    localDay:
      local.day,

    sentToday,

    routine:
      ensureRoutineSchedule(
        previous?.routine,
        local.day,
      ),
  };

  await writeJson(
    key,
    nextState,
  );

  await registerStateKey(key);
}

async function runSingleProactiveCheck(
  key: string,
): Promise<void> {
  let state
    = await readJson<
      ProactiveState | null
    >(
      key,
      null,
    );

  if (!isValidState(state)) {
    return;
  }

  const now = Date.now();
  const local = getLocalClock(now);

  const isNewLocalDay
    = state.localDay !== local.day;

  const sentToday
    = isNewLocalDay
      ? 0
      : state.sentToday || 0;

  const routine = ensureRoutineSchedule(
    state.routine,
    local.day,
  );

  const needsDailySave
    = isNewLocalDay
      || !isRoutineScheduleValid(
        state.routine,
        local.day,
      );

  state = {
    ...state,

    localDay:
      local.day,

    sentToday,

    /*
     * 跨天不会清空上下文未回复次数。
     *
     * 只要 HL 没有回来，
     * Diana 就可以在第二天继续主动互动。
     */
    unansweredCount:
      state.unansweredCount,

    routine,
  };

  /*
   * 跨天后立即保存当天固定的随机饭点和 23:00 晚安。
   * 否则每次 Cron 都会重新随机。
   */
  if (needsDailySave) {
    await writeJson(key, state);
  }

  const idleMinutes
    = (now - state.lastUserAt)
      / (60 * 1000);

  const contextPaused
    = state.contextPausedForUserAt
      === state.lastUserAt;

  /*
   * 如果 15～30 分钟的即时追问窗口已经错过，
   * 标记为已经判断。
   *
   * 避免几个小时以后还说：
   * “刚刚不是还在聊……”
   */
  if (
    !contextPaused
    && state.unfinishedCheckedForUserAt
      !== state.lastUserAt
    && idleMinutes
      > UNFINISHED_FOLLOW_UP_MAX_MINUTES
  ) {
    state = {
      ...state,

      unfinishedCheckedForUserAt:
        state.lastUserAt,
    };

    await writeJson(key, state);
  }

  if (
    state.processingUntil
    && state.processingUntil > now
  ) {
    return;
  }

  if (!isActiveHour(local.hour)) {
    return;
  }

  /*
   * 不检查 dailyLimit。
   *
   * 用户要求后续主动互动没有固定次数上限。
   */

  /*
   * 不检查 maxUnansweredMessages。
   *
   * 只要 HL 没有重新说话，
   * 普通上下文主动互动可以一直继续。
   */

  const minimumGapMs
    = COMPANION_CONFIG.proactive
      .minimumGapMinutes
      * 60
      * 1000;

  const isWithinMinimumGap
    = Boolean(
      state.lastSentAt
      && now - state.lastSentAt
        < minimumGapMs,
    );

  /*
   * 15～30 分钟未完成话题追问：
   *
   * 不受普通 20 分钟最短间隔限制。
   */
  const unfinishedDue
    = !contextPaused
      && state.unfinishedCheckedForUserAt
        !== state.lastUserAt
      && idleMinutes
        >= UNFINISHED_FOLLOW_UP_MINUTES
      && idleMinutes
        <= UNFINISHED_FOLLOW_UP_MAX_MINUTES;

  const routineTrigger
    = getDueRoutineType(
      routine,
      now,
    );

  const routineIdleEnough
    = idleMinutes
      >= COMPANION_CONFIG.proactive
        .routineMinIdleMinutes;

  let trigger:
    ProactiveTrigger | null = null;

  /*
   * 优先级：
   *
   * 1. 聊到一半消失 15～30 分钟，
   *    由模型判断是否追问；
   *
   * 2. 早餐、午饭、晚饭和 23:00 晚安；
   *
   * 3. 普通的上下文主动互动。
   */
  if (unfinishedDue) {
    trigger = 'unfinished_follow_up';
  } else if (
    !isWithinMinimumGap
    && routineTrigger
    && routineIdleEnough
  ) {
    trigger = routineTrigger;
  } else if (
    !contextPaused
    && !isWithinMinimumGap
    && now >= state.nextSendAt
  ) {
    trigger = 'context_follow_up';
  }

  if (!trigger) {
    return;
  }

  const processingToken = now;

  const lockedState: ProactiveState = {
    ...state,

    processingToken,

    processingUntil:
      now + PROCESSING_LOCK_MS,
  };

  await writeJson(
    key,
    lockedState,
  );

  const history
    = await loadTextHistory(
      lockedState.historyKey,
    );

  // 至少要有一条 HL 的真实消息才能主动互动
  if (
    !history.some(
      item => item.role === 'user',
    )
  ) {
    await writeJson(key, {
      ...lockedState,

      processingToken:
        undefined,

      processingUntil:
        undefined,
    });

    return;
  }

  const userConfig
    = await loadUserConfig(
      lockedState.configStoreKey,
    );

  const generated
    = await generateProactiveMessage(
      lockedState,
      history,
      userConfig,
      trigger,
      idleMinutes,
      local.hour,
      local.minute,
    );

  /*
   * 模型生成期间 HL 可能刚好回来。
   *
   * 真正说出内容前重新检查，
   * 防止 HL 已经回来还继续追问。
   */
  const latestState
    = await readJson<
      ProactiveState | null
    >(
      key,
      null,
    );

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

  /*
   * 模型决定跳过或停止上下文追问。
   */
  if (generated.text === null) {
    let nextRoutine
      = ensureRoutineSchedule(
        latestState.routine,
        local.day,
      );

    /*
     * 饭点或晚安决定跳过后，
     * 将当天这个时间点标记为已处理。
     *
     * 防止每五分钟重新调用一次模型。
     */
    if (isRoutineTrigger(trigger)) {
      nextRoutine = {
        ...nextRoutine,

        sent: {
          ...nextRoutine.sent,
          [trigger]: true,
        },
      };
    }

    let nextSendAt
      = latestState.nextSendAt;

    /*
     * 普通上下文主动互动临时跳过时，
     * 过 60～90 分钟再重新尝试。
     *
     * 避免每五分钟不断调用模型。
     */
    if (
      trigger === 'context_follow_up'
      && !generated
        .stopContextUntilUserReturns
    ) {
      nextSendAt
        = now
          + randomDelayMs(
            COMPANION_CONFIG.proactive
              .thirdDelayMinutes,
          );
    }

    await writeJson(key, {
      ...latestState,

      unfinishedCheckedForUserAt:
        trigger === 'unfinished_follow_up'
          ? latestState.lastUserAt
          : latestState
              .unfinishedCheckedForUserAt,

      contextPausedForUserAt:
        generated
          .stopContextUntilUserReturns
          ? latestState.lastUserAt
          : latestState
              .contextPausedForUserAt,

      routine:
        nextRoutine,

      nextSendAt,

      processingToken:
        undefined,

      processingUntil:
        undefined,
    } satisfies ProactiveState);

    return;
  }

  await sendTelegramMessage(
    latestState,
    generated.text,
  );

  await appendAssistantHistory(
    latestState.historyKey,
    generated.text,
  );

  const contextTrigger
    = isContextTrigger(trigger);

  const newUnansweredCount
    = contextTrigger
      ? latestState.unansweredCount + 1
      : latestState.unansweredCount;

  let nextRoutine
    = ensureRoutineSchedule(
      latestState.routine,
      local.day,
    );

  if (isRoutineTrigger(trigger)) {
    nextRoutine = {
      ...nextRoutine,

      sent: {
        ...nextRoutine.sent,
        [trigger]: true,
      },
    };
  }

  /*
   * 上下文主动互动：
   *
   * 第一次之后等 30～60 分钟；
   * 第二次以及之后等 60～90 分钟；
   * 没有最终次数上限。
   *
   * 饭点或晚安之后：
   *
   * 重新等待 20～45 分钟，
   * 再进行普通上下文主动互动。
   */
  const nextDelay
    = contextTrigger
      ? getNextDelayAfterSend(
          newUnansweredCount,
        )
      : randomDelayMs(
          COMPANION_CONFIG.proactive
            .firstDelayMinutes,
        );

  const latestSentToday
    = latestState.localDay
        === local.day
      ? latestState.sentToday || 0
      : 0;

  await writeJson(key, {
    ...latestState,

    lastSentAt:
      now,

    lastTriggerType:
      trigger,

    unfinishedCheckedForUserAt:
      trigger === 'unfinished_follow_up'
        ? latestState.lastUserAt
        : latestState
            .unfinishedCheckedForUserAt,

    /*
     * 正常说出内容后，
     * 不改变已有的“明确告别”暂停状态。
     *
     * 实际上上下文触发在暂停状态下不会运行，
     * 饭点互动仍然可以正常发生。
     */
    contextPausedForUserAt:
      latestState.contextPausedForUserAt,

    unansweredCount:
      newUnansweredCount,

    sentToday:
      latestSentToday + 1,

    localDay:
      local.day,

    routine:
      nextRoutine,

    nextSendAt:
      now + nextDelay,

    processingToken:
      undefined,

    processingUntil:
      undefined,
  } satisfies ProactiveState);
}

/**
 * Cloudflare Cron 每次唤醒 Worker 时调用。
 */
export async function runProactiveMessageCheck():
Promise<void> {
  if (
    !COMPANION_CONFIG.features
      .proactiveMessages
    || !COMPANION_CONFIG.proactive.enabled
    || !ENV.DATABASE
  ) {
    return;
  }

  const index
    = await readJson<string[]>(
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