import type { WorkerContext } from '#/config';
import type { ChatAgent, HistoryItem, HistoryModifier, LLMChatParams, UserMessageItem } from './types';
import { ENV } from '#/config';
import { extractTextContent } from './utils';
import { DIANA_SYSTEM_PROMPT } from './diana';

function tokensCounter(): (text: string) => number {
    return (text) => {
        return text.length;
    };
}

async function loadHistory(key: string): Promise<HistoryItem[]> {
    let history = [];

    try {
        history = JSON.parse(await ENV.DATABASE.get(key));
    } catch (e) {
        console.error(e);
    }

    if (!history || !Array.isArray(history)) {
        history = [];
    }

    const counter = tokensCounter();

    const trimHistory = (
        list: HistoryItem[],
        initLength: number,
        maxLength: number,
        maxToken: number
    ) => {

        if (maxLength >= 0 && list.length > maxLength) {
            list = list.splice(list.length - maxLength);
        }

        if (maxToken > 0) {
            let tokenLength = initLength;

            for (let i = list.length - 1; i >= 0; i--) {
                const historyItem = list[i];

                let length = 0;

                if (historyItem.content) {
                    length = counter(extractTextContent(historyItem));
                } else {
                    historyItem.content = '';
                }

                tokenLength += length;

                if (tokenLength > maxToken) {
                    list = list.splice(i + 1);
                    break;
                }
            }
        }

        return list;
    };


    if (ENV.AUTO_TRIM_HISTORY && ENV.MAX_HISTORY_LENGTH > 0) {
        history = trimHistory(
            history,
            0,
            ENV.MAX_HISTORY_LENGTH,
            ENV.MAX_TOKEN_LENGTH
        );
    }

    return history;
}

export type StreamResultHandler = (text: string) => Promise<any>;


export async function requestCompletionsFromLLM(
    params: UserMessageItem | null,
    context: WorkerContext,
    agent: ChatAgent,
    modifier: HistoryModifier | null,
    onStream: StreamResultHandler | null
): Promise<string> {

    const historyDisable =
        ENV.AUTO_TRIM_HISTORY && ENV.MAX_HISTORY_LENGTH <= 0;


    const historyKey = context.SHARE_CONTEXT.chatHistoryKey;

    if (!historyKey) {
        throw new Error('History key not found');
    }


    let history = await loadHistory(historyKey);


    if (modifier) {
        const modifierData = modifier(history, params || null);
        history = modifierData.history;
        params = modifierData.message;
    }


    if (!params) {
        throw new Error('Message is empty');
    }


    const llmParams: LLMChatParams = {
        // 这里读取 Diana 人设
        prompt: DIANA_SYSTEM_PROMPT,

        // 历史记录保持原样
        messages: [...history, params],
    };


    const { text, responses } = await agent.request(
        llmParams,
        context.USER_CONFIG,
        onStream
    );


    if (!historyDisable) {

        const editParams = { ...params };


        if (ENV.HISTORY_IMAGE_PLACEHOLDER) {

            if (Array.isArray(editParams.content)) {

                const imageCount = editParams.content.filter(
                    i => i.type === 'image'
                ).length;


                const textContent = editParams.content.findLast(
                    i => i.type === 'text'
                );


                if (textContent) {

                    editParams.content =
                        editParams.content.filter(
                            i => i.type !== 'image'
                        );


                    textContent.text =
                        textContent.text +
                        ` ${ENV.HISTORY_IMAGE_PLACEHOLDER}`.repeat(imageCount);
                }
            }
        }


        await ENV.DATABASE.put(
            historyKey,
            JSON.stringify([
                ...history,
                editParams,
                ...responses
            ])
        ).catch(console.error);
    }


    return text;
}