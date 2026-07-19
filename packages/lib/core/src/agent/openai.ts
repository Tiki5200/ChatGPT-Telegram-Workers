import type { AgentUserConfig } from '#/config';
import type {
    AgentEnable,
    AgentModel,
    AgentModelList,
    ChatAgent,
    ChatAgentRequest,
    ChatAgentResponse,
    ChatStreamTextHandler,
    ImageAgent,
    ImageAgentRequest,
    LLMChatParams,
} from './types';

import {
    ImageSupportFormat,
    loadOpenAIModelList,
    renderOpenAIMessages,
} from '#/agent/openai_compatibility';
import { ENV } from '#/config';

import { requestChatCompletions } from './request';
import {
    bearerHeader,
    convertStringToResponseMessages,
    getAgentUserConfigFieldName,
    loadModelsList,
} from './utils';

interface OpenRouterImageResult {
    url?: string;
    b64_json?: string;
    media_type?: string;
}

interface OpenRouterImageResponse {
    data?: OpenRouterImageResult[];
    error?: {
        message?: string;
    };
}

function openAIApiKey(
    context: AgentUserConfig,
): string {
    const length = context.OPENAI_API_KEY.length;

    if (length === 0) {
        throw new Error('OPENAI_API_KEY is missing');
    }

    return context.OPENAI_API_KEY[
        Math.floor(Math.random() * length)
    ];
}

/**
 * 判断这次图片请求是否在生成 Diana。
 *
 * 普通风景、物品等请求不会强制使用 Diana 的参考图。
 */
function isDianaImageRequest(
    prompt: string,
): boolean {
    return /(diana|戴安娜|你的样子|你的照片|你的自拍|看看你|看你|人形态|猫猫状态|猫形态|猫态|兽态)/i
        .test(prompt);
}

/**
 * 判断 Diana 本次使用人形还是猫形参考图。
 */
function isDianaCatForm(
    prompt: string,
): boolean {
    return /(猫猫|猫形|猫态|兽态|猫耳|猫尾|尾巴|爪子)/i
        .test(prompt);
}

function buildDianaImageRequest(
    originalPrompt: string,
): {
    prompt: string;
    referenceUrl: string;
} {
    if (!isDianaImageRequest(originalPrompt)) {
        return {
            prompt: originalPrompt,
            referenceUrl: '',
        };
    }

    const catForm = isDianaCatForm(originalPrompt);

    if (catForm) {
        return {
            referenceUrl:
                ENV.DIANA_CAT_REFERENCE_URL.trim(),

            prompt: `
Use the cat in the reference image as Diana.

Preserve the same:
- cat identity
- face
- fur color and markings
- eye color
- body shape
- age and overall appearance

Only change what the requested scene requires:
- pose
- expression
- camera angle
- accessories
- lighting
- background and environment

Requested scene:
${originalPrompt}

Diana must remain recognizably the same cat shown
in the reference image.

Create a realistic, natural photograph.
Do not replace Diana with a human or another cat.
`.trim(),
        };
    }

    return {
        referenceUrl:
            ENV.DIANA_HUMAN_REFERENCE_URL.trim(),

        prompt: `
Use the adult woman in the reference image as Diana.

Preserve the same:
- facial identity
- apparent age
- hairstyle and hair color
- eye color
- skin tone
- facial features
- body proportions
- overall appearance

Only change what the requested scene requires:
- pose
- expression
- outfit
- camera angle
- lighting
- background and environment

Requested scene:
${originalPrompt}

Diana must remain recognizably the same adult woman
shown in the reference image.

Create a realistic, natural photograph.
Do not replace Diana with a man or another woman.
`.trim(),
    };
}

export class OpenAI implements ChatAgent {
    readonly name = 'openai';

    readonly modelKey
        = getAgentUserConfigFieldName(
            'OPENAI_CHAT_MODEL',
        );

    readonly enable: AgentEnable
        = ctx => ctx.OPENAI_API_KEY.length > 0;

    readonly model: AgentModel
        = ctx => ctx.OPENAI_CHAT_MODEL;

