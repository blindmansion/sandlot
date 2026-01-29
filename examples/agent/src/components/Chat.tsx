import { useState, useMemo } from "react";
import { useChat } from "@tanstack/ai-react";
import { createInProcessAdapter } from "../agent";
import "./Chat.css";

export function Chat() {
  const [input, setInput] = useState("");

  const connection = useMemo(
    () => createInProcessAdapter(import.meta.env.VITE_OPENROUTER_API_KEY ?? ""),
    [],
  );

  const { messages, sendMessage, isLoading, error } = useChat({
    connection,
  });

  const handleSubmit = (e: React.SubmitEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      sendMessage(input);
      setInput("");
    }
  };

  return (
    <div className="chat-container">
      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <div className="message-role">{message.role}</div>
            <div className="message-content">
              {message.parts.map((part, idx) => {
                if (part.type === "thinking") {
                  return (
                    <div key={idx} className="thinking-part">
                      💭 {part.content}
                    </div>
                  );
                }
                if (part.type === "text") {
                  return <span key={idx}>{part.content}</span>;
                }
                return null;
              })}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="chat-message assistant">
            <div className="message-role">assistant</div>
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
    </div>
  );
}
