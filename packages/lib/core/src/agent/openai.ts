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
import { ImageSupportFormat, loadOpenAIModelList, renderOpenAIMessages } from '#/agent/openai_compatibility';
import { requestChatCompletions } from './request';
import { bearerHeader, convertStringToResponseMessages, getAgentUserConfigFieldName, loadModelsList } from './utils';

function openAIApiKey(context: AgentUserConfig): string {
    const length = context.OPENAI_API_KEY.length;
    return context.OPENAI_API_KEY[Math.floor(Math.random() * length)];
}

export class OpenAI implements ChatAgent {
    readonly name = 'openai';
    readonly modelKey = getAgentUserConfigFieldName('OPENAI_CHAT_MODEL');

    readonly enable: AgentEnable = ctx => ctx.OPENAI_API_KEY.length > 0;
    readonly model: AgentModel = ctx => ctx.OPENAI_CHAT_MODEL;
    readonly modelList: AgentModelList = ctx => loadOpenAIModelList(ctx.OPENAI_CHAT_MODELS_LIST, ctx.OPENAI_API_BASE, bearerHeader(openAIApiKey(ctx)));

    readonly request: ChatAgentRequest = async (params: LLMChatParams, context: AgentUserConfig, onStream: ChatStreamTextHandler | null): Promise<ChatAgentResponse> => {
        const { prompt, messages } = params;
        const url = `${context.OPENAI_API_BASE}/chat/completions`;
        const header = bearerHeader(openAIApiKey(context));
        const body = {
            ...(context.OPENAI_API_EXTRA_PARAMS || {}),
            model: context.OPENAI_CHAT_MODEL,
            messages: await renderOpenAIMessages(prompt, messages, [ImageSupportFormat.URL, ImageSupportFormat.BASE64]),
            stream: onStream != null,
        };
        return convertStringToResponseMessages(requestChatCompletions(url, header, body, onStream, null));
    };
}

export class Dalle implements ImageAgent {
  readonly name = 'openai';

  readonly modelKey
    = getAgentUserConfigFieldName('DALL_E_MODEL');

  readonly enable: AgentEnable
    = ctx => ctx.OPENAI_API_KEY.length > 0;

  readonly model: AgentModel
    = ctx => ctx.DALL_E_MODEL;

  readonly modelList: AgentModelList
    = ctx => loadModelsList(ctx.DALL_E_MODELS_LIST);

  readonly request: ImageAgentRequest = async (
    prompt: string,
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
      ...bearerHeader(openAIApiKey(context)),
      'content-type': 'application/json',
    };

    const body: any = {
      prompt,
      n: 1,
      size: context.DALL_E_IMAGE_SIZE,
      model: context.DALL_E_MODEL,
    };

    if (
      !isOpenRouter
      && body.model === 'dall-e-3'
    ) {
      body.quality
        = context.DALL_E_IMAGE_QUALITY;

      body.style
        = context.DALL_E_IMAGE_STYLE;
    }

    const response = await fetch(url, {
  method: 'POST',
  headers: header,
  body: JSON.stringify(body),
});

const resp = await response.json() as any;

if (!response.ok) {
  throw new Error(
    resp?.error?.message
    || `Image API request failed: ${response.status}`,
  );
}

    if (resp.error?.message) {
      throw new Error(resp.error.message);
    }

    const image = resp?.data?.at(0);

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
｝