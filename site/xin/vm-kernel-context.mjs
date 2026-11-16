// Per-call context. An async public operation may wait while another operation reports back.
// Never change process.argv or the runner environment on the shared state process.
import { AsyncLocalStorage } from 'node:async_hooks';
const calls = new AsyncLocalStorage();
export const callContext = () => calls.getStore() || {
  locked: process.argv[2] === 'locked', key: process.env.XIN_LOCK || null, run: process.env.XIN_RUN || null, attempt: process.env.XIN_ATTEMPT || null
};
export const withCallContext = (context, fn) => calls.run(context, fn);
export const lockHeld = key => callContext().locked && callContext().key === key;
