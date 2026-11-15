import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { httpWorkspaceApi } from "./api";
import "./styles.css";

const root = document.querySelector("#app");
if (!root) throw new Error("workspace UI root element is missing");

createRoot(root).render(
  <StrictMode>
    <App api={httpWorkspaceApi} />
  </StrictMode>,
);
