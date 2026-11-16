import type { AiErrorBody } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';

/**
 * The `{message, code}` body the AI routes answer errors with, or a generic
 * one for transport failures and other routes.
 */
export const aiErrorOf = (error: unknown, fallback: string): AiErrorBody => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as Partial<AiErrorBody> | undefined;
    if (data && typeof data.message === 'string' && data.code) {
      return {
        message: data.message,
        code: data.code,
        manageUsageUrl: data.manageUsageUrl,
      };
    }
  }
  return { message: fallback, code: 'internal' };
};
