import { z } from "zod";
import type { LlmProvider, LlmStructuredRequest, LlmStructuredResult, LlmTextRequest, LlmTextResult } from "./types.js";

export interface LlmProviderAttemptTrace {
  provider: string;
  mode: "structured" | "text";
  success: boolean;
  failureCode?: string;
  failureClass?: string;
  failureMessage?: string;
}

export interface RoutedStructuredResult<T> extends LlmStructuredResult<T> {
  providerAttempts: LlmProviderAttemptTrace[];
  providerUsed?: string;
}

export interface RoutedTextResult extends LlmTextResult {
  providerAttempts: LlmProviderAttemptTrace[];
  providerUsed?: string;
}

function shouldTryNextProvider(result: { failureClass?: string; failureCode?: string }): boolean {
  if (!result.failureClass && !result.failureCode) {
    return false;
  }
  if (result.failureClass === "policy_block") {
    return false;
  }
  return result.failureClass === "network" || result.failureClass === "timeout" || result.failureCode === "network_error";
}

function orderProviders(providers: LlmProvider[], preferredProvider?: string): LlmProvider[] {
  if (!preferredProvider) {
    return [...providers];
  }
  const preferred = providers.find((provider) => provider.name === preferredProvider);
  if (!preferred) {
    return [...providers];
  }
  const remainder = providers.filter((provider) => provider.name !== preferredProvider);
  return [preferred, ...remainder];
}

export async function runStructuredWithFallback<T>(args: {
  providers: LlmProvider[];
  request: LlmStructuredRequest;
  validator: z.ZodType<T>;
  preferredProvider?: string;
}): Promise<RoutedStructuredResult<T>> {
  const ordered = orderProviders(args.providers, args.preferredProvider);
  if (ordered.length === 0) {
    return {
      provider: "none",
      failureCode: "missing_provider",
      failureClass: "policy_block",
      failureMessage: "No LLM provider is configured",
      providerAttempts: []
    };
  }

  const providerAttempts: LlmProviderAttemptTrace[] = [];
  let lastFailure: RoutedStructuredResult<T> | null = null;
  for (const provider of ordered) {
    const result = await provider.generateStructured(args.request, args.validator);
    providerAttempts.push({
      provider: provider.name,
      mode: "structured",
      success: Boolean(result.result),
      failureCode: result.failureCode,
      failureClass: result.failureClass,
      failureMessage: result.failureMessage
    });
    if (result.result) {
      return {
        ...result,
        providerAttempts,
        providerUsed: provider.name
      };
    }
    lastFailure = {
      ...result,
      providerAttempts
    };
    if (!shouldTryNextProvider(result)) {
      break;
    }
  }

  if (lastFailure) {
    return lastFailure;
  }
  return {
    provider: ordered[ordered.length - 1]?.name ?? "none",
    failureCode: "unknown",
    failureClass: "unknown",
    failureMessage: "Structured generation failed",
    providerAttempts
  };
}

export async function runTextWithFallback(args: {
  providers: LlmProvider[];
  request: LlmTextRequest;
  preferredProvider?: string;
}): Promise<RoutedTextResult> {
  const ordered = orderProviders(args.providers, args.preferredProvider);
  if (ordered.length === 0) {
    return {
      provider: "none",
      failureCode: "missing_provider",
      failureClass: "policy_block",
      failureMessage: "No LLM provider is configured",
      providerAttempts: []
    };
  }

  const providerAttempts: LlmProviderAttemptTrace[] = [];
  let lastFailure: RoutedTextResult | null = null;
  for (const provider of ordered) {
    const result = await provider.generateText(args.request);
    providerAttempts.push({
      provider: provider.name,
      mode: "text",
      success: Boolean(result.content),
      failureCode: result.failureCode,
      failureClass: result.failureClass,
      failureMessage: result.failureMessage
    });
    if (result.content) {
      return {
        ...result,
        providerAttempts,
        providerUsed: provider.name
      };
    }
    lastFailure = {
      ...result,
      providerAttempts
    };
    if (!shouldTryNextProvider(result)) {
      break;
    }
  }

  if (lastFailure) {
    return lastFailure;
  }
  return {
    provider: ordered[ordered.length - 1]?.name ?? "none",
    failureCode: "unknown",
    failureClass: "unknown",
    failureMessage: "Text generation failed",
    providerAttempts
  };
}
