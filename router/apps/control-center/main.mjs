// Compatibility entry point for older development commands. The package and
// distributables use electron/main.mjs; keeping this file as a one-line shim
// prevents a second copy of the privileged Electron bootstrap from drifting.
import "./electron/main.mjs";
