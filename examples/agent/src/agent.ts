import { chat, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { stream, type ConnectionAdapter } from "@tanstack/ai-client";

export function createInProcessAdapter(apiKey: string): ConnectionAdapter {
  // @ts-expect-error - Model is not in the list of expected models yet
  const textAdapter = createOpenRouterText("moonshotai/kimi-k2.5", apiKey);

  return stream((messages: ModelMessage[]) => {
    const chatStream = chat({
      adapter: textAdapter,
      // @ts-expect-error - ModelMessage is compatible at runtime; strict multimodal typing causes mismatch
      messages,
      systemPrompts: [
        "You are a helpful AI assistant. Be concise and helpful in your responses.",
      ],
      agentLoopStrategy: ({ iterationCount }) => iterationCount < 20,
    });

    return chatStream as AsyncIterable<StreamChunk>;
  });
}
