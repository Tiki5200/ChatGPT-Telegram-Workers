import { COMPANION_CONFIG } from '#/companion/config';
import type { WorkerContext } from '#/config';

import type {
  ChatAgent,
  HistoryItem,
  HistoryModifier,
  LLMChatParams,
  UserMessageItem,
} from './types';

import { ENV } from '#/config';

import { extractTextContent } from './utils';

interface CompanionMemoryConfig {
  enabled?: boolean;
  maxTurns?: number;
  labelSpeakers?: boolean;
}

function getMemoryConfig(): CompanionMemoryConfig {
  const config = COMPANION_CONFIG as typeof COMPANION_CONFIG & {
    memory?: CompanionMemoryConfig;
  };

  return config.memory ?? {};
}

function getMaxTurns(config: CompanionMemoryConfig): number {
  if (
    typeof config.maxTurns !== 'number' ||
    !Number.isFinite(config.maxTurns)
  ) {
    return 15;
  }

  return Math.max(1, Math.floor(config.maxTurns));
}

function tokensCounter(): (text: string) => number {
  return text => text.length;
}

/**
 * 确保历史记录从 user 消息开始。
 *
 * 防止裁剪后第一条只剩 assistant 或 tool，
 * 导致模型不知道这句话是谁回应谁。
 */
function alignHistoryToUserTurn(
  list: HistoryItem[]
): HistoryItem[] {
  const firstUserIndex = list.findIndex(
    item => item.role === 'user'
  );

  if (firstUserIndex < 0) {
    return [];
  }

  return list.slice(firstUserIndex);
}

/**
 * 按完整的用户回合裁剪。
 *
 * 一个 user 消息代表一个新回合。
 * assistant 和 tool 消息会跟随对应的 user 回合一起保留。
 */
function trimHistoryByTurns(
  list: HistoryItem[],
  maxTurns: number
): HistoryItem[] {
  let userTurns = 0;

  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role !== 'user') {
      continue;
    }

    userTurns += 1;

    if (userTurns === maxTurns) {
      return list.slice(i);
    }
  }

  return [...list];
}

/**
 * 综合执行：
 *
 * 1. 完整回合限制；
 * 2. 原项目的消息数量限制；
 * 3. 原项目的 token 长度限制；
 * 4. 避免从 assistant 消息中间开始。
 */
function trimHistory(
  list: HistoryItem[],
  initLength: number,
  maxTurns: number
): HistoryItem[] {
  let result = trimHistoryByTurns(list, maxTurns);

  if (
    ENV.AUTO_TRIM_HISTORY &&
    ENV.MAX_HISTORY_LENGTH > 0
  ) {
    if (result.length > ENV.MAX_HISTORY_LENGTH) {
      result = result.slice(
        result.length - ENV.MAX_HISTORY_LENGTH
      );

      result = alignHistoryToUserTurn(result);
    }

    if (ENV.MAX_TOKEN_LENGTH > 0) {
      const counter = tokensCounter();

      let tokenLength = initLength;
      let startIndex = result.length;

      for (let i = result.length - 1; i >= 0; i--) {
        const length = counter(
          extractTextContent(result[i])
        );

        if (
          tokenLength + length >
          ENV.MAX_TOKEN_LENGTH
        ) {
          break;
        }

        tokenLength += length;
        startIndex = i;
      }

      result = alignHistoryToUserTurn(
        result.slice(startIndex)
      );
    }
  }

  return result;
}

/**
 * 给发送给模型的消息加内部说话者标签。
 *
 * 标签只存在于本次模型请求中，
 * 不会被写入 KV，也不会显示在 Telegram 中。
 */
function addSpeakerLabel(
  item: HistoryItem
): HistoryItem {
  if (
    item.role !== 'user' &&
    item.role !== 'assistant'
  ) {
    return item;
  }

  const speaker =
    item.role === 'user'
      ? COMPANION_CONFIG.persona.userName
      : COMPANION_CONFIG.persona.name;

  const prefix = `[说话者：${speaker}]\n`;

  if (typeof item.content === 'string') {
    return {
      ...item,
      content: `${prefix}${item.content}`,
    } as HistoryItem;
  }

  if (!Array.isArray(item.content)) {
    return item;
  }

  const content = item.content.map(
    part => ({ ...part })
  ) as Array<Record<string, any>>;

  const textIndex = content.findIndex(
    part =>
      part.type === 'text' &&
      typeof part.text === 'string'
  );

  if (textIndex >= 0) {
    content[textIndex] = {
      ...content[textIndex],
      text: `${prefix}${content[textIndex].text}`,
    };
  } else {
    content.unshift({
      type: 'text',
      text: prefix.trimEnd(),
    });
  }

  return {
    ...item,
    content,
  } as HistoryItem;
}

