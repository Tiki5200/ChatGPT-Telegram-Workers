import type { ChatStreamTextHandler } from './types';
import { ENV } from '#/config';
import { Stream } from './stream';

export interface SseChatCompatibleOptions {
    streamBuilder?: (
        resp: Response,
        controller: AbortController,
    ) => Stream;
    contentExtractor?: (data: object) => string | null;
    fullContentExtractor?: (data: object) => string | null;
    errorExtractor?: (data: object) => string | null;
}

function fixOpenAICompatibleOptions(
    options: SseChatCompatibleOptions | null,
): SseChatCompatibleOptions {
    options = options || {};

    options.streamBuilder
        = options.streamBuilder
        || function (r, c) {
            return new Stream(r, c);
        };

    options.contentExtractor
        = options.contentExtractor
        || function (d: any) {
            return d?.choices?.at(0)?.delta?.content;
        };

    options.fullContentExtractor
        = options.fullContentExtractor
        || function (d: any) {
            return d?.choices?.at(0)?.message?.content;
        };

    options.errorExtractor
        = options.errorExtractor
        || function (d: any) {
            return d?.error?.message;
        };

    return options;
}

/**
 * Remove internal response markers accidentally leaked by some
 * upstream models or OpenAI-compatible providers.
 *
 * The marker must appear as a standalone value at the end of the
 * response, so normal words inside the reply will not be affected.
 */
function cleanTrailingInternalMarker(
    text: string,
): string {
    const markerPattern
        = /(^|[\r\n\t ])(?:censored_response|censored_respons)(?:[.!。！])?[\r\n\t ]*$/i;

    const match = text.match(markerPattern);

    if (
        !match
        || match.index === undefined
    ) {
        return text;
    }

    /*
     * Preserve the character before the marker only when it is not
     * whitespace. At present the allowed boundary is whitespace, but
     * this keeps the function safe if the pattern is expanded later.
     */
    const boundary = match[1];

    const contentBeforeMarker = text.slice(
        0,
        match.index,
    );

    return (
        boundary.trim().length > 0
            ? `${contentBeforeMarker}${boundary}`
            : contentBeforeMarker
    ).trimEnd();
}

function cleanReasoningText(text: string): string {
    let cleaned = text
        .replace(
            /<mm:think>[\s\S]*?<\/mm:think>/gi,
            '',
        )
        .replace(
            /<think>[\s\S]*?<\/think>/gi,
            '',
        );

    const lower = cleaned.toLowerCase();

    const mmThinkIndex = lower.indexOf(
        '<mm:think>',
    );

    const thinkIndex = lower.indexOf(
        '<think>',
    );

    const unmatchedOpeningIndexes = [
        mmThinkIndex,
        thinkIndex,
    ].filter(index => index !== -1);

    if (unmatchedOpeningIndexes.length > 0) {
        const firstOpeningIndex = Math.min(
            ...unmatchedOpeningIndexes,
        );

        cleaned = cleaned.slice(
            0,
            firstOpeningIndex,
        );
    }

    cleaned = cleaned
        .replace(
            /<\/?(?:mm:)?think>/gi,
            '',
        )
        .trimStart();

    return cleanTrailingInternalMarker(
        cleaned,
    );
}

export function isJsonResponse(
    resp: Response,
): boolean {
    const contentType = resp.headers.get(
        'content-type',
    );

    return (
        contentType
            ?.toLowerCase()
            .includes('application/json')
        ?? false
    );
}

export function isEventStreamResponse(
    resp: Response,
): boolean {
    const types = [
        'application/stream+json',
        'text/event-stream',
    ];

    const content = resp.headers
        .get('content-type')
        ?.toLowerCase()
        || '';

    for (const type of types) {
        if (content.includes(type)) {
            return true;
        }
    }

    return false;
}

export async function streamHandler<T>(
    stream: AsyncIterable<T>,
    contentExtractor: (data: T) => string | null,
    onStream?: (text: string) => Promise<any>,
): Promise<string> {
    let contentFull = '';
    let visibleContentFull = '';
    let lengthDelta = 0;
    let updateStep = 50;
    let lastUpdateTime = Date.now();

    try {
        for await (const part of stream) {
            const textPart = contentExtractor(
                part,
            );

            if (!textPart) {
                continue;
            }

            contentFull += textPart;

            const nextVisibleContent
                = cleanReasoningText(
                    contentFull,
                );

            const visibleLengthDelta = Math.max(
                0,
                nextVisibleContent.length
                - visibleContentFull.length,
            );

            visibleContentFull
                = nextVisibleContent;

            lengthDelta += visibleLengthDelta;

            if (
                visibleContentFull.length > 0
                && lengthDelta > updateStep
            ) {
                if (
                    ENV.TELEGRAM_MIN_STREAM_INTERVAL
                    > 0
                ) {
                    const delta
                        = Date.now()
                        - lastUpdateTime;

                    if (
                        delta
                        < ENV.TELEGRAM_MIN_STREAM_INTERVAL
                    ) {
                        continue;
                    }

                    lastUpdateTime = Date.now();
                }

                lengthDelta = 0;
                updateStep += 20;

                await onStream?.(
                    `${visibleContentFull}\n...`,
                );
            }
        }
    } catch (e) {
        contentFull += `\nError: ${
            (e as Error).message
        }`;
    }

    return cleanReasoningText(
        contentFull,
    );
}

export async function mapResponseToAnswer(
    resp: Response,
    controller: AbortController,
    options: SseChatCompatibleOptions | null,
    onStream:
        ((text: string) => Promise<any>)
        | null,
): Promise<string> {
    options = fixOpenAICompatibleOptions(
        options || null,
    );

    if (
        onStream
        && resp.ok
        && isEventStreamResponse(resp)
    ) {
        const stream = options.streamBuilder?.(
            resp,
            controller
            || new AbortController(),
        );

        if (!stream) {
            throw new Error(
                'Stream builder error',
            );
        }

        return streamHandler<object>(
            stream,
            options.contentExtractor!,
            onStream,
        );
    }

    if (!isJsonResponse(resp)) {
        throw new Error(
            resp.statusText,
        );
    }

    const result = await resp.json() as any;

    if (!result) {
        throw new Error(
            'Empty response',
        );
    }

    if (
        options.errorExtractor?.(
            result,
        )
    ) {
        throw new Error(
            options.errorExtractor?.(
                result,
            )
            || 'Unknown error',
        );
    }

    return cleanReasoningText(
        options.fullContentExtractor?.(
            result,
        )
        || '',
    );
}

export async function requestChatCompletions(
    url: string,
    header: Record<string, string>,
    body: any,
    onStream: ChatStreamTextHandler | null,
    options: SseChatCompatibleOptions | null,
): Promise<string> {
    const controller
        = new AbortController();

    const { signal } = controller;

    let timeoutID = null;

    if (
        ENV.CHAT_COMPLETE_API_TIMEOUT
        > 0
    ) {
        timeoutID = setTimeout(
            () => controller.abort(),
            ENV.CHAT_COMPLETE_API_TIMEOUT,
        );
    }

    const resp = await fetch(
        url,
        {
            method: 'POST',
            headers: header,
            body: JSON.stringify(body),
            signal,
        },
    );

    if (timeoutID) {
        clearTimeout(timeoutID);
    }

    return await mapResponseToAnswer(
        resp,
        controller,
        options,
        onStream,
    );
}