import React from "react";
import ReactDOM from "react-dom/client";

import "./index.css";

import { RouterProvider } from "@tanstack/react-router";
import { createOpenbotRouter } from "./router";
import { bootstrapAuth } from "./auth";
import { PairingGate } from "./components/PairingGate";
import { AppAtomRegistryProvider } from "./connection/atomRuntime";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Resolve the session before mounting the connection runtime so the first
// WebSocket upgrade already carries the cookie instead of failing once.
void bootstrapAuth().then((gate) => {
  root.render(
    <React.StrictMode>
      {gate.status === "authenticated" ? (
        <AppAtomRegistryProvider>
          <RouterProvider router={createOpenbotRouter()} />
        </AppAtomRegistryProvider>
      ) : (
        <PairingGate errorMessage={gate.errorMessage} />
      )}
    </React.StrictMode>,
  );
});
