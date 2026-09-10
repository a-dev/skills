#!/usr/bin/env node

import { rmSync } from "node:fs";
import process from "node:process";

import { startReferenceServer } from "../browser-tests/reference-server.mjs";

const running = await startReferenceServer({ port: 4173 });

process.on("exit", () => {
  rmSync(running.temporaryRoot, { recursive: true, force: true });
});

async function close() {
  // Remove the disposable copy before awaiting Vite shutdown. Playwright may
  // terminate the web-server process shortly after the signal arrives.
  rmSync(running.temporaryRoot, { recursive: true, force: true });
  await running.close();
  process.exit(0);
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
