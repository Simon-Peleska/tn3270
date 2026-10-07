import { responseError } from "./store.js";

/**
 * @param {{ model?: number, oversize?: string }} [size] what to start at
 * @returns {Promise<{ id: string, rows: number, cols: number }>}
 */
export async function createSessionRequest(size = {}) {
  const response = await fetch("./api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(size),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

/** @returns {Promise<{ id: string, startedBy: string, startedAt: string }[]>} */
export async function listSessions() {
  const response = await fetch("./api/sessions");
  if (!response.ok) throw await responseError(response);
  return (await response.json()).sessions;
}

/** @param {string} id @param {string} pass @returns {Promise<void>} */
export async function terminateSession(id, pass) {
  const response = await fetch(`./api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-session-pass": pass },
  });
  if (!response.ok) throw await responseError(response);
}