/**
 * 创建用于写入历史记录的用户消息副本。
 *
 * 同时保留原项目的图片占位符逻辑，
 * 避免把完整图片数据长期写进 KV。
 */
function prepareMessageForHistory(
  params: UserMessageItem
): UserMessageItem {
  const editParams: UserMessageItem = {
    ...params,

    content: Array.isArray(params.content)
      ? params.content.map(part => ({ ...part }))
      : params.content,
  };

  if (
    !ENV.HISTORY_IMAGE_PLACEHOLDER ||
    !Array.isArray(editParams.content)
  ) {
    return editParams;
  }

  const imageCount = editParams.content.filter(
    item => item.type === 'image'
  ).length;

  if (imageCount <= 0) {
    return editParams;
  }

  let textIndex = -1;

  for (
    let i = editParams.content.length - 1;
    i >= 0;
    i--
  ) {
    if (editParams.content[i].type === 'text') {
      textIndex = i;
      break;
    }
  }

  if (textIndex < 0) {
    return editParams;
  }

  const textItem =
    editParams.content[textIndex];

  if (textItem.type !== 'text') {
    return editParams;
  }

  editParams.content =
    editParams.content.filter(
      item => item.type !== 'image'
    );

  textItem.text =
    textItem.text +
    ` ${ENV.HISTORY_IMAGE_PLACEHOLDER}`.repeat(
      imageCount
    );

  return editParams;
}

/**
 * 从 KV 中读取并裁剪历史记录。
 */
async function loadHistory(
  key: string,
  maxTurns: number
): Promise<HistoryItem[]> {
  let history: HistoryItem[] = [];

  try {
    const rawHistory =
      await ENV.DATABASE.get(key);

    if (rawHistory) {
      history = JSON.parse(rawHistory);
    }
  } catch (e) {
    console.error(e);
  }

  if (!Array.isArray(history)) {
    history = [];
  }

  return trimHistory(
    history,
    0,
    maxTurns
  );
}

export type StreamResultHandler = (
  text: string
) => Promise<any>;

export async function requestCompletionsFromLLM(
  params: UserMessageItem | null,
  context: WorkerContext,
  agent: ChatAgent,
  modifier: HistoryModifier | null,
  onStream: StreamResultHandler | null
): Promise<string> {
  const memoryConfig = getMemoryConfig();
  const maxTurns =
    getMaxTurns(memoryConfig);

  const historyDisabledByEnv =
    ENV.AUTO_TRIM_HISTORY &&
    ENV.MAX_HISTORY_LENGTH <= 0;

  const historyEnabled =
    memoryConfig.enabled !== false &&
    !historyDisabledByEnv;

  const labelSpeakers =
    memoryConfig.labelSpeakers !== false;

  const historyKey =
    context.SHARE_CONTEXT.chatHistoryKey;

  if (!historyKey) {
    throw new Error(
      'History key not found'
    );
  }

  let history = historyEnabled
    ? await loadHistory(
        historyKey,
        maxTurns
      )
    : [];

  if (modifier) {
    const modifierData = modifier(
      history,
      params || null
    );

    history = modifierData.history;
    params = modifierData.message;
  }

  if (!params) {
    throw new Error('Message is empty');
  }

  const prompt =
    COMPANION_CONFIG.persona.systemPrompt;

  const counter = tokensCounter();

  const initLength =
    counter(prompt) +
    counter(extractTextContent(params));

  history = trimHistory(
    history,
    initLength,
    maxTurns
  );

  /*
   * 这里只给模型请求添加身份标签。
   * 原始 history 和 KV 数据不会被污染。
   */
  const requestHistory =
    labelSpeakers
      ? history.map(addSpeakerLabel)
      : history;

  const requestMessage =
    labelSpeakers
      ? addSpeakerLabel(params)
      : params;

  const llmParams: LLMChatParams = {
    prompt,

    messages: [
      ...requestHistory,
      requestMessage,
    ],
  };

  const { text, responses } =
    await agent.request(
      llmParams,
      context.USER_CONFIG,
      onStream
    );

  if (historyEnabled) {
    const editParams =
      prepareMessageForHistory(params);

    /*
     * 回答完成后立刻裁剪再写入 KV。
     *
     * 这样 KV 不会无限增长，
     * 也不会等到下一次聊天才裁剪。
     */
    const nextHistory = trimHistory(
      [
        ...history,
        editParams,
        ...responses,
      ],
      counter(prompt),
      maxTurns
    );

    await ENV.DATABASE.put(
      historyKey,
      JSON.stringify(nextHistory)
    ).catch(console.error);
  }

  return text;
}