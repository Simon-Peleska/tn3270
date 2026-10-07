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
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `[${body.code ?? "E0000"}] ${body.message ?? "could not create a session"}`,
    );
  return body;
}

/** @returns {Promise<{ id: string, startedBy: string, startedAt: string }[]>} */
export async function listSessions() {
  const response = await fetch("./api/sessions");
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      `[${body.code ?? "E0000"}] ${body.message ?? "session list failed"}`,
    );
  return body.sessions;
}

/** @param {string} id @param {string} pass @returns {Promise<void>} */
export async function terminateSession(id, pass) {
  const response = await fetch(`./api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "x-session-pass": pass },
  });
  if (response.ok) return;
  const body = await response.json();
  throw new Error(
    `[${body.code ?? "E0000"}] ${body.message ?? "session termination failed"}`,
  );
}

/** @returns {Promise<Set<string> | null>} null when the server did not answer */
export async function liveSessionIds() {
  try {
    const sessions = await listSessions();
    return new Set(sessions.map((session) => session.id));
  } catch {
    return null;
  }
}
