import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import { registerSharedModules } from "sandlot";
import "./index.css";
import App from "./App.tsx";

// Register React as a shared module so sandboxed code can use the host's React
registerSharedModules({
  react: React,
  "react-dom/client": ReactDOM,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
