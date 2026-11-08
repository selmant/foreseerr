import type { AiRecommendRequest } from '@shared/interfaces/api/aiInterfaces';

/** Structured AI slider data. Legacy sliders store their prompt directly. */
export interface AiSliderConfig {
  version: 1;
  request: AiRecommendRequest;
  initialRunId?: number;
  savedAt?: string;
}

export const parseAiSlider = (data?: string): AiSliderConfig => {
  try {
    const value = JSON.parse(data ?? '');
    if (
      value?.version === 1 &&
      value.request &&
      typeof value.request === 'object'
    ) {
      return value as AiSliderConfig;
    }
  } catch {
    // Plain prompts predate structured AI sliders.
  }
  return { version: 1, request: { prompt: data ?? '' } };
};

/** Editing a title keeps the initial cache; changing the prompt invalidates it. */
export const editAiSliderPrompt = (
  data: string | undefined,
  prompt: string
): string => {
  const config = parseAiSlider(data);
  if ((config.request.prompt ?? '') === prompt) return data ?? '';
  return JSON.stringify({ version: 1, request: { ...config.request, prompt } });
};
