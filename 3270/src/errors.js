// Every error site has its own code; never renumber.
//   N1xxx connection and network
//   N2xxx host data stream (logged, the session carries on like x3270 does)
//   N3xxx keyboard and actions
//   N9xxx configuration

export class NodeError extends Error {
  /** @param {string} code @param {string} message @param {unknown} [cause] */
  constructor(code, message, cause) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.code = code;
  }
}
