/**
 * Control-plane text generation abstraction.
 *
 * API-backed models delegate to the AI SDK. CLI-backed models run host-side
 * through the safe CLI runner and intentionally report token accounting as
 * unavailable when the CLI does not expose it.
 */

import type { LanguageModel, ModelMessage, SystemModelMessage } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { generateText } from 'ai';
import type { ResolvedUserConfig } from '../config/user-config.js';
import { createLanguageModel } from '../config/model-provider.js';
import { parseCliLlmModelId, type CliLlmBackendId } from './model-spec.js';
import { resolveCliBackendConfig, runCliLlmCall } from './cli-backend.js';

export type TextGenerationMessage = { readonly role: 'user' | 'assistant'; readonly content: string };

export interface TextGenerationResult {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly tokenTrackingAvailable: boolean;
}

export interface TextGenerationOptions {
  readonly system?: string | SystemModelMessage;
  readonly messages?: readonly TextGenerationMessage[] | readonly ModelMessage[];
  readonly prompt?: string;
  readonly maxOutputTokens?: number;
  readonly abortSignal?: AbortSignal;
  readonly maxRetries?: number;
}

export interface ApiTextGenerationModel {
  readonly kind: 'api';
  readonly modelId: string;
  readonly supportsToolCalling: true;
  readonly languageModel: LanguageModelV3;
  readonly callLimiter?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface CliTextGenerationModel {
  readonly kind: 'cli';
  readonly modelId: string;
  readonly supportsToolCalling: false;
  readonly backend: CliLlmBackendId;
  readonly cliModelId?: string;
  readonly userConfig: ResolvedUserConfig;
  readonly callLimiter?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type TextGenerationModel = ApiTextGenerationModel | CliTextGenerationModel;
export type TextGenerationModelLike = TextGenerationModel | LanguageModelV3;

export function isTextGenerationModel(value: unknown): value is TextGenerationModel {
  if (!value || typeof value !== 'object') return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === 'api' || kind === 'cli';
}

export async function createTextGenerationModel(
  modelId: string,
  userConfig: ResolvedUserConfig,
): Promise<TextGenerationModel> {
  const cliSpec = parseCliLlmModelId(modelId);
  if (cliSpec) {
    return {
      kind: 'cli',
      modelId,
      supportsToolCalling: false,
      backend: cliSpec.backend,
      cliModelId: cliSpec.modelId,
      userConfig,
    };
  }

  return {
    kind: 'api',
    modelId,
    supportsToolCalling: true,
    languageModel: await createLanguageModel(modelId, userConfig),
  };
}

export async function generateTextWithModel(
  model: TextGenerationModelLike,
  options: TextGenerationOptions,
): Promise<TextGenerationResult> {
  if (!isTextGenerationModel(model)) {
    return generateTextWithApiModel(model, options);
  }

  if (model.callLimiter) {
    const unthrottled = { ...model, callLimiter: undefined } as TextGenerationModel;
    return model.callLimiter(() => generateTextWithModel(unthrottled, options));
  }

  if (model.kind === 'api') {
    return generateTextWithApiModel(model.languageModel, options);
  }

  const cliSpec = parseCliLlmModelId(model.modelId);
  if (!cliSpec) {
    throw new Error(`Invalid CLI LLM model ID: ${model.modelId}`);
  }
  const backendConfig = resolveCliBackendConfig(cliSpec.backend, model.userConfig.cliLlmBackends);
  const result = await runCliLlmCall(cliSpec, backendConfig, {
    prompt: renderPromptForCli(options),
    abortSignal: options.abortSignal,
  });
  return {
    text: result.text,
    usage: result.usage,
    tokenTrackingAvailable: result.usage !== undefined,
  };
}

async function generateTextWithApiModel(
  model: LanguageModelV3,
  options: TextGenerationOptions,
): Promise<TextGenerationResult> {
  const callSettings = {
    model,
    ...(options.system ? { system: options.system } : {}),
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  };
  const result = options.messages
    ? await generateText({
        ...callSettings,
        messages: options.messages as ModelMessage[],
      })
    : await generateText({
        ...callSettings,
        prompt: options.prompt ?? '',
      });
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? undefined,
      outputTokens: result.usage.outputTokens ?? undefined,
      totalTokens: result.usage.totalTokens ?? undefined,
    },
    tokenTrackingAvailable: true,
  };
}

export function requireApiLanguageModel(model: TextGenerationModel, featureName: string): LanguageModel {
  if (model.kind === 'api') return model.languageModel;
  throw new Error(
    `${featureName} requires AI SDK tool-calling, but "${model.modelId}" is a CLI LLM backend. ` +
      'Use a direct API model for this operation, or run repository-touching work through a Docker CLI agent adapter.',
  );
}

export function renderPromptForCli(options: TextGenerationOptions): string {
  const parts: string[] = [];
  const system = systemToText(options.system);
  if (system) {
    parts.push(`<system>\n${system}\n</system>`);
  }
  if (options.messages) {
    parts.push(
      ...options.messages.map((message) => {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        return `<${role}>\n${messageContentToText(message.content)}\n</${role}>`;
      }),
    );
  }
  if (options.prompt) {
    parts.push(`<user>\n${options.prompt}\n</user>`);
  }
  return parts.join('\n\n');
}

function systemToText(system: string | SystemModelMessage | undefined): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return messageContentToText(system.content);
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as Record<string, unknown>).text;
          return typeof text === 'string' ? text : JSON.stringify(part);
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}