    readonly modelList: AgentModelList
        = ctx => loadOpenAIModelList(
            ctx.OPENAI_CHAT_MODELS_LIST,
            ctx.OPENAI_API_BASE,
            bearerHeader(openAIApiKey(ctx)),
        );

    /**
     * 普通文字和视觉聊天。
     *
     * 这里绝对不能放图片生成请求体。
     */
    readonly request: ChatAgentRequest = async (
        params: LLMChatParams,
        context: AgentUserConfig,
        onStream: ChatStreamTextHandler | null,
    ): Promise<ChatAgentResponse> => {
        const { prompt, messages } = params;

        const url
            = `${context.OPENAI_API_BASE}/chat/completions`;

        const header
            = bearerHeader(openAIApiKey(context));

        const body = {
            ...(context.OPENAI_API_EXTRA_PARAMS || {}),

            model:
                context.OPENAI_CHAT_MODEL,

            messages:
                await renderOpenAIMessages(
                    prompt,
                    messages,
                    [
                        ImageSupportFormat.URL,
                        ImageSupportFormat.BASE64,
                    ],
                ),

            stream:
                onStream != null,
        };

        return convertStringToResponseMessages(
            requestChatCompletions(
                url,
                header,
                body,
                onStream,
                null,
            ),
        );
    };
}

export class Dalle implements ImageAgent {
    readonly name = 'openai';

    readonly modelKey
        = getAgentUserConfigFieldName(
            'DALL_E_MODEL',
        );

    readonly enable: AgentEnable
        = ctx => ctx.OPENAI_API_KEY.length > 0;

    readonly model: AgentModel
        = ctx => ctx.DALL_E_MODEL;

    readonly modelList: AgentModelList
        = ctx => loadModelsList(
            ctx.DALL_E_MODELS_LIST,
        );

    readonly request: ImageAgentRequest = async (
        originalPrompt: string,
        context: AgentUserConfig,
    ): Promise<string | Blob> => {
        const isOpenRouter
            = context.OPENAI_API_BASE.includes(
                'openrouter.ai',
            );

        const url = isOpenRouter
            ? `${context.OPENAI_API_BASE}/images`
            : `${context.OPENAI_API_BASE}/images/generations`;

        const header = {
            ...bearerHeader(
                openAIApiKey(context),
            ),
            'content-type': 'application/json',
        };

        const dianaRequest
            = buildDianaImageRequest(
                originalPrompt,
            );

        const body: Record<string, unknown> = {
            model:
                context.DALL_E_MODEL,

            prompt:
                dianaRequest.prompt,

            n:
                1,

            size:
                context.DALL_E_IMAGE_SIZE,
        };

        /*
         * OpenRouter 专用参考图参数。
         * 只有请求 Diana 时才传参考图。
         */
        if (
            isOpenRouter
            && dianaRequest.referenceUrl
        ) {
            body.input_references = [
                {
                    type: 'image_url',

                    image_url: {
                        url:
                            dianaRequest.referenceUrl,
                    },
                },
            ];
        }

        /*
         * OpenAI 官方 DALL-E 3 的旧参数。
         * OpenRouter 图片接口不需要这两项。
         */
        if (
            !isOpenRouter
            && context.DALL_E_MODEL === 'dall-e-3'
        ) {
            body.quality
                = context.DALL_E_IMAGE_QUALITY;

            body.style
                = context.DALL_E_IMAGE_STYLE;
        }

        const response = await fetch(
            url,
            {
                method: 'POST',
                headers: header,
                body: JSON.stringify(body),
            },
        );

        const result = (
    await response
        .json()
        .catch(() => null)
) as OpenRouterImageResponse | null;

        if (!response.ok) {
            throw new Error(
                result?.error?.message
                || `Image API request failed: ${response.status}`,
            );
        }

        if (result?.error?.message) {
            throw new Error(
                result.error.message,
            );
        }

        const image
            = result?.data?.at(0);

        if (image?.url) {
            return image.url;
        }

        if (image?.b64_json) {
            const bytes = Uint8Array.from(
                atob(image.b64_json),
                char => char.charCodeAt(0),
            );

            return new Blob(
                [bytes],
                {
                    type:
                        image.media_type
                        || 'image/png',
                },
            );
        }

        throw new Error(
            'Image API returned no image',
        );
    };
}