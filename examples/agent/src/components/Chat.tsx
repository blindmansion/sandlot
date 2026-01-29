import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useChat } from "@tanstack/ai-react";
import type { ConnectionAdapter } from "@tanstack/ai-client";
import type { Sandbox } from "sandlot";
import { createInProcessAdapter } from "../agent";
import "./Chat.css";

/**
 * Inner chat component that only renders when connection is ready.
 * This avoids calling useChat with a null connection.
 */
function ChatInner({ connection }: { connection: ConnectionAdapter }) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, isLoading, error } = useChat({ connection });

  // Auto-scroll behavior
  const messagesRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Check if scrolled to bottom (within threshold)
  const checkIfAtBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return true;
    const threshold = 50; // pixels from bottom to consider "at bottom"
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Handle scroll events to track if user is at bottom
  const handleScroll = useCallback(() => {
    isAtBottomRef.current = checkIfAtBottom();
  }, [checkIfAtBottom]);

  // Auto-scroll to bottom when messages change (if we're tracking bottom)
  useEffect(() => {
    const el = messagesRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const handleSubmit = (e: React.SubmitEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      sendMessage(input);
      setInput("");
      // Re-enable auto-scroll when user sends a message
      isAtBottomRef.current = true;
    }
  };

  return (
    <>
      <div className="chat-messages" ref={messagesRef} onScroll={handleScroll}>
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <div className="message-content">
              {message.parts.map((part, idx) => {
                if (part.type === "thinking") {
                  return (
                    <div key={idx} className="thinking-part">
                      {part.content}
                    </div>
                  );
                }
                if (part.type === "text") {
                  return <span key={idx}>{part.content}</span>;
                }
                if (part.type === "tool-call") {
                  const isRunning =
                    part.state === "awaiting-input" ||
                    part.state === "input-streaming";
                  const isComplete = part.state === "input-complete";
                  return (
                    <div key={idx} className="tool-call-part">
                      <strong>{part.name}</strong>
                      {isRunning && " (running...)"}
                      {isComplete && part.output != null && (
                        <pre>{JSON.stringify(part.output, null, 2)}</pre>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-message assistant">
            <div className="message-content loading">Thinking...</div>
          </div>
        )}
        {error && (
          <div className="chat-message error">
            <div className="message-content">Error: {error.message}</div>
          </div>
        )}
      </div>
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={isLoading}
        />
        <button className="chat-submit" type="submit" disabled={isLoading}>
          Send
        </button>
      </form>
    </>
  );
}

interface ChatProps {
  sandbox: Sandbox | null;
  sandboxError: string | null;
}

/**
 * Chat component that receives sandbox from parent.
 * Shows chat UI once sandbox is ready.
 */
export function Chat({ sandbox, sandboxError }: ChatProps) {
  // Create adapter once sandbox is ready
  const connection = useMemo(() => {
    if (!sandbox) return null;
    return createInProcessAdapter(
      import.meta.env.VITE_OPENROUTER_API_KEY ?? "",
      sandbox,
    );
  }, [sandbox]);

  // Show sandbox initialization error
  if (sandboxError) {
    return (
      <div className="chat-container">
        <div className="chat-message error">
          <div className="message-content">
            Failed to initialize sandbox: {sandboxError}
          </div>
        </div>
      </div>
    );
  }

  // Show loading state while sandbox initializes
  if (!connection) {
    return (
      <div className="chat-container">
        <div className="chat-messages">
          <div className="chat-message system">
            <div className="message-content loading">
              Initializing sandbox...
            </div>
          </div>
        </div>
        <form className="chat-input-form">
          <input
            className="chat-input"
            placeholder="Initializing..."
            disabled
          />
          <button className="chat-submit" type="submit" disabled>
            Send
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="chat-container">
      <ChatInner connection={connection} />
    </div>
  );
}
