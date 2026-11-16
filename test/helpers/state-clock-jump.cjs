// Advance only the state owner's wall clock; the synthetic running executor keeps its real clock.
if (process.argv[2] === 'serve') require('./clock-jump.cjs');
