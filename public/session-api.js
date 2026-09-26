/** @returns {Promise<{ id: string, rows: number, cols: number }>} */
export async function createSessionRequest() {
  const response = await fetch("./api/sessions", { method: "POST" });
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

/** @returns {Promise<Set<string> | null>} null when the server did not answer */
export async function liveSessionIds() {
  try {
    const sessions = await listSessions();
    return new Set(sessions.map((session) => session.id));
  } catch {
    return null;
  }
}
