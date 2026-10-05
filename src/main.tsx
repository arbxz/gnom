import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isNative } from "./lib/api";
import { installCursorLight } from "./lib/cursorLight";
import "./styles.css";

if (isNative) document.documentElement.setAttribute("data-native", "");
// The desktop app has no browser chrome; block the stock context menu outside text fields.
if (isNative) document.addEventListener("contextmenu", (e) => (e.target as HTMLElement).closest("input, textarea, pre") || e.preventDefault());

installCursorLight();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
