/** Public surface of `@naikan/incident-machine`. */
export type { MachineInput, OpenState, RunPoint, Transition } from "./types.ts";
export { evaluateIncident, replayIncidents, SUCCESSES_TO_CLOSE } from "./machine.ts";
